import { describe, expect, it } from 'vitest';
import { createFeedbackRecord, fingerprintValue } from '../src/feedback';
import { scanText } from '../src/scanner';

describe('local feedback data', () => {
  it('uses a deterministic one-way fingerprint without retaining the raw value', async () => {
    const secret = 'live_secret_value_928374';
    const first = await fingerprintValue(secret, 'fixed-test-salt');
    const second = await fingerprintValue(secret, 'fixed-test-salt');
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain(secret);
  });

  it('creates a sanitized future-ML label record', () => {
    const secret = 'live_secret_value_928374';
    const [finding] = scanText(`CLIENT_SECRET=${secret}`);
    expect(finding).toBeDefined();
    const record = createFeedbackRecord(finding!, 'not-sensitive', 'abc123', 1234);
    const serialized = JSON.stringify(record);

    expect(record.feedbackLabel).toBe('not-sensitive');
    expect(record.valueFingerprint).toBe('abc123');
    expect(record.features.structures).toContain('assignment');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('originalValue');
  });
});
