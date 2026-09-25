import { debugLog } from './config';
import { replaceContentEditableText } from './contenteditable';

export type GrokComposer = HTMLTextAreaElement | HTMLElement;

const composerSelectors = [
  'textarea[placeholder*="Ask" i]',
  'textarea[aria-label*="message" i]',
  '[contenteditable="true"][role="textbox"]',
];

const sendButtonSelectors = [
  'button[aria-label*="Send" i]',
  'button[data-testid*="send" i]',
  'button[type="submit"]',
];

export function isGrokPage(locationLike: Pick<Location, 'hostname'> = window.location): boolean {
  return locationLike.hostname === 'grok.com';
}

function usable(element: Element): element is GrokComposer {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  return element instanceof HTMLTextAreaElement
    ? !element.disabled
    : element.getAttribute('contenteditable') === 'true';
}

export function findGrokComposer(documentRoot: Document = document): GrokComposer | null {
  for (const selector of composerSelectors) {
    for (const candidate of documentRoot.querySelectorAll(selector)) {
      if (usable(candidate)) return candidate;
    }
  }
  return null;
}

export function readGrokComposerText(composer: GrokComposer): string {
  return composer instanceof HTMLTextAreaElement
    ? composer.value
    : composer.innerText || composer.textContent || '';
}

export function replaceGrokComposerText(composer: GrokComposer, text: string): void {
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

export function findGrokSendButton(
  composer: GrokComposer,
  documentRoot: Document = document,
): HTMLButtonElement | null {
  for (const selector of sendButtonSelectors) {
    const local = composer.closest('form')?.querySelector<HTMLButtonElement>(selector);
    if (local) return local;
    const page = documentRoot.querySelector<HTMLButtonElement>(selector);
    if (page) return page;
  }
  return null;
}

export function isGrokSendButtonEvent(event: MouseEvent, composer: GrokComposer): boolean {
  return event.target instanceof Element &&
    event.target.closest('button') === findGrokSendButton(composer);
}

export function isGrokEnterSubmission(event: KeyboardEvent, composer: GrokComposer): boolean {
  const target = event.target;
  return event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing &&
    !event.defaultPrevented && target instanceof Node &&
    (target === composer || composer.contains(target));
}

export function getGrokStatusMount(composer: GrokComposer): HTMLElement {
  return composer.closest('form') ?? composer.parentElement ?? document.body;
}

export function resumeGrokSubmission(composer: GrokComposer): boolean {
  const button = findGrokSendButton(composer);
  if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') {
    debugLog('Grok', 'Send control unavailable while resuming submission');
    composer.focus();
    return false;
  }
  button.click();
  return true;
}

export function findGrokFileInput(
  documentRoot: Document = document,
  composer?: GrokComposer,
): HTMLInputElement | null {
  if (composer) {
    const scope = composer.closest('form') ?? composer.parentElement;
    return scope?.querySelector<HTMLInputElement>('input[type="file"]') ?? null;
  }
  return documentRoot.querySelector<HTMLInputElement>('input[type="file"]');
}
