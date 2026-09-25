import { describe, expect, it } from 'vitest';
import { redactText, replaceWithSafeExamples } from '../src/redaction';
import { scanText } from '../src/scanner';
import type { Finding } from '../src/types';

function semanticFinding(text: string, category: string): Finding {
  return {
    id: `semantic-${category}`,
    detector: 'semantic',
    category,
    severity: 'medium',
    confidence: 0.8,
    startIndex: 0,
    endIndex: text.length,
    originalValue: text,
    maskedPreview: `[Masked passage, ${text.length} characters]`,
    replacementValue: '[SENSITIVE_INFORMATION_REDACTED]',
    safeExampleValue: 'unused',
    explanation: 'Semantic test finding.',
    features: {
      source: 'semantic',
      lengthBucket: 'medium',
      entropyBucket: 'medium',
      placeholderLike: false,
      structures: ['semantic:test'],
    },
  };
}

describe('redactText', () => {
  it('preserves unaffected text and redacts from the end safely', () => {
    const text =
      'first API_KEY=live_abcdefgh123456 then AWS_ACCESS_KEY_ID=AKIA1234567890ABCDEF done';
    const redacted = redactText(text, scanText(text));

    expect(redacted).toBe(
      'first API_KEY=[API_KEY_REDACTED] then AWS_ACCESS_KEY_ID=[AWS_ACCESS_KEY_REDACTED] done',
    );
  });

  it('never leaves the original secret in the output', () => {
    const secret = 'superSecretValue928374';
    const text = `CLIENT_SECRET=${secret}`;
    expect(redactText(text, scanText(text))).not.toContain(secret);
  });

  it('redacts database credentials while retaining useful URL structure', () => {
    const text = 'Connect to postgresql://admin:secret123@prod.internal/app please';
    expect(redactText(text, scanText(text))).toBe(
      'Connect to postgresql://[USER]:[PASSWORD]@[HOST]/app please',
    );
  });

  it('ignores an invalid range without corrupting text', () => {
    const [finding] = scanText('API_KEY=live_abcdefgh123456');
    expect(finding).toBeDefined();
    expect(
      redactText('short', [{ ...finding!, startIndex: 99, endIndex: 120 }]),
    ).toBe('short');
  });
});

describe('replaceWithSafeExamples', () => {
  it('replaces only a password value and preserves all surrounding text', () => {
    const text = 'Before PASSWORD=Yosfa12@734ifsc after';
    expect(replaceWithSafeExamples(text, scanText(text))).toBe(
      'Before PASSWORD=Example_Password after',
    );
  });

  it('preserves an Authorization header while replacing only its token', () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature123';
    expect(replaceWithSafeExamples(text, scanText(text))).toBe(
      'Authorization: Bearer Example_Token',
    );
  });

  it('genericizes a detected database URL without rewriting surrounding text', () => {
    const text =
      'Connect with postgresql://admin:secret123@prod-db.internal:5432/customer today.';
    const replaced = replaceWithSafeExamples(text, scanText(text));

    expect(replaced).toBe('Connect with postgresql://dummylink today.');
    expect(replaced).not.toContain('admin');
    expect(replaced).not.toContain('secret123');
  });

  it('replaces repeated identical values consistently, including mailto formatting', () => {
    const text = [
      'alice@company.com',
      'alice@company.com',
      'mailto:alice@company.com',
    ].join(' ');
    const replaced = replaceWithSafeExamples(text, scanText(text));

    expect(replaced).toBe(
      'example@example.com example@example.com mailto:example@example.com',
    );
  });

  it('uses obvious placeholders for API keys and internal hosts', () => {
    const text = 'OPENAI_API_KEY=sk-actual-looking-value host=prod-db.internal';
    const replaced = replaceWithSafeExamples(text, scanText(text));
    expect(replaced).toBe('OPENAI_API_KEY=Example_API_Key host=example.internal');
  });

  it('uses an obvious generic phone number', () => {
    const text = 'Phone: (415) 867-5309';
    expect(replaceWithSafeExamples(text, scanText(text))).toBe('Phone: 202-555-0100');
  });

  it.each([
    {
      category: 'Customer-specific information',
      text: 'Please review customer Acme Labs renewal terms before replying.',
      expected: 'Please review customer Example_Customer renewal terms before replying.',
    },
    {
      category: 'Employee-sensitive information',
      text: 'Employee Jordan Lee salary review is next week.',
      expected: 'Employee Example_Employee salary review is next week.',
    },
    {
      category: 'Non-public financial information',
      text: 'Forecast is $18.4 million for next quarter.',
      expected: 'Forecast is Example_Amount for next quarter.',
    },
  ])('minimally genericizes $category values', ({ category, text, expected }) => {
    expect(replaceWithSafeExamples(text, [semanticFinding(text, category)])).toBe(expected);
  });

  it('narrows a semantic chunk to the relevant clause and preserves the question', () => {
    const text =
      'Summarize this note. Customer Northstar renewal terms changed yesterday. What should I ask next?';
    expect(replaceWithSafeExamples(
      text,
      [semanticFinding(text, 'Customer-specific information')],
    )).toBe(
      'Summarize this note. Customer Example_Customer renewal terms changed yesterday. What should I ask next?',
    );
  });

  it('runs cleanly through the normal scanner after replacement', () => {
    const original = [
      'DATABASE_URL=postgresql://admin:secret123@prod.internal/customer',
      'GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz',
      'PASSWORD=Summer2026!',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123',
      'alice@company.com',
      'prod-db.internal',
    ].join('\n');
    const safeText = replaceWithSafeExamples(original, scanText(original));
    expect(scanText(safeText)).toEqual([]);
  });
});
