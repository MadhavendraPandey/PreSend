import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findComposer,
  findSendButton,
  isChatGptPage,
  isEnterSubmission,
  isSendButtonEvent,
  readComposerText,
  replaceComposerText,
} from '../src/chatgpt';

describe('ChatGPT integration helpers', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('recognizes only supported ChatGPT hosts', () => {
    expect(isChatGptPage({ hostname: 'chatgpt.com' } as Location)).toBe(true);
    expect(isChatGptPage({ hostname: 'chat.openai.com' } as Location)).toBe(true);
    expect(isChatGptPage({ hostname: 'example.com' } as Location)).toBe(false);
  });

  it('finds and reads a semantic contenteditable composer', () => {
    document.body.innerHTML = '<div id="prompt-textarea" contenteditable="true">Hello</div>';
    const composer = findComposer();
    expect(composer).not.toBeNull();
    expect(readComposerText(composer!)).toBe('Hello');
  });

  it('finds a send button near the composer', () => {
    document.body.innerHTML = `
      <form><textarea id="prompt-textarea"></textarea><button data-testid="send-button">Send</button></form>
    `;
    const composer = findComposer()!;
    expect(findSendButton(composer)?.textContent).toBe('Send');
  });

  it('recognizes button and Enter submissions but not Shift+Enter', () => {
    document.body.innerHTML = `
      <form><textarea id="prompt-textarea"></textarea><button data-testid="send-button"><span>Send</span></button></form>
    `;
    const composer = findComposer()!;
    const buttonChild = document.querySelector('button span')!;
    const click = new MouseEvent('click');
    Object.defineProperty(click, 'target', { value: buttonChild });
    expect(isSendButtonEvent(click, composer)).toBe(true);

    composer.addEventListener('keydown', (rawEvent) => {
      const event = rawEvent as KeyboardEvent;
      expect(isEnterSubmission(event, composer)).toBe(!event.shiftKey);
    });
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
  });

  it('replaces textarea text and emits an input event', () => {
    document.body.innerHTML = '<textarea id="prompt-textarea">secret</textarea>';
    const composer = findComposer()!;
    const inputListener = vi.fn();
    composer.addEventListener('input', inputListener);
    replaceComposerText(composer, 'redacted');
    expect(readComposerText(composer)).toBe('redacted');
    expect(inputListener).toHaveBeenCalledOnce();
  });
});
