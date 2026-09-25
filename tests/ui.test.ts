import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanText } from '../src/scanner';
import { scanLocalFile } from '../src/files';
import {
  showFileWarningDialog,
  showWarningDialog,
} from '../src/ui';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('warning dialog', () => {
  it('keeps deterministic values masked until a local Reveal control is used', async () => {
    const secret = 'live_abcdefgh123456';
    const promise = showWarningDialog(scanText(`API_KEY=${secret}`));
    const host = document.querySelector<HTMLElement>('[data-presend-ui="warning"]')!;
    expect(host.shadowRoot?.textContent).not.toContain(secret);
    const reveal = host.shadowRoot?.querySelector<HTMLButtonElement>('.reveal');
    expect(reveal?.textContent).toBe('Reveal');
    reveal?.click();
    expect(host.shadowRoot?.textContent).toContain(secret);
    expect(reveal?.textContent).toBe('Hide');
    reveal?.click();
    expect(host.shadowRoot?.textContent).not.toContain(secret);
    host.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="redact"]')?.click();
    await expect(promise).resolves.toBe('redact');
  });

  it('shows the actual semantic passage by default in a bounded local preview', async () => {
    const passage = 'The next-quarter product launch date and partner rollout are not public.';
    const semanticFinding = {
      id: 'semantic-unreleased_product-0-72',
      detector: 'semantic' as const,
      category: 'Unreleased product information',
      severity: 'medium' as const,
      confidence: 0.8,
      startIndex: 0,
      endIndex: passage.length,
      originalValue: passage,
      maskedPreview: `[Masked passage, ${passage.length} characters]`,
      replacementValue: '[REDACTED UNRELEASED PRODUCT INFORMATION]',
      safeExampleValue: 'A public product example.',
      explanation: 'This passage may discuss a product or feature that has not been released.',
      features: {
        source: 'semantic' as const,
        lengthBucket: 'medium' as const,
        entropyBucket: 'medium' as const,
        placeholderLike: false,
        structures: ['semantic:unreleased_product'],
      },
    };

    const promise = showWarningDialog([semanticFinding]);
    const host = document.querySelector<HTMLElement>('[data-presend-ui="warning"]')!;
    const preview = host.shadowRoot?.querySelector<HTMLElement>('.semantic-preview');
    expect(host.shadowRoot?.textContent).toContain('Detected passage');
    expect(preview?.textContent).toBe(passage);
    expect(host.shadowRoot?.textContent).not.toContain('[Masked passage');
    expect(host.shadowRoot?.querySelector('.reveal')).toBeNull();

    host.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();
    await promise;
  });

  it('bounds very long semantic passages inside the scrollable preview', async () => {
    const passage = `Beginning of passage. ${'middle wording '.repeat(240)}End of passage.`;
    const semanticFinding = {
      id: 'semantic-confidential_business-0-long',
      detector: 'semantic' as const,
      category: 'Business-sensitive information',
      severity: 'medium' as const,
      confidence: 0.75,
      startIndex: 0,
      endIndex: passage.length,
      originalValue: passage,
      maskedPreview: `[Masked passage, ${passage.length} characters]`,
      replacementValue: '[REDACTED BUSINESS-SENSITIVE INFORMATION]',
      safeExampleValue: 'A public business example.',
      explanation: 'This passage may describe non-public business activity.',
      features: {
        source: 'semantic' as const,
        lengthBucket: 'very-long' as const,
        entropyBucket: 'medium' as const,
        placeholderLike: false,
        structures: ['semantic:confidential_business'],
      },
    };

    const promise = showWarningDialog([semanticFinding]);
    const host = document.querySelector<HTMLElement>('[data-presend-ui="warning"]')!;
    const preview = host.shadowRoot?.querySelector<HTMLElement>('.semantic-preview');
    expect(host.shadowRoot?.textContent).toContain('Detected passage (bounded excerpt)');
    expect(preview?.textContent).toContain('Beginning of passage.');
    expect(preview?.textContent).toContain('End of passage.');
    expect(preview?.textContent).toContain('passage shortened locally');
    expect(preview?.textContent?.length).toBeLessThan(passage.length);

    host.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();
    await promise;
  });

  it('supports Escape as Cancel', async () => {
    const promise = showWarningDialog(scanText('API_KEY=live_abcdefgh123456'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await expect(promise).resolves.toBe('cancel');
  });

  it('restores focus after the dialog closes', async () => {
    const composer = document.createElement('textarea');
    document.body.append(composer);
    composer.focus();
    const promise = showWarningDialog(scanText('API_KEY=live_abcdefgh123456'));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await promise;

    expect(document.activeElement).toBe(composer);
  });

  it('keeps a large finding list in a dedicated scroll region with actions available', async () => {
    const [baseFinding] = scanText('API_KEY=live_abcdefgh123456');
    expect(baseFinding).toBeDefined();
    const findings = Array.from({ length: 12 }, (_, index) => ({
      ...baseFinding!,
      id: `finding-${index}`,
    }));
    const promise = showWarningDialog(findings);
    const host = document.querySelector<HTMLElement>('[data-presend-ui="warning"]')!;

    expect(host.shadowRoot?.querySelectorAll('.finding')).toHaveLength(12);
    expect(host.shadowRoot?.querySelector('.findings')?.getAttribute('aria-label')).toBe(
      'Detected items',
    );
    expect(host.shadowRoot?.querySelectorAll('[data-action]')).toHaveLength(4);

    host.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();
    await promise;
  });

  it('bounds rendered finding cards while keeping the full finding count and actions', async () => {
    const [baseFinding] = scanText('API_KEY=live_abcdefgh123456');
    const findings = Array.from({ length: 250 }, (_, index) => ({
      ...baseFinding!,
      id: `bounded-${index}`,
    }));
    const promise = showWarningDialog(findings);
    const host = document.querySelector<HTMLElement>('[data-presend-ui="warning"]')!;

    expect(host.shadowRoot?.querySelectorAll('.finding')).toHaveLength(100);
    expect(host.shadowRoot?.textContent).toContain('first 100 of 250');
    expect(host.shadowRoot?.textContent).toContain('250 potential sensitive items');

    host.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();
    await promise;
  });

  it('offers safe-example replacement as the primary action', async () => {
    const promise = showWarningDialog(scanText('API_KEY=live_abcdefgh123456'));
    const host = document.querySelector<HTMLElement>('[data-presend-ui="warning"]')!;
    const button = host.shadowRoot?.querySelector<HTMLButtonElement>(
      '[data-action="replace-safe"]',
    );
    expect(button?.textContent).toBe('Replace with Safe Example');
    button?.click();
    await expect(promise).resolves.toBe('replace-safe');
  });

  it('records optional feedback and exposes exact-value allowlisting explicitly', async () => {
    const onFeedback = vi.fn(async () => undefined);
    const onAllowlist = vi.fn(async () => undefined);
    const promise = showWarningDialog(scanText('API_KEY=live_abcdefgh123456'), {
      onFeedback,
      onAllowlist,
    });
    const host = document.querySelector<HTMLElement>('[data-presend-ui="warning"]')!;
    const buttons = Array.from(host.shadowRoot?.querySelectorAll('button') ?? []);
    const notSensitive = buttons.find((button) => button.textContent === 'Not Sensitive');
    notSensitive?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ detector: 'secretAssignment' }),
      'not-sensitive',
      [],
    );

    const allowlist = Array.from(host.shadowRoot?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Allow this exact value',
    );
    expect(allowlist).toBeDefined();
    allowlist?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onAllowlist).toHaveBeenCalledOnce();

    host.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();
    await promise;
  });

  it('collects a corrected label before saving Wrong Category feedback', async () => {
    const onFeedback = vi.fn(async () => undefined);
    const promise = showWarningDialog(scanText('API_KEY=live_abcdefgh123456'), { onFeedback });
    const host = document.querySelector<HTMLElement>('[data-presend-ui="warning"]')!;
    const wrongCategory = Array.from(host.shadowRoot?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Wrong Category',
    );
    wrongCategory?.click();
    const select = host.shadowRoot?.querySelector<HTMLSelectElement>('[aria-label="Correct category"]');
    expect(select).not.toBeNull();
    select!.value = 'internal_security';
    const save = Array.from(host.shadowRoot?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Save correction',
    );
    save?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ detector: 'secretAssignment' }),
      'wrong-category',
      ['internal_security'],
    );
    host.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();
    await promise;
  });
});

