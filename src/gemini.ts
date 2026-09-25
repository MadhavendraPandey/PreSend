import { debugLog } from './config';
import { replaceContentEditableText } from './contenteditable';

export type GeminiComposer = HTMLTextAreaElement | HTMLElement;

const composerSelectors = [
  'rich-textarea .ql-editor[contenteditable="true"]',
  '[contenteditable="true"][role="textbox"]',
  'textarea[aria-label*="prompt" i]',
];

const sendButtonSelectors = [
  'button[aria-label*="Send message" i]',
  'button[data-test-id*="send" i]',
  'button.send-button',
];

const fileControlSelectors = [
  'button[aria-label*="upload" i]',
  'button[aria-label*="attach" i]',
  'button[aria-label*="add file" i]',
  '[data-test-id*="upload" i]',
  '[data-test-id*="attach" i]',
  'button[mattooltip*="upload" i]',
  'button[mattooltip*="file" i]',
];

export function isGeminiPage(locationLike: Pick<Location, 'hostname'> = window.location): boolean {
  return locationLike.hostname === 'gemini.google.com';
}

function usable(element: Element): element is GeminiComposer {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  return element instanceof HTMLTextAreaElement
    ? !element.disabled
    : element.getAttribute('contenteditable') === 'true';
}

export function findGeminiComposer(documentRoot: Document = document): GeminiComposer | null {
  for (const selector of composerSelectors) {
    for (const candidate of documentRoot.querySelectorAll(selector)) {
      if (usable(candidate)) return candidate;
    }
  }
  return null;
}

export function readGeminiComposerText(composer: GeminiComposer): string {
  return composer instanceof HTMLTextAreaElement
    ? composer.value
    : composer.innerText || composer.textContent || '';
}

export function replaceGeminiComposerText(composer: GeminiComposer, text: string): void {
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

export function findGeminiSendButton(
  composer: GeminiComposer,
  documentRoot: Document = document,
): HTMLButtonElement | null {
  for (const selector of sendButtonSelectors) {
    const local = composer.closest('form')?.querySelector<HTMLButtonElement>(selector);
    if (local) return local;
    const page = documentRoot.querySelector<HTMLButtonElement>(selector);
    if (page) return page;
  }
  return composer.closest('form')?.querySelector<HTMLButtonElement>('button[type="submit"]') ?? null;
}

export function isGeminiSendButtonEvent(event: MouseEvent, composer: GeminiComposer): boolean {
  return event.target instanceof Element &&
    event.target.closest('button') === findGeminiSendButton(composer);
}

export function isGeminiEnterSubmission(event: KeyboardEvent, composer: GeminiComposer): boolean {
  const target = event.target;
  return event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing &&
    !event.defaultPrevented && target instanceof Node &&
    (target === composer || composer.contains(target));
}

export function getGeminiStatusMount(composer: GeminiComposer): HTMLElement {
  return composer.closest('form') ?? composer.parentElement ?? document.body;
}

export function resumeGeminiSubmission(composer: GeminiComposer): boolean {
  const button = findGeminiSendButton(composer);
  if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') {
    debugLog('Gemini', 'Send control unavailable while resuming submission');
    composer.focus();
    return false;
  }
  button.click();
  return true;
}

export function findGeminiFileInput(
  documentRoot: Document = document,
  composer?: GeminiComposer,
): HTMLInputElement | null {
  if (composer) {
    const scope = composer.closest('form') ?? composer.parentElement;
    return scope?.querySelector<HTMLInputElement>('input[type="file"]') ?? null;
  }
  return documentRoot.querySelector<HTMLInputElement>('input[type="file"]');
}

export function hasGeminiFileInterceptionControl(
  documentRoot: Document = document,
  composer?: GeminiComposer,
): boolean {
  const scopes: ParentNode[] = [];
  let scope: HTMLElement | null = composer?.closest('form') ?? composer?.parentElement ?? null;
  for (let depth = 0; scope && scope !== documentRoot.body && depth < 5; depth += 1) {
    scopes.push(scope);
    scope = scope.parentElement;
  }
  scopes.push(documentRoot);

  return scopes.some((candidateScope) => fileControlSelectors.some((selector) => {
    const control = candidateScope.querySelector<HTMLElement>(selector);
    return Boolean(
      control &&
      !control.hasAttribute('disabled') &&
      control.getAttribute('aria-disabled') !== 'true',
    );
  }));
}
