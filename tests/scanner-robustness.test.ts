import { describe, expect, it } from 'vitest';
import { scanText } from '../src/scanner';

const databaseFindings = (text: string) =>
  scanText(text).filter((finding) => finding.detector === 'databaseUrl');

const privateKeyFindings = (text: string) =>
  scanText(text).filter((finding) => finding.detector === 'privateKey');

const convincingPemBody = [
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7',
  'x9K2mY8qR4vN6tP3sL1wF5dH7jC0bA9eU2iO4kG6nM8zQ1rT',
].join('\n');

describe('database URL credential robustness', () => {
  it.each([
    ['complete valid URL', 'postgresql://admin:FakeSecret123@prod.internal:5432/customer'],
    ['URL without a path', 'postgresql://admin:FakeSecret123@prod.internal:5432'],
    ['URL without an explicit port', 'postgresql://admin:FakeSecret123@prod.internal/customer'],
  ])('keeps structured high-confidence detection for a %s', (_label, value) => {
    const findings = databaseFindings(`DATABASE_URL=${value}`);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual(expect.objectContaining({
      detector: 'databaseUrl',
      severity: 'critical',
      confidence: 0.98,
      originalValue: value,
      explanation: 'Database URL contains embedded username and password.',
    }));
  });

  it('detects credentials when no host follows the at-sign', () => {
    const value = 'postgresql://admin:FakeSecret123@';
    const findings = databaseFindings(`DATABASE_URL=${value}`);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual(expect.objectContaining({
      severity: 'critical',
      confidence: 0.78,
      originalValue: value,
      explanation:
        'Value appears to contain embedded database credentials, but the database URL is incomplete or malformed.',
    }));
    expect(findings[0]?.features.structures).toContain('missing-host');
  });

  it('detects credentials when the host syntax is malformed', () => {
    const value = 'postgresql://admin:FakeSecret123@[broken-host';
    const findings = databaseFindings(`DATABASE_URL=${value}`);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual(expect.objectContaining({
      severity: 'critical',
      confidence: 0.89,
      originalValue: value,
    }));
    expect(findings[0]?.features.structures).toContain('invalid-host');
  });

  it.each(['postgres', 'postgresql', 'mysql', 'mongodb', 'redis'])(
    'recognizes incomplete %s URLs when username and password evidence remains',
    (scheme) => {
      const value = `${scheme}://service_user:StillSecret987@`;
      expect(databaseFindings(value)).toEqual([
        expect.objectContaining({
          detector: 'databaseUrl',
          severity: 'critical',
          confidence: 0.78,
          originalValue: value,
        }),
      ]);
    },
  );

  it.each([
    'DATABASE_URL=postgresql://prod.internal:5432/customer',
    'REDIS_URL=redis://cache.internal:6379/0',
    'The database documentation discusses a username, password, and postgres host.',
  ])('does not infer database credentials from credential-free input: %s', (text) => {
    expect(databaseFindings(text)).toEqual([]);
  });
});

describe('PEM private-key robustness', () => {
  it('keeps complete matching PEM boundaries at high confidence', () => {
    const value = [
      '-----BEGIN PRIVATE KEY-----',
      'FAKE_DATA_ONLY',
      '-----END PRIVATE KEY-----',
    ].join('\n');

    expect(privateKeyFindings(value)).toEqual([
      expect.objectContaining({
        detector: 'privateKey',
        severity: 'critical',
        confidence: 0.99,
        originalValue: value,
        explanation: 'Matches a PEM private-key block.',
      }),
    ]);
  });

  it('detects a footer with one missing hyphen', () => {
    const value = [
      '-----BEGIN PRIVATE KEY-----',
      'FAKE_DATA_ONLY',
      '-----END PRIVATE KEY----',
    ].join('\n');

    expect(privateKeyFindings(value)).toEqual([
      expect.objectContaining({
        severity: 'critical',
        confidence: 0.93,
        originalValue: value,
      }),
    ]);
  });

  it('detects a header with one missing hyphen', () => {
    const value = [
      '----BEGIN PRIVATE KEY-----',
      'FAKE_DATA_ONLY',
      '-----END PRIVATE KEY-----',
    ].join('\n');

    expect(privateKeyFindings(value)).toEqual([
      expect.objectContaining({
        severity: 'critical',
        confidence: 0.93,
        originalValue: value,
      }),
    ]);
  });

  it('detects an RSA footer with one missing hyphen', () => {
    const value = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'FAKE_DATA_ONLY',
      '-----END RSA PRIVATE KEY----',
    ].join('\n');

    expect(privateKeyFindings(value)).toEqual([
      expect.objectContaining({ severity: 'critical', confidence: 0.93 }),
    ]);
  });

  it('detects a missing footer only when the encoded body is convincing', () => {
    const value = `-----BEGIN PRIVATE KEY-----\n${convincingPemBody}`;

    expect(privateKeyFindings(value)).toEqual([
      expect.objectContaining({
        severity: 'critical',
        confidence: 0.74,
        originalValue: value,
        explanation:
          'Appears to contain an incomplete PEM private-key block with a convincing encoded body.',
      }),
    ]);
  });

  it('detects mismatched RSA and generic private-key labels below exact confidence', () => {
    const value = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'FAKE_DATA_ONLY',
      '-----END PRIVATE KEY-----',
    ].join('\n');

    expect(privateKeyFindings(value)).toEqual([
      expect.objectContaining({
        severity: 'critical',
        confidence: 0.88,
        originalValue: value,
        explanation:
          'Appears to contain a PEM private-key block whose BEGIN and END labels do not match.',
      }),
    ]);
  });

  it('limits an incomplete block finding to the plausible encoded body', () => {
    const block = `-----BEGIN PRIVATE KEY-----\n${convincingPemBody}`;
    const text = `${block}\nThis prose must remain outside the finding.`;
    const findings = privateKeyFindings(text);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.originalValue).toBe(block);
    expect(findings[0]?.endIndex).toBe(block.length);
  });

  it.each([
    'Please rotate the private key before the next deployment.',
    '-----BEGIN PRIVATE KEY-----\nnot a plausible encoded key body',
  ])('does not flag weak private-key wording or marker evidence: %s', (text) => {
    expect(privateKeyFindings(text)).toEqual([]);
  });
});
