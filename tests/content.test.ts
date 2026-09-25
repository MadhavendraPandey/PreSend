import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  local: { settings: {} } as Record<string, unknown>,
  session: {} as Record<string, unknown>,
  storageChanged: undefined as
    | ((changes: Record<string, unknown>, areaName: string) => unknown)
    | undefined,
  runtimeMessage: undefined as ((message: unknown) => unknown) | undefined,
  fileControlAvailable: false,
}));

const integration = vi.hoisted(() => ({
  id: 'chatgpt' as const,
  name: 'ChatGPT',
  scope: 'ChatGPT',
  findComposer: () => document.querySelector<HTMLElement>('#prompt-textarea'),
  readComposerText: (composer: HTMLElement) => (composer as HTMLTextAreaElement).value,
  replaceComposerText: (composer: HTMLElement, text: string) => {
    (composer as HTMLTextAreaElement).value = text;
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
  },
  findSendButton: () => document.querySelector<HTMLButtonElement>('[data-testid="send-button"]'),
  isSendButtonEvent: (event: MouseEvent) =>
    event.target instanceof Element && event.target.closest('button') ===
      document.querySelector('[data-testid="send-button"]'),
  isEnterSubmission: (event: KeyboardEvent, composer: HTMLElement) =>
    event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.target === composer,
  getStatusMount: (composer: HTMLElement) => composer.closest('form') ?? document.body,
  supportsDynamicFileInput: false,
  hasFileInterceptionControl: () => state.fileControlAvailable,
  resumeSubmission: () => {
    const button = document.querySelector<HTMLButtonElement>('[data-testid="send-button"]');
    if (!button) return false;
    button.click();
    return true;
  },
  findFileInput: () => document.querySelector<HTMLInputElement>('input[type="file"]'),
}));

vi.mock('wxt/utils/define-content-script', () => ({
  defineContentScript: (definition: unknown) => definition,
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      sendMessage: vi.fn(async () => undefined),
      onMessage: {
        addListener: vi.fn((listener: (message: unknown) => unknown) => {
          state.runtimeMessage = listener;
        }),
      },
    },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: state.local[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(state.local, values)),
      },
      session: {
        get: vi.fn(async (key: string) => ({ [key]: state.session[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => Object.assign(state.session, values)),
      },
      onChanged: {
        addListener: vi.fn((
          listener: (changes: Record<string, unknown>, areaName: string) => unknown,
        ) => {
          state.storageChanged = listener;
        }),
      },
    },
  },
}));

vi.mock('../src/sites', () => ({ getSiteIntegration: () => integration }));

import contentScript from '../entrypoints/content';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const readFileText = (file: File): Promise<string> => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error ?? new Error('File read failed'));
  reader.onload = () => resolve(String(reader.result ?? ''));
  reader.readAsText(file);
});

