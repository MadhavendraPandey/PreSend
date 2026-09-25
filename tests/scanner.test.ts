import { describe, expect, it } from 'vitest';
import { resolveOverlappingFindings, scanText } from '../src/scanner';
import type { Finding } from '../src/types';

describe('scanText', () => {
  it('returns no findings for normal text', () => {
    expect(scanText('Please explain JWT authentication and database connection pooling.')).toEqual([]);
  });

  it('handles empty text', () => {
    expect(scanText('')).toEqual([]);
  });

  it('detects a PEM private key block', () => {
    const text = '-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----';
    expect(scanText(text)).toEqual([
      expect.objectContaining({ detector: 'privateKey', severity: 'critical' }),
    ]);
  });

  it('detects an AWS access key', () => {
    const findings = scanText('AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF');
    expect(findings).toEqual([
      expect.objectContaining({ detector: 'awsKey', originalValue: 'AKIA1234567890ABCDEF' }),
    ]);
  });

  it('detects a bearer token without including the label in the secret range', () => {
    const text = 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456';
    const [finding] = scanText(text);
    expect(finding).toEqual(expect.objectContaining({ detector: 'bearerToken' }));
    expect(text.slice(finding?.startIndex, finding?.endIndex)).toBe(
      'abcdefghijklmnopqrstuvwxyz123456',
    );
  });

  it('detects a JWT-looking token', () => {
    const findings = scanText('token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123');
    expect(findings).toEqual([
      expect.objectContaining({ detector: 'bearerToken', category: 'JWT token' }),
    ]);
  });

  it('detects a credentialed database URL and preserves its path in replacement', () => {
    const findings = scanText('postgresql://admin:secret123@prod.internal/app');
    expect(findings).toEqual([
      expect.objectContaining({
        detector: 'databaseUrl',
        severity: 'critical',
        replacementValue: 'postgresql://[USER]:[PASSWORD]@[HOST]/app',
      }),
    ]);
  });

  it('detects a secret assignment', () => {
    const findings = scanText('CLIENT_SECRET="live_secret_83hdkq92"');
    expect(findings).toEqual([
      expect.objectContaining({
        detector: 'secretAssignment',
        originalValue: 'live_secret_83hdkq92',
      }),
    ]);
  });

  it('detects multiple findings in one prompt', () => {
    const findings = scanText(
      'API_KEY=live_928374928374 and AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF',
    );
    expect(findings).toHaveLength(2);
  });

  it.each([
    'API_KEY=your-api-key',
    'TOKEN=xxxxxxxx',
    'Example: PASSWORD=password123',
    'SECRET=[REDACTED]',
    'ACCESS_TOKEN=<TOKEN>',
    'CLIENT_SECRET=placeholder',
  ])('ignores likely placeholder: %s', (text) => {
    expect(scanText(text)).toEqual([]);
  });

  it('does not globally ignore a weak password outside documentation context', () => {
    expect(scanText('PASSWORD=password123')).toEqual([
      expect.objectContaining({ detector: 'secretAssignment' }),
    ]);
    expect(scanText('postgresql://admin:password123@prod.internal/app')).toEqual([
      expect.objectContaining({ detector: 'databaseUrl' }),
    ]);
  });

  it('keeps the more specific critical finding when detector ranges overlap', () => {
    const findings = scanText('TOKEN=postgresql://admin:realPassword@db.internal/main');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.detector).toBe('databaseUrl');
  });

  it('resolves synthetic overlaps by severity and confidence', () => {
    const base: Finding = {
      id: 'low', detector: 'secretAssignment', category: 'Assigned secret', severity: 'high',
      confidence: 0.8, startIndex: 2, endIndex: 10, originalValue: 'abcdefgh',
      maskedPreview: '••••', replacementValue: '[REDACTED]', explanation: 'test',
      safeExampleValue: 'SAFE_EXAMPLE',
      features: {
        source: 'structured', lengthBucket: 'short', entropyBucket: 'low',
        placeholderLike: false, structures: ['test'],
      },
    };
    const critical: Finding = {
      ...base, id: 'critical', detector: 'databaseUrl', category: 'Database credential',
      severity: 'critical', confidence: 0.95, startIndex: 0, endIndex: 20,
    };
    expect(resolveOverlappingFindings([base, critical])).toEqual([critical]);
  });

  it('resolves a high volume of non-overlapping findings without quadratic scanning', () => {
    const [base] = scanText('API_KEY=live_abcdefgh123456');
    expect(base).toBeDefined();
    const findings = Array.from({ length: 20_000 }, (_, index): Finding => ({
      ...base!,
      id: `bulk-${index}`,
      startIndex: index * 3,
      endIndex: index * 3 + 2,
      originalValue: 'xx',
    }));

    const resolved = resolveOverlappingFindings(findings);

    expect(resolved).toHaveLength(20_000);
    expect(resolved[0]?.id).toBe('bulk-0');
    expect(resolved.at(-1)?.id).toBe('bulk-19999');
  });

  it('does not crash on malformed but valid string inputs', () => {
    expect(() => scanText('\u0000\ud800 Authorization: Bearer ...')).not.toThrow();
  });

  it('honors user-facing detector groups without changing other categories', () => {
    const text = [
      'API_KEY=live_abcdefgh123456',
      'postgresql://admin:secret123@prod.internal/app',
      'Contact john.smith@realcompany.com',
      'Inspect logs.company.internal',
    ].join('\n');
    const findings = scanText(text, {
      credentials: false,
      privateKeys: true,
      databaseCredentials: true,
      emails: false,
      phoneNumbers: true,
      internalHosts: true,
    });

    expect(findings.map((finding) => finding.detector)).toEqual([
      'databaseUrl',
      'internalHostname',
    ]);
  });
});