describe('file warning dialog', () => {
  it('offers in-memory sanitization for a sensitive text file without rendering the secret', async () => {
    const secret = 'live_file_secret_928374';
    const result = await scanLocalFile(new File(
      [`CLIENT_SECRET=${secret}`],
      'config.env',
      { type: 'text/plain' },
    ));
    const promise = showFileWarningDialog([result]);
    const host = document.querySelector<HTMLElement>('[data-presend-ui="file-warning"]')!;

    expect(host.shadowRoot?.textContent).not.toContain(secret);
    expect(host.shadowRoot?.querySelector('[data-action="redact-copy"]')).not.toBeNull();
    expect(host.shadowRoot?.querySelector('[data-action="replace-safe-copy"]')).not.toBeNull();
    host.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();
    await expect(promise).resolves.toBe('cancel');
  });

  it('labels unsupported files unscannable and offers only upload-anyway or cancel', async () => {
    const result = await scanLocalFile(new File(['binary'], 'archive.zip'));
    const promise = showFileWarningDialog([result]);
    const host = document.querySelector<HTMLElement>('[data-presend-ui="file-warning"]')!;

    expect(host.shadowRoot?.textContent).toContain('File contents could not be scanned');
    expect(host.shadowRoot?.querySelector('[data-action="upload-original"]')).not.toBeNull();
    expect(host.shadowRoot?.querySelector('[data-action="redact-copy"]')).toBeNull();
    host.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="cancel"]')?.click();
    await promise;
  });
});
