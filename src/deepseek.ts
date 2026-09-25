import { debugLog } from './config';
import { replaceContentEditableText } from './contenteditable';

export type DeepSeekComposer = HTMLTextAreaElement | HTMLElement;

const composerSelectors = [
  '#chat-input',
  'textarea[placeholder*="message" i]',
  'textarea[placeholder*="DeepSeek" i]',
  '[contenteditable="true"][role="textbox"]',
];

const sendButtonSelectors = [
  'button[aria-label*="Send" i]',
  '[role="button"][aria-label*="Send" i]',
  'button[type="submit"]',
];

export function isDeepSeekPage(locationLike: Pick<Location, 'hostname'> = window.location): boolean {
  return locationLike.hostname === 'chat.deepseek.com';
}

function usable(element: Element): element is DeepSeekComposer {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  return element instanceof HTMLTextAreaElement
    ? !element.disabled
    : element.getAttribute('contenteditable') === 'true';
}

export function findDeepSeekComposer(documentRoot: Document = document): DeepSeekComposer | null {
  for (const selector of composerSelectors) {
    for (const candidate of documentRoot.querySelectorAll(selector)) {
      if (usable(candidate)) return candidate;
    }
  }
  return null;
}

export function readDeepSeekComposerText(composer: DeepSeekComposer): string {
  return composer instanceof HTMLTextAreaElement
    ? composer.value
    : composer.innerText || composer.textContent || '';
}

export function replaceDeepSeekComposerText(composer: DeepSeekComposer, text: string): void {
  composer.focus();
  if (composer instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(composer, text);
    else composer.value = text;
  } else {
    replaceContentEditableText(composer, text);
    return;
  }
  composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
}

export function findDeepSeekSendButton(
  composer: DeepSeekComposer,
  documentRoot: Document = document,
): HTMLElement | null {
  for (const selector of sendButtonSelectors) {
    const local = composer.closest('form')?.querySelector<HTMLElement>(selector);
    if (local) return local;
    const page = documentRoot.querySelector<HTMLElement>(selector);
    if (page) return page;
  }
  return null;
}

export function isDeepSeekSendButtonEvent(event: MouseEvent, composer: DeepSeekComposer): boolean {
  const target = event.target;
  return target instanceof Element &&
    target.closest('button,[role="button"]') === findDeepSeekSendButton(composer);
}

export function isDeepSeekEnterSubmission(event: KeyboardEvent, composer: DeepSeekComposer): boolean {
  const target = event.target;
  return event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing &&
    !event.defaultPrevented && target instanceof Node &&
    (target === composer || composer.contains(target));
}

export function getDeepSeekStatusMount(composer: DeepSeekComposer): HTMLElement {
  return composer.closest('form') ?? composer.parentElement ?? document.body;
}

export function resumeDeepSeekSubmission(composer: DeepSeekComposer): boolean {
  const button = findDeepSeekSendButton(composer);
  if (!button || button.getAttribute('aria-disabled') === 'true') {
    debugLog('DeepSeek', 'Send control unavailable while resuming submission');
    composer.focus();
    return false;
  }
  button.click();
  return true;
}

export function findDeepSeekFileInput(
  documentRoot: Document = document,
  composer?: DeepSeekComposer,
): HTMLInputElement | null {
  if (composer) {
    const scope = composer.closest('form') ?? composer.parentElement;
    return scope?.querySelector<HTMLInputElement>('input[type="file"]') ?? null;
  }
  return documentRoot.querySelector<HTMLInputElement>('input[type="file"]');
}
