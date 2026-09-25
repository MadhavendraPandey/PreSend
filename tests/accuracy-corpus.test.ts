import { describe, expect, it } from 'vitest';
import { scanText } from '../src/scanner';

const SHOULD_DETECT = [
  ['AWS access key', 'AWS_ACCESS_KEY_ID=AKIAZZZZZZZZZZZZZZZZ', 'awsKey'],
  ['GitHub token', 'GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz', 'githubToken'],
  ['OpenAI key', 'OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz123456', 'openAiKey'],
  ['Anthropic key', 'ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz', 'anthropicKey'],
  ['Stripe secret', 'STRIPE_SECRET=sk_live_AbCdEfGhIjKlMnOpQrStUvWx', 'stripeKey'],
  ['Slack token', 'SLACK_TOKEN=xoxb-1234567890-1234567890-AbCdEfGh', 'slackToken'],
  ['Slack app token', 'SLACK_APP_TOKEN=xapp-1-1234567890-AbCdEfGhIjKlMnOp', 'slackToken'],
  [
    'decoded JWT',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123',
    'bearerToken',
  ],
  ['Bearer token', 'Bearer AbCdEfGhIjKlMnOpQrStUvWxYz123456', 'bearerToken'],
  ['PostgreSQL credentials', 'postgresql://admin:Summer2026!@prod-db.internal:5432/customer', 'databaseUrl'],
  ['Redis credentials', 'redis://default:VerySecret123!@cache.internal:6379/2', 'databaseUrl'],
  ['environment password', 'DATABASE_PASSWORD=Summer2026!', 'secretAssignment'],
  ['AWS secret assignment', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYAbCdEfGh', 'secretAssignment'],
  ['JSON password', '{"user":"sam","password":"Summer2026!"}', 'jsonSecret'],
  ['X-API-Key header', 'X-API-Key: AbCdEfGhIjKlMnOpQrStUvWx', 'httpHeader'],
  ['Cookie header', 'Cookie: session=AbCdEfGhIjKlMnOpQrSt', 'httpHeader'],
  ['email address', 'Contact john.smith@realcompany.com for access.', 'email'],
  ['phone number', 'Phone: (415) 867-5309', 'phoneNumber'],
  ['internal hostname', 'Connect to prod-db-03.company.internal.', 'internalHostname'],
] as const;

const SHOULD_NOT_DETECT = [
  ['normal security discussion', 'Please explain JWT authentication and API key rotation.'],
  ['token count', 'MAX_TOKEN_COUNT=4000'],
  ['password length', 'PASSWORD_LENGTH=16'],
  ['secret message', 'SECRET_MESSAGE="hello"'],
  ['token limit', 'TOKEN_LIMIT=8192'],
  ['angle placeholder', 'API_KEY=<YOUR_API_KEY>'],
  ['bracket placeholder', 'TOKEN=[REDACTED]'],
  ['replacement placeholder', 'CLIENT_SECRET=replace_me'],
  ['dummy placeholder', 'PASSWORD=dummy'],
  ['AWS documentation key', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE'],
  ['GitHub x placeholder', 'GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'],
  ['invalid random three-part text', 'abcdefgh.ijklmnop.qrstuvwx'],
  ['credential-free database URL', 'postgresql://localhost/mydb'],
  ['database URL without password', 'postgresql://demo@localhost/mydb'],
  ['UUID request id', 'REQUEST_ID=550e8400-e29b-41d4-a716-446655440000'],
  ['Git commit', 'GIT_COMMIT=0123456789abcdef0123456789abcdef01234567'],
  ['raw SHA-256', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['preference cookie', 'Cookie: theme=dark; language=en'],
  ['documentation email', 'user@example.com'],
  ['fictitious phone', 'Phone: 202-555-0101'],
  ['safe internal hostname', 'db.example.local'],
] as const;

describe('accuracy corpus', () => {
  it.each(SHOULD_DETECT)('SHOULD_DETECT: %s', (_label, text, detector) => {
    expect(scanText(text).some((finding) => finding.detector === detector)).toBe(true);
  });

  it.each(SHOULD_NOT_DETECT)('SHOULD_NOT_DETECT: %s', (_label, text) => {
    expect(scanText(text)).toEqual([]);
  });

  it('keeps severity and confidence as separate signals', () => {
    const [finding] = scanText('PASSWORD=Summer2026');
    expect(finding?.severity).toBe('high');
    expect(finding?.confidence).toBeGreaterThanOrEqual(0.6);
    expect(finding?.confidence).toBeLessThan(0.85);
  });

  it('does not suppress a complete real-looking value merely because it contains test', () => {
    expect(scanText('API_KEY=test_live_A8fK29mQ7zNp4XvB6cRt').length).toBeGreaterThan(0);
  });
});
