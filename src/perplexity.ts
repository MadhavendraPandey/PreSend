import { debugLog } from './config';
import { replaceContentEditableText } from './contenteditable';

export type PerplexityComposer = HTMLTextAreaElement | HTMLElement;

const composerSelectors = [
  'textarea[placeholder*="Ask" i]',
  'textarea[aria-label*="Ask" i]',
  '[contenteditable="true"][role="textbox"]',
];

const sendButtonSelectors = [
  'button[aria-label*="Submit" i]',
  'button[aria-label*="Send" i]',
  'button[data-testid*="submit" i]',
  'button[type="submit"]',
];

export function isPerplexityPage(locationLike: Pick<Location, 'hostname'> = window.location): boolean {
  return locationLike.hostname === 'perplexity.ai' || locationLike.hostname === 'www.perplexity.ai';
}

function usable(element: Element): element is PerplexityComposer {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  return element instanceof HTMLTextAreaElement
    ? !element.disabled
    : element.getAttribute('contenteditable') === 'true';
}

export function findPerplexityComposer(documentRoot: Document = document): PerplexityComposer | null {
  for (const selector of composerSelectors) {
    for (const candidate of documentRoot.querySelectorAll(selector)) {
      if (usable(candidate)) return candidate;
    }
  }
  return null;
}

export function readPerplexityComposerText(composer: PerplexityComposer): string {
  return composer instanceof HTMLTextAreaElement
    ? composer.value
    : composer.innerText || composer.textContent || '';
}

export function replacePerplexityComposerText(composer: PerplexityComposer, text: string): void {
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

export function findPerplexitySendButton(
  composer: PerplexityComposer,
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

export function isPerplexitySendButtonEvent(event: MouseEvent, composer: PerplexityComposer): boolean {
  return event.target instanceof Element &&
    event.target.closest('button') === findPerplexitySendButton(composer);
}

export function isPerplexityEnterSubmission(
  event: KeyboardEvent,
  composer: PerplexityComposer,
): boolean {
  const target = event.target;
  return event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing &&
    !event.defaultPrevented && target instanceof Node &&
    (target === composer || composer.contains(target));
}

export function getPerplexityStatusMount(composer: PerplexityComposer): HTMLElement {
  return composer.closest('form') ?? composer.parentElement ?? document.body;
}

export function resumePerplexitySubmission(composer: PerplexityComposer): boolean {
  const button = findPerplexitySendButton(composer);
  if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') {
    debugLog('Perplexity', 'Send control unavailable while resuming submission');
    composer.focus();
    return false;
  }
  button.click();
  return true;
}

export function findPerplexityFileInput(
  documentRoot: Document = document,
  composer?: PerplexityComposer,
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
