import { debugLog } from './config';

export type ChatGptComposer = HTMLTextAreaElement | HTMLElement;

const composerSelectors = [
  '#prompt-textarea',
  'textarea[placeholder*="Message" i]',
  '[contenteditable="true"][role="textbox"]',
  'div[contenteditable="true"]',
];

const sendButtonSelectors = [
  'button[data-testid="send-button"]',
  'button[aria-label*="Send" i]',
  'button[data-testid*="send" i]',
];

export function isChatGptPage(locationLike: Pick<Location, 'hostname'> = window.location): boolean {
  return locationLike.hostname === 'chatgpt.com' || locationLike.hostname === 'chat.openai.com';
}

function isUsableComposer(element: Element): element is ChatGptComposer {
  if (!(element instanceof HTMLElement) || !element.isConnected) {
    return false;
  }

  if (element instanceof HTMLTextAreaElement) {
    return !element.disabled;
  }

  return element.getAttribute('contenteditable') === 'true';
}

export function findComposer(documentRoot: Document = document): ChatGptComposer | null {
  for (const selector of composerSelectors) {
    const candidates = documentRoot.querySelectorAll(selector);

    for (const candidate of candidates) {
      if (isUsableComposer(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

export function readComposerText(composer: ChatGptComposer): string {
  if (composer instanceof HTMLTextAreaElement) {
    return composer.value;
  }

  return composer.innerText || composer.textContent || '';
}

function setNativeTextareaValue(textarea: HTMLTextAreaElement, text: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    'value',
  )?.set;

  if (valueSetter) {
    valueSetter.call(textarea, text);
  } else {
    textarea.value = text;
  }

  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
}

function replaceContentEditableText(composer: HTMLElement, text: string): void {
  composer.focus();

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(composer);
  selection?.removeAllRanges();
  selection?.addRange(range);

  // execCommand remains the most compatible way to update contenteditable editors while
  // notifying their internal input model. The direct DOM fallback still emits an input event.
  const inserted = document.execCommand?.('insertText', false, text) ?? false;

  if (!inserted) {
    composer.replaceChildren(document.createTextNode(text));
    composer.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }),
    );
  }

  selection?.removeAllRanges();
}

export function replaceComposerText(composer: ChatGptComposer, text: string): void {
  if (composer instanceof HTMLTextAreaElement) {
    setNativeTextareaValue(composer, text);
    composer.focus();
    return;
  }

  replaceContentEditableText(composer, text);
}

export function findSendButton(
  composer: ChatGptComposer,
  documentRoot: Document = document,
): HTMLButtonElement | null {
  const form = composer.closest('form');

  for (const selector of sendButtonSelectors) {
    const localButton = form?.querySelector<HTMLButtonElement>(selector);
    if (localButton) {
      return localButton;
    }

    const documentButton = documentRoot.querySelector<HTMLButtonElement>(selector);
    if (documentButton) {
      return documentButton;
    }
  }

  return form?.querySelector<HTMLButtonElement>('button[type="submit"]') ?? null;
}

export function isSendButtonEvent(event: MouseEvent, composer: ChatGptComposer): boolean {
  const target = event.target;
  if (!(target instanceof Element)) {
    return false;
  }

  const clickedButton = target.closest('button');
  return clickedButton !== null && clickedButton === findSendButton(composer);
}

export function isEnterSubmission(event: KeyboardEvent, composer: ChatGptComposer): boolean {
  if (
    event.key !== 'Enter' ||
    event.shiftKey ||
    event.isComposing ||
    event.defaultPrevented ||
    event.altKey
  ) {
    return false;
  }

  const target = event.target;
  return target instanceof Node && (target === composer || composer.contains(target));
}

export function getStatusMount(composer: ChatGptComposer): HTMLElement {
  return composer.closest('form') ?? composer.parentElement ?? document.body;
}

export function resumeChatGptSubmission(composer: ChatGptComposer): boolean {
  const sendButton = findSendButton(composer);

  if (!sendButton || sendButton.disabled || sendButton.getAttribute('aria-disabled') === 'true') {
    debugLog('ChatGPT', 'Send control unavailable while resuming submission');
    composer.focus();
    return false;
  }

  sendButton.click();
  return true;
}

export function findChatGptFileInput(
  documentRoot: Document = document,
  composer?: ChatGptComposer,
): HTMLInputElement | null {
  if (composer) {
    const scope = composer.closest('form') ?? composer.parentElement;
    return scope?.querySelector<HTMLInputElement>('input[type="file"]') ?? null;
  }
  return documentRoot.querySelector<HTMLInputElement>('input[type="file"]');
}
