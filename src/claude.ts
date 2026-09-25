import { debugLog } from './config';
import { replaceContentEditableText } from './contenteditable';

export type ClaudeComposer = HTMLTextAreaElement | HTMLElement;

const composerSelectors = [
  '[data-testid="chat-input"][contenteditable="true"]',
  'div.ProseMirror[contenteditable="true"]',
  '[contenteditable="true"][role="textbox"]',
  'textarea[placeholder*="Claude" i]',
];

const sendButtonSelectors = [
  'button[data-testid*="send" i]',
  'button[aria-label*="Send" i]',
  'button[type="submit"]',
];

export function isClaudePage(locationLike: Pick<Location, 'hostname'> = window.location): boolean {
  return locationLike.hostname === 'claude.ai';
}

function isUsableComposer(element: Element): element is ClaudeComposer {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  if (element instanceof HTMLTextAreaElement) return !element.disabled;
  return element.getAttribute('contenteditable') === 'true';
}

export function findClaudeComposer(documentRoot: Document = document): ClaudeComposer | null {
  for (const selector of composerSelectors) {
    for (const candidate of documentRoot.querySelectorAll(selector)) {
      if (isUsableComposer(candidate)) return candidate;
    }
  }
  return null;
}

export function readClaudeComposerText(composer: ClaudeComposer): string {
  return composer instanceof HTMLTextAreaElement
    ? composer.value
    : composer.innerText || composer.textContent || '';
}

export function replaceClaudeComposerText(composer: ClaudeComposer, text: string): void {
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

export function findClaudeSendButton(
  composer: ClaudeComposer,
  documentRoot: Document = document,
): HTMLButtonElement | null {
  const form = composer.closest('form');
  for (const selector of sendButtonSelectors) {
    const local = form?.querySelector<HTMLButtonElement>(selector);
    if (local) return local;
    const page = documentRoot.querySelector<HTMLButtonElement>(selector);
    if (page) return page;
  }
  return null;
}

export function isClaudeSendButtonEvent(event: MouseEvent, composer: ClaudeComposer): boolean {
  const target = event.target;
  return target instanceof Element && target.closest('button') === findClaudeSendButton(composer);
}

export function isClaudeEnterSubmission(event: KeyboardEvent, composer: ClaudeComposer): boolean {
  const target = event.target;
  return event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing &&
    !event.defaultPrevented && target instanceof Node &&
    (target === composer || composer.contains(target));
}

export function getClaudeStatusMount(composer: ClaudeComposer): HTMLElement {
  return composer.closest('form') ?? composer.parentElement ?? document.body;
}

export function resumeClaudeSubmission(composer: ClaudeComposer): boolean {
  const button = findClaudeSendButton(composer);
  if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') {
    debugLog('Claude', 'Send control unavailable while resuming submission');
    composer.focus();
    return false;
  }
  button.click();
  return true;
}

export function findClaudeFileInput(
  documentRoot: Document = document,
  composer?: ClaudeComposer,
): HTMLInputElement | null {
  if (composer) {
    let scope: HTMLElement | null = composer.closest('form') ?? composer.parentElement;
    for (let depth = 0; scope && scope !== documentRoot.body && depth < 5; depth += 1) {
      const local = scope.querySelector<HTMLInputElement>('input[type="file"]:not(:disabled)');
      if (local) return local;
      scope = scope.parentElement;
    }

    const candidates = Array.from(
      documentRoot.querySelectorAll<HTMLInputElement>('input[type="file"]:not(:disabled)'),
    );
    return candidates.find((input) => {
      const descriptor = [
        input.id,
        input.name,
        input.accept,
        input.getAttribute('aria-label') ?? '',
        input.getAttribute('data-testid') ?? '',
      ].join(' ');
      return input.multiple || /attach|upload|document|composer|prompt|pdf|docx/i.test(descriptor);
    }) ?? null;
  }
  return documentRoot.querySelector<HTMLInputElement>('input[type="file"]:not(:disabled)');
}
