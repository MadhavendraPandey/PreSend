import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySubmissionDecision, ComposerMonitor } from '../src/monitor';
import { scanText } from '../src/scanner';

describe('ComposerMonitor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces normal typing for 1500 ms', () => {
    let text = 'first';
    const scanner = vi.fn(scanText);
    const monitor = new ComposerMonitor({ readText: () => text, onStateChange: vi.fn(), scanner });

    monitor.handleInput();
    vi.advanceTimersByTime(1_000);
    text = 'second';
    monitor.handleInput();
    vi.advanceTimersByTime(1_499);
    expect(scanner).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(scanner).toHaveBeenCalledOnce();
    expect(scanner).toHaveBeenCalledWith('second');
  });

  it('scans pasted text after 100 ms without waiting for the typing debounce', () => {
    const scanner = vi.fn(scanText);
    const monitor = new ComposerMonitor({
      readText: () => 'API_KEY=live_abcdefgh123456', onStateChange: vi.fn(), scanner,
    });
    monitor.handleInput();
    monitor.handlePaste();
    vi.advanceTimersByTime(99);
    expect(scanner).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(scanner).toHaveBeenCalledOnce();
  });

  it('always performs a fresh final scan even when text is unchanged', async () => {
    const scanner = vi.fn(scanText);
    const monitor = new ComposerMonitor({ readText: () => 'same text', onStateChange: vi.fn(), scanner });
    await monitor.finalScan();
    await monitor.finalScan();
    expect(scanner).toHaveBeenCalledTimes(2);
  });

  it('waits for asynchronous semantic findings before completing a final scan', async () => {
    let finishScan!: (findings: ReturnType<typeof scanText>) => void;
    const scanner = vi.fn(() => new Promise<ReturnType<typeof scanText>>((resolve) => {
      finishScan = resolve;
    }));
    const monitor = new ComposerMonitor({
      readText: () => 'Quarterly planning note',
      onStateChange: vi.fn(),
      scanner,
    });

    let completed = false;
    const finalScan = monitor.finalScan().then((result) => {
      completed = true;
      return result;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    finishScan([{
      id: 'semantic-financial-0-23',
      detector: 'semantic',
      category: 'Non-public financial information',
      severity: 'medium',
      confidence: 0.8,
      startIndex: 0,
      endIndex: 23,
      originalValue: 'Quarterly planning note',
      maskedPreview: '[Masked passage, 23 characters]',
      replacementValue: '[REDACTED NON-PUBLIC FINANCIAL INFORMATION]',
      safeExampleValue: 'Public financial summary',
      explanation: 'This passage may contain non-public financial information.',
      features: {
        source: 'semantic',
        lengthBucket: 'short',
        entropyBucket: 'medium',
        placeholderLike: false,
        structures: ['semantic:financial_internal'],
      },
    }]);

    await expect(finalScan).resolves.toEqual({
      text: 'Quarterly planning note',
      findings: [expect.objectContaining({ detector: 'semantic' })],
    });
  });

  it('does not delay a clean final scan', async () => {
    const scanner = vi.fn(scanText);
    const monitor = new ComposerMonitor({ readText: () => 'hello', onStateChange: vi.fn(), scanner });
    expect((await monitor.finalScan()).findings).toEqual([]);
    expect(scanner).toHaveBeenCalledOnce();
  });

  it('filters persisted allowlist findings from passive status updates', async () => {
    const onStateChange = vi.fn();
    const findingFilter = vi.fn(async () => []);
    const monitor = new ComposerMonitor({
      readText: () => 'API_KEY=live_abcdefgh123456',
      onStateChange,
      findingFilter,
    });

    monitor.handlePaste();
    await vi.advanceTimersByTimeAsync(100);

    expect(findingFilter).toHaveBeenCalledWith([
      expect.objectContaining({ detector: 'secretAssignment' }),
    ]);
    expect(onStateChange).toHaveBeenLastCalledWith({ kind: 'complete', findingCount: 0 });
  });
});

describe('submission decisions', () => {
  const originalText = 'API_KEY=live_abcdefgh123456';
  const findings = scanText(originalText);

  it('Cancel prevents submission and preserves the prompt', async () => {
    const replaceText = vi.fn();
    const submit = vi.fn();
    const focusComposer = vi.fn();
    await applySubmissionDecision({ action: 'cancel', originalText, findings, replaceText, submit, focusComposer });
    expect(replaceText).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(focusComposer).toHaveBeenCalledOnce();
  });

  it('Send Anyway submits the original text without changing it', async () => {
    const replaceText = vi.fn();
    const submit = vi.fn();
    await applySubmissionDecision({ action: 'send-anyway', originalText, findings, replaceText, submit, focusComposer: vi.fn() });
    expect(replaceText).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledOnce();
  });

  it('Redact and Send updates the composer before submission', async () => {
    const calls: string[] = [];
    await applySubmissionDecision({
      action: 'redact', originalText, findings,
      replaceText: (text) => calls.push(`replace:${text}`),
      submit: () => {
        calls.push('submit');
      },
      focusComposer: vi.fn(),
    });
    expect(calls).toEqual(['replace:API_KEY=[API_KEY_REDACTED]', 'submit']);
  });

  it('Replace with Safe Example sanitizes before submission', async () => {
    const databaseText =
      'DATABASE_URL=postgresql://admin:secret123@prod.internal:5432/customer';
    const calls: string[] = [];
    await applySubmissionDecision({
      action: 'replace-safe',
      originalText: databaseText,
      findings: scanText(databaseText),
      replaceText: (text) => calls.push(`replace:${text}`),
      submit: () => {
        calls.push('submit');
      },
      focusComposer: vi.fn(),
    });

    expect(calls).toEqual([
      'replace:DATABASE_URL=postgresql://dummylink',
      'submit',
    ]);
  });
});
