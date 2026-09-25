import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSiteIntegration, siteIntegrations, siteNameForHostname } from '../src/sites';

const fixtures = [
  {
    id: 'chatgpt',
    hostname: 'chatgpt.com',
    html: '<form><textarea id="prompt-textarea">Hello</textarea><input type="file"><button type="button" data-testid="send-button"><span>Send</span></button></form>',
  },
  {
    id: 'claude',
    hostname: 'claude.ai',
    html: '<form><div data-testid="chat-input" contenteditable="true">Hello</div><input type="file"><button type="button" aria-label="Send message"><span>Send</span></button></form>',
  },
  {
    id: 'gemini',
    hostname: 'gemini.google.com',
    html: '<form><rich-textarea><div class="ql-editor" contenteditable="true">Hello</div></rich-textarea><input type="file"><button type="button" aria-label="Send message"><span>Send</span></button></form>',
  },
  {
    id: 'perplexity',
    hostname: 'perplexity.ai',
    html: '<form><textarea placeholder="Ask anything">Hello</textarea><input type="file"><button type="button" aria-label="Submit question"><span>Send</span></button></form>',
  },
  {
    id: 'deepseek',
    hostname: 'chat.deepseek.com',
    html: '<form><textarea id="chat-input">Hello</textarea><input type="file"><button type="button" aria-label="Send message"><span>Send</span></button></form>',
  },
  {
    id: 'grok',
    hostname: 'grok.com',
    html: '<form><textarea placeholder="Ask Grok">Hello</textarea><input type="file"><button type="button" aria-label="Send message"><span>Send</span></button></form>',
  },
] as const;

describe('supported-site integrations (representative DOM fixtures)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it.each(fixtures)('maps $hostname to the $id integration', ({ id, hostname }) => {
    expect(getSiteIntegration({ hostname } as Location)?.id).toBe(id);
    expect(siteNameForHostname(hostname)).toBeTruthy();
  });

  it('does not activate on unrelated hosts or X.com', () => {
    expect(getSiteIntegration({ hostname: 'example.com' } as Location)).toBeNull();
    expect(getSiteIntegration({ hostname: 'x.com' } as Location)).toBeNull();
  });

  it.each(fixtures)('discovers, reads, and updates the $id composer', ({ id, html }) => {
    document.body.innerHTML = html;
    const integration = siteIntegrations.find((candidate) => candidate.id === id)!;
    const composer = integration.findComposer();
    const inputListener = vi.fn();
    composer?.addEventListener('input', inputListener);

    expect(composer).not.toBeNull();
    expect(integration.readComposerText(composer!)).toBe('Hello');
    integration.replaceComposerText(composer!, 'Redacted');
    expect(integration.readComposerText(composer!)).toBe('Redacted');
    expect(inputListener).toHaveBeenCalledOnce();
  });

  it.each(fixtures)('recognizes send-button and Enter behavior for $id', ({ id, html }) => {
    document.body.innerHTML = html;
    const integration = siteIntegrations.find((candidate) => candidate.id === id)!;
    const composer = integration.findComposer()!;
    const buttonChild = document.querySelector('button span')!;
    const click = new MouseEvent('click', { bubbles: true });
    Object.defineProperty(click, 'target', { value: buttonChild });

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(enter, 'target', { value: composer });
    const shiftEnter = new KeyboardEvent('keydown', {
      key: 'Enter', shiftKey: true, bubbles: true,
    });
    Object.defineProperty(shiftEnter, 'target', { value: composer });

    expect(integration.isSendButtonEvent(click, composer)).toBe(true);
    expect(integration.isEnterSubmission(enter, composer)).toBe(true);
    expect(integration.isEnterSubmission(shiftEnter, composer)).toBe(false);
  });

  it.each(fixtures)('triggers an approved $id submission through its send control', ({ id, html }) => {
    document.body.innerHTML = html;
    const integration = siteIntegrations.find((candidate) => candidate.id === id)!;
    const composer = integration.findComposer()!;
    const button = integration.findSendButton(composer)!;
    const click = vi.spyOn(button, 'click');

    expect(integration.resumeSubmission(composer)).toBe(true);
    expect(click).toHaveBeenCalledOnce();
  });

  it.each(fixtures)('recovers composer and upload-control discovery after an $id rerender', ({ id, html }) => {
    const integration = siteIntegrations.find((candidate) => candidate.id === id)!;
    expect(integration.findComposer()).toBeNull();

    document.body.innerHTML = html;
    const firstComposer = integration.findComposer();
    expect(firstComposer).not.toBeNull();
    expect(integration.findFileInput()).not.toBeNull();

    document.body.innerHTML = html.replace('Hello', 'New composer');
    const replacementComposer = integration.findComposer();
    expect(replacementComposer).not.toBeNull();
    expect(replacementComposer).not.toBe(firstComposer);
    expect(firstComposer?.isConnected).toBe(false);
  });

  it.each([
    {
      id: 'claude',
      html: `
        <main>
          <input type="file" aria-label="Profile image">
          <div data-testid="composer-shell">
            <input type="file" multiple data-testid="file-upload">
            <form><div data-testid="chat-input" contenteditable="true">Hello</div></form>
          </div>
        </main>
      `,
    },
    {
      id: 'perplexity',
      html: `
        <main>
          <input type="file" aria-label="Profile image">
          <div data-testid="composer-shell">
            <form><textarea placeholder="Ask anything">Hello</textarea></form>
            <div data-testid="attachment-portal">
              <input type="file" accept=".pdf,.docx,text/plain" aria-label="Upload document">
            </div>
          </div>
        </main>
      `,
    },
  ] as const)('finds the $id attachment input outside the immediate composer form', ({ id, html }) => {
    document.body.innerHTML = html;
    const integration = siteIntegrations.find((candidate) => candidate.id === id)!;
    const composer = integration.findComposer()!;
    const input = integration.findFileInput(document, composer);

    expect(input).not.toBeNull();
    expect(input?.getAttribute('aria-label')).not.toBe('Profile image');
  });

  it.each(['claude', 'gemini', 'perplexity'] as const)(
    'reports dynamic attachment interception capability for %s',
    (id) => {
      const integration = siteIntegrations.find((candidate) => candidate.id === id)!;
      expect(integration.supportsDynamicFileInput).toBe(true);
    },
  );

  it('confirms Gemini dynamic interception only from a live composer upload control', () => {
    const integration = siteIntegrations.find((candidate) => candidate.id === 'gemini')!;
    document.body.innerHTML = `
      <main>
        <div class="composer-shell">
          <button type="button" aria-label="Upload files"></button>
          <form>
            <rich-textarea><div class="ql-editor" contenteditable="true">Hello</div></rich-textarea>
            <button type="button" aria-label="Send message"></button>
          </form>
        </div>
      </main>
    `;
    const composer = integration.findComposer()!;
    expect(integration.findFileInput(document, composer)).toBeNull();
    expect(integration.hasFileInterceptionControl?.(document, composer)).toBe(true);

    document.querySelector('[aria-label="Upload files"]')?.remove();
    expect(integration.hasFileInterceptionControl?.(document, composer)).toBe(false);
  });

  it.each(fixtures)('reports $id integration unavailable when semantic controls are absent', ({ id }) => {
    document.body.innerHTML = '<main><p>Conversation view without a composer.</p></main>';
    const integration = siteIntegrations.find((candidate) => candidate.id === id)!;
    expect(integration.findComposer()).toBeNull();
    expect(integration.findFileInput()).toBeNull();
  });
});