describe('content-script send protection', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    state.local = { settings: { semanticDetection: false } };
    state.session = {};
    state.storageChanged = undefined;
    state.runtimeMessage = undefined;
    state.fileControlAvailable = false;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    class DataTransferMock {
      private readonly selectedFiles: File[] = [];
      readonly items = {
        add: (file: File) => {
          this.selectedFiles.push(file);
          return null;
        },
      };

      get files(): FileList {
        return this.selectedFiles as unknown as FileList;
      }
    }
    vi.stubGlobal('DataTransfer', DataTransferMock);
  });

  it('preserves Shift+Enter, blocks fresh sends, resumes once, and fails open on DOM drift', async () => {
    document.body.innerHTML = `
      <form><textarea id="prompt-textarea"></textarea><input type="file">
      <button type="button" data-testid="send-button"><span>Send</span></button></form>
    `;
    const composer = document.querySelector<HTMLTextAreaElement>('#prompt-textarea')!;
    const sendButton = document.querySelector<HTMLButtonElement>('[data-testid="send-button"]')!;
    const siteSend = vi.fn();
    sendButton.addEventListener('click', siteSend);

    (contentScript as unknown as { main: () => void }).main();
    await flush();
    expect(document.querySelectorAll('[data-presend-ui="status"]')).toHaveLength(0);
    const initialHealthResponse = state.runtimeMessage?.({
      type: 'presend:get-current-integration-health',
    });
    expect(initialHealthResponse).toBeInstanceOf(Promise);
    await expect(initialHealthResponse).resolves.toEqual(expect.objectContaining({
      siteId: 'chatgpt',
      protectionEnabled: true,
      textProtection: 'protected',
      fileProtection: 'protected',
    }));

    const initialFileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    initialFileInput.remove();
    await expect(state.runtimeMessage?.({
      type: 'presend:get-current-integration-health',
    })).resolves.toEqual(expect.objectContaining({
      textProtection: 'protected',
      fileProtection: 'unavailable',
    }));
    integration.supportsDynamicFileInput = true;
    await expect(state.runtimeMessage?.({
      type: 'presend:get-current-integration-health',
    })).resolves.toEqual(expect.objectContaining({
      textProtection: 'protected',
      fileProtection: 'unavailable',
    }));
    state.fileControlAvailable = true;
    await expect(state.runtimeMessage?.({
      type: 'presend:get-current-integration-health',
    })).resolves.toEqual(expect.objectContaining({
      textProtection: 'protected',
      fileProtection: 'protected',
    }));
    state.fileControlAvailable = false;
    integration.supportsDynamicFileInput = false;
    document.querySelector('form')!.append(initialFileInput);

    expect(composer.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', shiftKey: true, bubbles: true, cancelable: true,
    }))).toBe(true);
    expect(document.querySelector('[data-presend-ui="warning"]')).toBeNull();

    composer.value = 'CLIENT_SECRET=live_secret_value_837465';
    composer.dispatchEvent(new Event('paste', { bubbles: true }));
    expect(composer.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }))).toBe(false);
    await flush();

    let warning = document.querySelector<HTMLElement>('[data-presend-ui="warning"]')!;
    warning.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();
    await flush();
    expect(siteSend).not.toHaveBeenCalled();
    expect(composer.value).toContain('live_secret_value_837465');

    expect(sendButton.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true,
    }))).toBe(false);
    composer.value = 'CLIENT_SECRET=changed_while_allowlist_pending_726451';
    await flush();
    expect(document.querySelector('[data-presend-ui="warning"]')).toBeNull();
    expect(siteSend).not.toHaveBeenCalled();
    expect(composer.value).toContain('changed_while_allowlist_pending_726451');

    expect(sendButton.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true,
    }))).toBe(false);
    await flush();
    warning = document.querySelector<HTMLElement>('[data-presend-ui="warning"]')!;
    warning.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="send-anyway"]')?.click();
    await flush();
    expect(siteSend).toHaveBeenCalledOnce();

    const replacementComposer = composer.cloneNode() as HTMLTextAreaElement;
    replacementComposer.value = 'CLIENT_SECRET=second_live_secret_928374';
    composer.replaceWith(replacementComposer);
    await expect(state.runtimeMessage?.({
      type: 'presend:get-current-integration-health',
    })).resolves.toEqual(expect.objectContaining({
      textProtection: 'protected',
    }));
    expect(replacementComposer.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }))).toBe(false);
    await flush();
    warning = document.querySelector<HTMLElement>('[data-presend-ui="warning"]')!;
    const latestComposer = replacementComposer.cloneNode() as HTMLTextAreaElement;
    latestComposer.value = replacementComposer.value;
    replacementComposer.replaceWith(latestComposer);
    warning.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="send-anyway"]')?.click();
    await flush();
    expect(siteSend).toHaveBeenCalledOnce();
    expect(latestComposer.value).toContain('second_live_secret_928374');

    sendButton.remove();
    expect(latestComposer.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }))).toBe(true);
    expect(document.querySelector('[data-presend-ui="warning"]')).toBeNull();

    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const siteUpload = vi.fn();
    fileInput.addEventListener('input', siteUpload);
    let selectedFiles = [new File(['archive bytes'], 'secrets.zip')];
    Object.defineProperty(fileInput, 'files', {
      configurable: true,
      get: () => selectedFiles,
      set: (files: FileList) => {
        selectedFiles = Array.from(files);
      },
    });
    Object.defineProperty(fileInput, 'value', {
      configurable: true,
      get: () => '',
      set: (value: string) => {
        if (value === '') selectedFiles = [];
      },
    });
    expect(fileInput.dispatchEvent(new Event('input', {
      bubbles: true, cancelable: true,
    }))).toBe(false);
    await flush();
    expect(siteUpload).not.toHaveBeenCalled();
    const fileWarning = document.querySelector<HTMLElement>('[data-presend-ui="file-warning"]')!;
    expect(fileWarning.shadowRoot?.textContent).toContain('File contents could not be scanned');
    fileWarning.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();
    await flush();
    expect(siteUpload).not.toHaveBeenCalled();

    const scannedFirst = new File(['ordinary project notes'], 'first.txt');
    const unscannedSecond = new File(
      ['CLIENT_SECRET=second_selection_secret_582930'],
      'second.txt',
    );
    const uploadedNames: string[][] = [];
    siteUpload.mockImplementation(() => {
      uploadedNames.push(selectedFiles.map((file) => file.name));
    });
    selectedFiles = [scannedFirst];
    expect(fileInput.dispatchEvent(new Event('input', {
      bubbles: true, cancelable: true,
    }))).toBe(false);
    selectedFiles = [unscannedSecond];
    expect(fileInput.dispatchEvent(new Event('input', {
      bubbles: true, cancelable: true,
    }))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(siteUpload).toHaveBeenCalledOnce();
    expect(uploadedNames).toEqual([['first.txt']]);

    siteUpload.mockClear();
    const uploadedFiles: File[] = [];
    siteUpload.mockImplementation(() => {
      uploadedFiles.splice(0, uploadedFiles.length, ...selectedFiles);
    });
    const frozenSecret = 'settings_change_secret_739204';
    selectedFiles = [new File([`CLIENT_SECRET=${frozenSecret}`], 'settings.env')];
    expect(fileInput.dispatchEvent(new Event('input', {
      bubbles: true, cancelable: true,
    }))).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const sensitiveFileWarning =
      document.querySelector<HTMLElement>('[data-presend-ui="file-warning"]')!;
    expect(sensitiveFileWarning).not.toBeNull();

    state.local.settings = { detectors: { credentials: false } };
    await state.storageChanged?.({ settings: { newValue: state.local.settings } }, 'local');
    await flush();
    sensitiveFileWarning.shadowRoot
      ?.querySelector<HTMLButtonElement>('[data-action="redact-copy"]')
      ?.click();
    await vi.waitFor(() => expect(siteUpload).toHaveBeenCalledOnce());
    expect(uploadedFiles).toHaveLength(1);
    expect(await readFileText(uploadedFiles[0]!)).not.toContain(frozenSecret);
    await flush();

    const profileInput = document.createElement('input');
    profileInput.type = 'file';
    document.body.append(profileInput);
    Object.defineProperty(profileInput, 'files', {
      configurable: true,
      value: [new File(['avatar bytes'], 'avatar.png')],
    });
    const unrelatedUpload = vi.fn();
    profileInput.addEventListener('input', unrelatedUpload);
    expect(profileInput.dispatchEvent(new Event('input', {
      bubbles: true, cancelable: true,
    }))).toBe(true);
    expect(unrelatedUpload).toHaveBeenCalledOnce();

    const pastedFileEvent = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(pastedFileEvent, 'clipboardData', {
      value: { files: [new File(['image bytes'], 'clipboard.png')] },
    });
    expect(latestComposer.dispatchEvent(pastedFileEvent)).toBe(false);
    const unavailableFileWarning =
      document.querySelector<HTMLElement>('[data-presend-ui="file-warning"]')!;
    expect(unavailableFileWarning.shadowRoot?.textContent).toContain(
      'File protection unavailable on this site',
    );
    expect(
      unavailableFileWarning.shadowRoot?.querySelector('[data-action="upload-original"]'),
    ).toBeNull();
    unavailableFileWarning.shadowRoot
      ?.querySelector<HTMLButtonElement>('[data-action="cancel"]')
      ?.click();
    await flush();

    selectedFiles = Array.from(
      { length: 11 },
      (_, index) => new File([], `empty-${index}.txt`),
    );
    expect(fileInput.dispatchEvent(new Event('input', {
      bubbles: true, cancelable: true,
    }))).toBe(false);
    await flush();
    const limitWarning = document.querySelector<HTMLElement>('[data-presend-ui="file-warning"]')!;
    expect(limitWarning.shadowRoot?.querySelectorAll('.file')).toHaveLength(1);
    expect(limitWarning.shadowRoot?.textContent).toContain('11 selected files');
    limitWarning.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();
    await flush();
  });
});
