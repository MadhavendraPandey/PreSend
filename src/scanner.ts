import { CONFIG, debugLog } from './config';
import type {
  DetectorName,
  DetectorSettings,
  Finding,
  FindingFeatures,
  Severity,
} from './types';

type FindingDetails = Omit<Finding, 'id'>;

interface SensitiveKeyInfo {
  kind: 'api-key' | 'password' | 'secret' | 'token' | 'private-key';
  normalizedKey: string;
}

const severityRank: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const safeExampleJwt =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJzYWZlLWV4YW1wbGUtdXNlciIsImV4cCI6MH0.SAFE_EXAMPLE_SIGNATURE';

const exactPlaceholders = new Set([
  'example', 'example-key', 'sample', 'sample-key', 'dummy', 'dummy-key', 'fake',
  'fake-key', 'changeme', 'change-me', 'replace-me', 'placeholder', 'redacted',
  'token', 'your-api-key', 'your-key', 'your-secret', 'your-token', 'your-password',
  'insert-key-here', 'enter-key-here',
  'examplepassword123!',
  safeExampleJwt.toLowerCase(),
]);

const knownSafeProviderExamples = new Set([
  'AKIAIOSFODNN7EXAMPLE',
  'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
]);

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function unwrapPlaceholder(value: string): string {
  let normalized = value.trim().replace(/^`+|`+$/g, '');
  const wrappers: Array<[string, string]> = [
    ['<', '>'], ['[', ']'], ['{', '}'], ['"', '"'], ["'", "'"],
  ];

  for (const [start, end] of wrappers) {
    if (normalized.startsWith(start) && normalized.endsWith(end)) {
      normalized = normalized.slice(start.length, -end.length).trim();
      break;
    }
  }

  return normalized;
}

export function isLikelyPlaceholder(value: string, surroundingContext = ''): boolean {
  const normalized = unwrapPlaceholder(value).toLowerCase();
  const canonical = normalized.replace(/[\s_.]+/g, '-');

  if (!normalized || exactPlaceholders.has(normalized) || exactPlaceholders.has(canonical)) {
    return true;
  }
  if (/^x{4,}$/i.test(normalized) || /^\*{4,}$/.test(normalized)) return true;
  if (/^(?:gh[pousr]_|github_pat_|sk[-_][a-z0-9_-]*|xox[baprs]-)x{8,}$/i.test(normalized)) {
    return true;
  }
  if (/safe[-_ ]example|not[-_ ]a[-_ ]real|do[-_ ]not[-_ ]use/i.test(normalized)) return true;
  if (
    normalized === 'password123' &&
    /\b(?:example|sample|documentation|docs|placeholder)\b/i.test(surroundingContext)
  ) {
    return true;
  }

  return /^(?:your|sample|example|dummy|replace|insert|enter|put)[-_ ](?:api[-_ ])?(?:key|token|secret|password)(?:[-_ ]here)?$/.test(
    normalized,
  );
}

export function shannonEntropy(value: string): number {
  if (!value) return 0;
  const frequencies = new Map<string, number>();
  for (const character of value) {
    frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function lengthBucket(length: number): FindingFeatures['lengthBucket'] {
  if (length < 10) return 'short';
  if (length < 24) return 'medium';
  if (length < 64) return 'long';
  return 'very-long';
}

function entropyBucket(entropy: number): FindingFeatures['entropyBucket'] {
  if (entropy < 2.5) return 'low';
  if (entropy < 4) return 'medium';
  return 'high';
}

function featuresFor(
  value: string,
  source: FindingFeatures['source'],
  structures: string[],
  placeholderLike = false,
): FindingFeatures {
  return {
    source,
    lengthBucket: lengthBucket(value.length),
    entropyBucket: entropyBucket(shannonEntropy(value)),
    placeholderLike,
    structures,
  };
}

function maskValue(value: string, visibleStart = 3): string {
  const visible = value.slice(0, Math.min(visibleStart, value.length));
  return `${visible}••••••••`;
}

function surroundingText(text: string, startIndex: number, length: number): string {
  return text.slice(
    Math.max(0, startIndex - 60),
    Math.min(text.length, startIndex + length + 60),
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isCommonHash(value: string): boolean {
  return /^(?:[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}

function isDocumentationValue(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.example.com') || normalized.endsWith('.example.org') ||
    normalized.endsWith('.example.net') || normalized === 'example.com' ||
    normalized === 'example.org' || normalized === 'example.net' ||
    /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/.test(normalized) ||
    normalized.startsWith('2001:db8:')
  );
}

function findPrivateKeys(text: string): FindingDetails[] {
  const findings: FindingDetails[] = [];
  const pattern =
    /-----BEGIN ((?:RSA |EC )?PRIVATE KEY)-----[\s\S]*?-----END \1-----/g;

  for (const match of text.matchAll(pattern)) {
    const originalValue = match[0];
    if (isLikelyPlaceholder(originalValue)) continue;
    findings.push({
      detector: 'privateKey', category: 'Private key', severity: 'critical', confidence: 0.99,
      startIndex: match.index, endIndex: match.index + originalValue.length, originalValue,
      maskedPreview: `${originalValue.split(/\r?\n/, 1)[0]}\n••••••••`,
      replacementValue: '[PRIVATE_KEY_REDACTED]',
      safeExampleValue: '-----BEGIN PRIVATE KEY-----\nSAFE_EXAMPLE_NOT_A_REAL_KEY\n-----END PRIVATE KEY-----',
      explanation: 'Matches a PEM private-key block.',
      features: featuresFor(originalValue, 'signature', ['pem', 'private-key']),
    });
  }
  findings.push(...findMalformedPrivateKeys(text));
  return findings;
}

function findMalformedPrivateKeys(text: string): FindingDetails[] {
  const findings: FindingDetails[] = [];
  const beginPattern =
    /(^|\r?\n)(-{4,5})BEGIN[ \t]+((?:RSA[ \t]+|EC[ \t]+)?PRIVATE KEY)(-{4,5})[ \t]*(?:\r?\n|$)/g;

  for (const beginMatch of text.matchAll(beginPattern)) {
    const leadingNewline = beginMatch[1] ?? '';
    const beginLeftBoundary = beginMatch[2] ?? '';
    const beginLabel = (beginMatch[3] ?? '').replace(/\s+/g, ' ').trim();
    const beginRightBoundary = beginMatch[4] ?? '';
    const blockStart = beginMatch.index + leadingNewline.length;
    const bodyStart = beginMatch.index + beginMatch[0].length;
    const boundedRemainder = text.slice(bodyStart, bodyStart + 16_384);
    const endPattern =
      /(^|\r?\n)(-{4,5})END[ \t]+((?:RSA[ \t]+|EC[ \t]+)?PRIVATE KEY)(-{4,5})[ \t]*(?=\r?\n|$)/m;
    const endMatch = endPattern.exec(boundedRemainder);

    let body = '';
    let blockEnd = bodyStart;
    let confidence = 0.74;
    let explanation =
      'Appears to contain an incomplete PEM private-key block with a convincing encoded body.';
    const structures = ['pem', 'private-key', 'missing-footer'];

    if (endMatch) {
      body = boundedRemainder.slice(0, endMatch.index);
      blockEnd = bodyStart + endMatch.index + endMatch[0].length;
      const endLeftBoundary = endMatch[2] ?? '';
      const endLabel = (endMatch[3] ?? '').replace(/\s+/g, ' ').trim();
      const endRightBoundary = endMatch[4] ?? '';
      const hasExactBoundaries =
        beginLeftBoundary.length === 5 &&
        beginRightBoundary.length === 5 &&
        endLeftBoundary.length === 5 &&
        endRightBoundary.length === 5;
      const labelsMatch = beginLabel === endLabel;

      // The canonical detector already owns fully valid blocks.
      if (hasExactBoundaries && labelsMatch) continue;

      const compactBody = body.replace(/\s/g, '');
      const bodyLines = body.trim().split(/\r?\n/).filter(Boolean);
      const plausibleNearValidBody =
        compactBody.length >= 8 &&
        /^[A-Za-z0-9+/=_-]+$/.test(compactBody) &&
        bodyLines.every((line) => !/\s/.test(line));
      if (!plausibleNearValidBody) continue;

      confidence = labelsMatch ? 0.93 : 0.88;
      explanation = labelsMatch
        ? 'Appears to contain a PEM private-key block with a nearly valid but malformed boundary marker.'
        : 'Appears to contain a PEM private-key block whose BEGIN and END labels do not match.';
      structures.length = 0;
      structures.push('pem', 'private-key', labelsMatch ? 'malformed-boundary' : 'mismatched-labels');
    } else {
      const bodyMatch =
        /^([A-Za-z0-9+/=]{16,}(?:\r?\n[A-Za-z0-9+/=]{16,})*)/.exec(boundedRemainder);
      if (!bodyMatch) continue;

      body = bodyMatch[1] ?? '';
      const compactBody = body.replace(/\s/g, '');
      const bodyLines = body.split(/\r?\n/);
      const distinctCharacterCount = new Set(compactBody).size;
      const convincingIncompleteBody =
        compactBody.length >= 64 &&
        distinctCharacterCount >= 8 &&
        (bodyLines.length >= 2 || compactBody.length >= 96);
      if (!convincingIncompleteBody) continue;

      blockEnd = bodyStart + body.length;
    }

    const originalValue = text.slice(blockStart, blockEnd);
    if (isLikelyPlaceholder(originalValue)) continue;

    findings.push({
      detector: 'privateKey',
      category: 'Private key',
      severity: 'critical',
      confidence,
      startIndex: blockStart,
      endIndex: blockEnd,
      originalValue,
      maskedPreview: `${text.slice(blockStart, bodyStart).trim()}\n••••••••`,
      replacementValue: '[PRIVATE_KEY_REDACTED]',
      safeExampleValue:
        '-----BEGIN PRIVATE KEY-----\nSAFE_EXAMPLE_NOT_A_REAL_KEY\n-----END PRIVATE KEY-----',
      explanation,
      features: featuresFor(originalValue, 'structured', structures),
    });
  }

  return findings;
}

function signatureFindings(
  text: string,
  pattern: RegExp,
  details: {
    detector: DetectorName; category: string; severity: Severity; confidence: number;
    prefixLength: number; replacementValue: string; safeExampleValue: string;
    explanation: string; structure: string;
  },
): FindingDetails[] {
  const findings: FindingDetails[] = [];
  for (const match of text.matchAll(pattern)) {
    const originalValue = match[0];
    if (
      knownSafeProviderExamples.has(originalValue) ||
      isLikelyPlaceholder(originalValue, surroundingText(text, match.index, originalValue.length))
    ) {
      continue;
    }
    findings.push({
      detector: details.detector, category: details.category, severity: details.severity,
      confidence: details.confidence, startIndex: match.index,
      endIndex: match.index + originalValue.length, originalValue,
      maskedPreview: maskValue(originalValue, details.prefixLength),
      replacementValue: details.replacementValue, safeExampleValue: details.safeExampleValue,
      explanation: details.explanation,
      features: featuresFor(originalValue, 'signature', [details.structure]),
    });
  }
  return findings;
}

function findProviderCredentials(text: string): FindingDetails[] {
  return [
    ...signatureFindings(text, /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g, {
      detector: 'awsKey', category: 'AWS access key', severity: 'critical', confidence: 0.98,
      prefixLength: 4, replacementValue: '[AWS_ACCESS_KEY_REDACTED]',
      safeExampleValue: 'AKIAIOSFODNN7EXAMPLE',
      explanation: 'Matches the prefix, length, and character structure of an AWS access key ID.',
      structure: 'aws-access-key',
    }),
    ...signatureFindings(text, /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,255})\b/g, {
      detector: 'githubToken', category: 'GitHub token', severity: 'critical', confidence: 0.97,
      prefixLength: 4, replacementValue: '[GITHUB_TOKEN_REDACTED]',
      safeExampleValue: 'ghp_SAFE_EXAMPLE_NOT_A_REAL_TOKEN',
      explanation: 'Looks like a GitHub personal or fine-grained access token.', structure: 'github-token',
    }),
    ...signatureFindings(text, /\bsk-ant-(?:api\d{2}-)?[A-Za-z0-9_-]{20,}\b/g, {
      detector: 'anthropicKey', category: 'Anthropic API key', severity: 'critical', confidence: 0.96,
      prefixLength: 7, replacementValue: '[ANTHROPIC_API_KEY_REDACTED]',
      safeExampleValue: 'sk-ant-api03-SAFE_EXAMPLE_NOT_A_REAL_KEY',
      explanation: 'Matches an Anthropic-style API-key prefix and token structure.',
      structure: 'anthropic-api-key',
    }),
    ...signatureFindings(text, /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, {
      detector: 'stripeKey', category: 'Stripe secret key', severity: 'critical', confidence: 0.96,
      prefixLength: 8, replacementValue: '[STRIPE_SECRET_KEY_REDACTED]',
      safeExampleValue: 'sk_test_SAFE_EXAMPLE_NOT_A_REAL_KEY',
      explanation: 'Matches a Stripe secret or restricted key prefix and token structure.',
      structure: 'stripe-secret-key',
    }),
    ...signatureFindings(text, /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, {
      detector: 'slackToken', category: 'Slack token', severity: 'high', confidence: 0.95,
      prefixLength: 5, replacementValue: '[SLACK_TOKEN_REDACTED]',
      safeExampleValue: 'xoxb-SAFE-EXAMPLE-NOT-A-REAL-TOKEN',
      explanation: 'Matches a Slack token prefix and expected token structure.', structure: 'slack-token',
    }),
    ...signatureFindings(text, /\bxapp-\d-[A-Za-z0-9-]{20,}\b/g, {
      detector: 'slackToken', category: 'Slack app token', severity: 'high', confidence: 0.93,
      prefixLength: 7, replacementValue: '[SLACK_TOKEN_REDACTED]',
      safeExampleValue: 'xapp-1-SAFE-EXAMPLE-NOT-A-REAL-TOKEN',
      explanation: 'Matches a Slack app-level token prefix and expected token structure.',
      structure: 'slack-app-token',
    }),
    ...signatureFindings(text, /\b(?:sk-proj-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,})\b/g, {
      detector: 'openAiKey', category: 'OpenAI API key', severity: 'critical', confidence: 0.94,
      prefixLength: 7, replacementValue: '[OPENAI_API_KEY_REDACTED]',
      safeExampleValue: 'sk-proj-SAFE_EXAMPLE_NOT_A_REAL_KEY',
      explanation: 'Matches an OpenAI-style API-key prefix, length, and character structure.',
      structure: 'openai-api-key',
    }),
  ];
}

function decodeJwtPart(part: string): unknown | null {
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function findJwtTokens(text: string): FindingDetails[] {
  const findings: FindingDetails[] = [];
  const pattern = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
  for (const match of text.matchAll(pattern)) {
    const originalValue = match[0];
    const parts = originalValue.split('.');
    const header = parts[0] ? decodeJwtPart(parts[0]) : null;
    const payload = parts[1] ? decodeJwtPart(parts[1]) : null;
    const validHeader = typeof header === 'object' && header !== null && !Array.isArray(header);
    const validPayload = typeof payload === 'object' && payload !== null && !Array.isArray(payload);
    const context = surroundingText(text, match.index, originalValue.length);
    const hasJwtContext = /\b(?:jwt|bearer|authorization|access[_ -]?token|id[_ -]?token)\b/i.test(context);

    if (!validHeader && !validPayload && !hasJwtContext) continue;
    if (isLikelyPlaceholder(originalValue, context)) continue;

    const confidence = validHeader && validPayload ? 0.98 : validHeader || validPayload ? 0.72 : 0.52;
    findings.push({
      detector: 'bearerToken', category: 'JWT token', severity: 'high', confidence,
      startIndex: match.index, endIndex: match.index + originalValue.length, originalValue,
      maskedPreview: `JWT ${maskValue(originalValue)}`, replacementValue: '[TOKEN_REDACTED]',
      safeExampleValue: safeExampleJwt,
      explanation: validHeader && validPayload
        ? 'JWT-like value has three Base64URL sections and decodable JSON header and payload.'
        : 'Value has three JWT-like sections in token-related context, but only part of it decoded as JSON.',
      features: featuresFor(originalValue, 'structured', [
        'jwt', validHeader ? 'decoded-header' : 'invalid-header',
        validPayload ? 'decoded-payload' : 'invalid-payload',
      ]),
    });
  }
  return findings;
}

function addBearerFinding(
  findings: FindingDetails[], text: string, token: string, startIndex: number, structure: string,
): void {
  const context = surroundingText(text, startIndex, token.length);
  if (token.length < 16 || isLikelyPlaceholder(token, context)) return;
  const confidence = clamp(
    0.68 + (token.length >= 24 ? 0.1 : 0) + (shannonEntropy(token) >= 3 ? 0.08 : 0),
    0,
    0.92,
  );
  findings.push({
    detector: 'bearerToken', category: 'Bearer token', severity: 'high', confidence,
    startIndex, endIndex: startIndex + token.length, originalValue: token,
    maskedPreview: `Bearer ${maskValue(token)}`, replacementValue: '[TOKEN_REDACTED]',
    safeExampleValue: 'SAFE_EXAMPLE_BEARER_TOKEN_NOT_REAL',
    explanation: 'Value is used as a Bearer authorization token and has a plausible token structure.',
    features: featuresFor(token, 'structured', [structure, 'bearer']),
  });
}

function findHttpHeaders(text: string): FindingDetails[] {
  const findings: FindingDetails[] = [];
  const headerPattern = /^\s*(Authorization|X-API-Key|Cookie)\s*:\s*(.+?)\s*$/gim;
  for (const match of text.matchAll(headerPattern)) {
    const headerName = match[1]?.toLowerCase();
    const headerValue = match[2]?.trim();
    if (!headerName || !headerValue) continue;
    const valueOffset = match[0].lastIndexOf(headerValue);
    const valueStart = match.index + valueOffset;

    if (headerName === 'authorization') {
      const token = /^Bearer\s+(.+)$/i.exec(headerValue)?.[1]?.trim();
      if (token) {
        addBearerFinding(findings, text, token, valueStart + headerValue.lastIndexOf(token), 'authorization-header');
      }
      continue;
    }
    if (isLikelyPlaceholder(headerValue, match[0]) || headerValue.length < 8) continue;

    if (headerName === 'cookie') {
      const cookiePairs = headerValue.split(';').map((part) => part.trim());
      const hasSensitiveCookieName = cookiePairs.some((pair) =>
        /^(?:session|sessionid|sid|auth|authorization|token|jwt|access_token|refresh_token|csrf)=/i.test(
          pair,
        ),
      );
      const hasStrongCookieValue = cookiePairs.some((pair) => {
        const value = pair.slice(pair.indexOf('=') + 1);
        return pair.includes('=') && value.length >= 20 && shannonEntropy(value) >= 3;
      });
      if (!hasSensitiveCookieName && !hasStrongCookieValue) continue;
    }

    findings.push({
      detector: 'httpHeader',
      category: headerName === 'cookie' ? 'Session cookie' : 'HTTP API key',
      severity: 'high', confidence: headerName === 'cookie' ? 0.84 : 0.91,
      startIndex: valueStart, endIndex: valueStart + headerValue.length, originalValue: headerValue,
      maskedPreview: `${match[1]}: ${maskValue(headerValue, 0)}`,
      replacementValue: headerName === 'cookie' ? '[COOKIE_REDACTED]' : '[API_KEY_REDACTED]',
      safeExampleValue: headerName === 'cookie'
        ? 'session=SAFE_EXAMPLE_COOKIE_NOT_REAL' : 'SAFE_EXAMPLE_API_KEY_NOT_REAL',
      explanation: headerName === 'cookie'
        ? 'Cookie header contains session-like data that may authenticate a browser session.'
        : 'Value is supplied through an X-API-Key HTTP header.',
      features: featuresFor(headerValue, 'structured', ['http-header', headerName]),
    });
  }

  for (const match of text.matchAll(/\bBearer\s+([A-Za-z0-9._~+/=-]{16,})/gi)) {
    const token = match[1];
    if (!token) continue;
    addBearerFinding(findings, text, token, match.index + match[0].lastIndexOf(token), 'bearer-expression');
  }
  return findings;
}

function findDatabaseUrls(text: string): FindingDetails[] {
  const findings: FindingDetails[] = [];
  const candidatePattern = /\b(?:postgresql|postgres|mysql|mongodb(?:\+srv)?|redis|rediss):\/\/[^\s'"<>]+/gi;
  for (const match of text.matchAll(candidatePattern)) {
    const originalValue = match[0].replace(/[),.;]+$/, '');
    let parsed: URL | null = null;
    try {
      parsed = new URL(originalValue);
    } catch {
      // A conservative fallback below handles clear username:password@ evidence.
    }

    if (parsed?.username && parsed.password) {
      const context = surroundingText(text, match.index, originalValue.length);
      let decodedPassword = parsed.password;
      try {
        decodedPassword = decodeURIComponent(parsed.password);
      } catch {
        // Keep the encoded form for placeholder checks if percent-decoding is malformed.
      }
      if (isLikelyPlaceholder(decodedPassword, context)) continue;

      const scheme = parsed.protocol.slice(0, -1);
      const port = parsed.port ? `:${parsed.port}` : '';
      const safePath = scheme.startsWith('redis') ? '/0' : '/sample_db';
      const maskedPath = parsed.pathname && parsed.pathname !== '/' ? '/[DATABASE]' : '';
      findings.push({
        detector: 'databaseUrl', category: 'Database credential', severity: 'critical', confidence: 0.98,
        startIndex: match.index, endIndex: match.index + originalValue.length, originalValue,
        maskedPreview: `${scheme}://[USER]:••••••••@[HOST]${port}${maskedPath}`,
        replacementValue: `${scheme}://[USER]:[PASSWORD]@[HOST]${port}${parsed.pathname}`,
        safeExampleValue: `${scheme}://demo_user:ExamplePassword123!@db.example.local${port}${safePath}`,
        explanation: 'Database URL contains embedded username and password.',
        features: featuresFor(originalValue, 'structured', [
          'database-url', `scheme:${scheme}`, parsed.port ? 'explicit-port' : 'default-port',
        ]),
      });
      continue;
    }

    const malformedParts =
      /^(postgresql|postgres|mysql|mongodb(?:\+srv)?|redis|rediss):\/\/([^:@/?#\s]+):([^@/?#\s]{4,})@(.*)$/i.exec(
        originalValue,
      );
    const scheme = malformedParts?.[1]?.toLowerCase();
    const username = malformedParts?.[2];
    const password = malformedParts?.[3];
    const hostRemainder = malformedParts?.[4] ?? '';
    if (!scheme || !username || !password) continue;

    const context = surroundingText(text, match.index, originalValue.length);
    if (isLikelyPlaceholder(password, context)) continue;

    const hasHostMaterial = hostRemainder.length > 0;
    const confidence = hasHostMaterial ? 0.89 : password.length >= 8 ? 0.78 : 0.7;
    findings.push({
      detector: 'databaseUrl',
      category: 'Database credential',
      severity: 'critical',
      confidence,
      startIndex: match.index,
      endIndex: match.index + originalValue.length,
      originalValue,
      maskedPreview: `${scheme}://[USER]:••••••••@[${hasHostMaterial ? 'MALFORMED HOST' : 'MISSING HOST'}]`,
      replacementValue: `${scheme}://[USER]:[PASSWORD]@[HOST]`,
      safeExampleValue: `${scheme}://demo_user:ExamplePassword123!@db.example.local/sample_db`,
      explanation:
        'Value appears to contain embedded database credentials, but the database URL is incomplete or malformed.',
      features: featuresFor(originalValue, 'structured', [
        'database-url',
        'malformed-url',
        `scheme:${scheme}`,
        hasHostMaterial ? 'invalid-host' : 'missing-host',
      ]),
    });
  }
  return findings;
}

function normalizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[.\-\s]+/g, '_')
    .replace(/_+/g, '_').toLowerCase();
}

function classifySensitiveKey(key: string): SensitiveKeyInfo | null {
  const normalizedKey = normalizeKey(key);
  if (
    /(?:^|_)(?:count|limit|length|size|type|name|message|algorithm|format|timeout|ttl|max|min)(?:_|$)/.test(normalizedKey) ||
    /^(?:max|min)_/.test(normalizedKey) ||
    /(?:public_key|tokenizer|tokenization|secret_message)/.test(normalizedKey)
  ) return null;
  if (/(?:^|_)(?:password|passwd|passphrase)$/.test(normalizedKey)) return { kind: 'password', normalizedKey };
  if (/(?:^|_)(?:api_key|apikey)$/.test(normalizedKey)) return { kind: 'api-key', normalizedKey };
  if (/(?:^|_)(?:access_token|refresh_token|id_token|auth_token|token)$/.test(normalizedKey)) return { kind: 'token', normalizedKey };
  if (/(?:^|_)(?:client_secret|app_secret|secret|secret_key)$/.test(normalizedKey)) return { kind: 'secret', normalizedKey };
  if (/(?:^|_)(?:aws_secret_access_key|secret_access_key)$/.test(normalizedKey)) {
    return { kind: 'secret', normalizedKey };
  }
  if (/(?:^|_)private_key$/.test(normalizedKey)) return { kind: 'private-key', normalizedKey };
  return null;
}

function characterClassCount(value: string): number {
  return [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(value)).length;
}

function safeExampleForKey(keyInfo: SensitiveKeyInfo): string {
  if (keyInfo.kind === 'password') return 'ExamplePassword123!';
  if (keyInfo.kind === 'api-key') return 'SAFE_EXAMPLE_API_KEY_NOT_REAL';
  if (keyInfo.kind === 'token') return 'SAFE_EXAMPLE_TOKEN_NOT_REAL';
  if (keyInfo.kind === 'private-key') return 'SAFE_EXAMPLE_PRIVATE_KEY_NOT_REAL';
  return 'safe_example_secret_not_real';
}

function categoryForKey(keyInfo: SensitiveKeyInfo): string {
  if (keyInfo.kind === 'password') return 'Password';
  if (keyInfo.kind === 'api-key') return 'API key';
  if (keyInfo.kind === 'token') return 'Access token';
  if (keyInfo.kind === 'private-key') return 'Private key value';
  return 'Assigned secret';
}

function buildGenericSecretFinding(
  text: string, key: string, logicalValue: string, originalValue: string, startIndex: number,
  detector: 'secretAssignment' | 'jsonSecret', structure: 'assignment' | 'json',
): FindingDetails | null {
  const keyInfo = classifySensitiveKey(key);
  if (!keyInfo) return null;
  const context = surroundingText(text, startIndex, originalValue.length);
  if (isLikelyPlaceholder(logicalValue, context)) return null;
  if (logicalValue.length < 6 || /^(?:true|false|null|undefined|\d+)$/i.test(logicalValue)) return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(logicalValue)) {
    try {
      const parsed = new URL(logicalValue);
      if (!parsed.password) return null;
    } catch {
      // A malformed URL in a sensitive variable is evaluated like any other value.
    }
  }

  const entropy = shannonEntropy(logicalValue);
  let confidence = keyInfo.kind === 'password' ? 0.61 : 0.58;
  if (logicalValue.length >= 10) confidence += 0.05;
  if (logicalValue.length >= 20) confidence += 0.08;
  if (entropy >= 3) confidence += 0.07;
  if (entropy >= 4) confidence += 0.06;
  if (characterClassCount(logicalValue) >= 3) confidence += 0.06;
  if (isUuid(logicalValue)) confidence -= 0.12;
  if (isCommonHash(logicalValue)) confidence -= 0.16;
  if (isDocumentationValue(logicalValue)) confidence -= 0.3;
  confidence = clamp(confidence, 0.45, 0.9);
  if (confidence < 0.5) return null;

  const uppercaseKey = keyInfo.normalizedKey.toUpperCase();
  return {
    detector, category: categoryForKey(keyInfo),
    severity: keyInfo.kind === 'private-key' ? 'critical' : 'high', confidence,
    startIndex, endIndex: startIndex + originalValue.length, originalValue,
    maskedPreview: `${uppercaseKey}=${maskValue(logicalValue, 0)}`,
    replacementValue: `[${uppercaseKey}_REDACTED]`, safeExampleValue: safeExampleForKey(keyInfo),
    explanation: `Value is assigned to a sensitive ${keyInfo.kind.replace('-', ' ')} field and has plausible secret characteristics.`,
    features: featuresFor(logicalValue, 'structured', [structure, `key:${keyInfo.kind}`]),
  };
}

function findEnvironmentAssignments(text: string): FindingDetails[] {
  const findings: FindingDetails[] = [];
  const pattern = /\b([A-Za-z_][A-Za-z0-9_.-]{1,63})\s*(?:=|:)\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,;]+))/g;
  for (const match of text.matchAll(pattern)) {
    const key = match[1];
    const value = match[2] ?? match[3] ?? match[4];
    if (!key || value === undefined) continue;
    const valueOffset = match[0].lastIndexOf(value);
    const finding = buildGenericSecretFinding(
      text, key, value, value, match.index + valueOffset, 'secretAssignment', 'assignment',
    );
    if (finding) findings.push(finding);
  }
  return findings;
}

function inspectJsonRegion(text: string, jsonText: string, regionStart: number): FindingDetails[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }

  const findings: FindingDetails[] = [];
  let searchCursor = regionStart;
  const regionEnd = regionStart + jsonText.length;
  const visit = (value: unknown, key = ''): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [childKey, childValue] of Object.entries(value)) visit(childValue, childKey);
      return;
    }
    if (typeof value !== 'string' || !key) return;
    const serializedValue = JSON.stringify(value);
    const literalIndex = text.indexOf(serializedValue, searchCursor);
    if (literalIndex < regionStart || literalIndex >= regionEnd) return;
    searchCursor = literalIndex + serializedValue.length;
    const originalValue = serializedValue.slice(1, -1);
    const finding = buildGenericSecretFinding(
      text, key, value, originalValue, literalIndex + 1, 'jsonSecret', 'json',
    );
    if (finding) findings.push(finding);
  };
  visit(parsed);
  return findings;
}

function findJsonSecrets(text: string): FindingDetails[] {
  const findings: FindingDetails[] = [];
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    findings.push(...inspectJsonRegion(text, trimmed, text.indexOf(trimmed)));
  }
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const region = match[1]?.trim();
    if (!region) continue;
    findings.push(...inspectJsonRegion(text, region, match.index + match[0].indexOf(region)));
  }
  return findings;
}

function findEmails(text: string): FindingDetails[] {
  const findings: FindingDetails[] = [];
  for (const match of text.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) {
    const originalValue = match[0];
    const domain = originalValue.split('@')[1]?.toLowerCase() ?? '';
    if (isDocumentationValue(domain) || domain.endsWith('.invalid')) continue;
    findings.push({
      detector: 'email', category: 'Email address', severity: 'medium', confidence: 0.92,
      startIndex: match.index, endIndex: match.index + originalValue.length, originalValue,
      maskedPreview: 'u••••@••••.•••', replacementValue: '[EMAIL_REDACTED]',
      safeExampleValue: 'user@example.com',
      explanation: 'Matches the structure of a personal or organizational email address.',
      features: featuresFor(originalValue, 'structured', ['email-address']),
    });
  }
  return findings;
}

function findPhoneNumbers(text: string): FindingDetails[] {
  const findings: FindingDetails[] = [];
  const pattern = /(?:\+\d{1,3}[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]\d{3}[ .-]\d{4}\b/g;
  for (const match of text.matchAll(pattern)) {
    const originalValue = match[0];
    const digits = originalValue.replace(/\D/g, '');
    const context = surroundingText(text, match.index, originalValue.length);
    const explicitPhoneContext = /\b(?:phone|mobile|telephone|tel|call|contact)\b/i.test(context);
    const internationalFormat = originalValue.trim().startsWith('+');
    const knownFictitiousNumber = /20255501\d{2}$/.test(digits) || /555010\d$/.test(digits);
    if (digits.length < 10 || digits.length > 15 || knownFictitiousNumber) continue;
    if (!explicitPhoneContext && !internationalFormat && !originalValue.includes('(')) continue;
    findings.push({
      detector: 'phoneNumber', category: 'Phone number', severity: 'medium',
      confidence: explicitPhoneContext ? 0.88 : 0.72,
      startIndex: match.index, endIndex: match.index + originalValue.length, originalValue,
      maskedPreview: '•••-•••-••••', replacementValue: '[PHONE_REDACTED]',
      safeExampleValue: '202-555-0100',
      explanation: 'Number has a phone-number format and appears in contact-related context.',
      features: featuresFor(originalValue, 'contextual', ['phone-number']),
    });
  }
  return findings;
}

function findInternalHostnames(text: string): FindingDetails[] {
  const findings: FindingDetails[] = [];
  const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
  const pattern = new RegExp(`\\b(?:${label}\\.)+(?:internal|corp|lan)\\b`, 'gi');
  for (const match of text.matchAll(pattern)) {
    const originalValue = match[0];
    if (/\bexample\b/i.test(originalValue)) continue;
    findings.push({
      detector: 'internalHostname', category: 'Internal hostname', severity: 'low', confidence: 0.9,
      startIndex: match.index, endIndex: match.index + originalValue.length, originalValue,
      maskedPreview: '[INTERNAL HOSTNAME]', replacementValue: '[INTERNAL_HOSTNAME_REDACTED]',
      safeExampleValue: 'db.example.local',
      explanation: 'Hostname uses a namespace commonly reserved for internal infrastructure.',
      features: featuresFor(originalValue, 'signature', ['internal-hostname']),
    });
  }
  return findings;
}

export function resolveOverlappingFindings(findings: Finding[]): Finding[] {
  const preferred = [...findings].sort((left, right) => {
    const severityDifference = severityRank[right.severity] - severityRank[left.severity];
    if (severityDifference !== 0) return severityDifference;
    const confidenceDifference = right.confidence - left.confidence;
    if (confidenceDifference !== 0) return confidenceDifference;
    return right.endIndex - right.startIndex - (left.endIndex - left.startIndex);
  });
  interface IntervalNode {
    finding: Finding;
    priority: number;
    maxEnd: number;
    left: IntervalNode | null;
    right: IntervalNode | null;
  }

  let prioritySeed = 0x6d2b79f5;
  const nextPriority = () => {
    prioritySeed ^= prioritySeed << 13;
    prioritySeed ^= prioritySeed >>> 17;
    prioritySeed ^= prioritySeed << 5;
    return prioritySeed >>> 0;
  };
  const updateMaxEnd = (node: IntervalNode) => {
    node.maxEnd = Math.max(
      node.finding.endIndex,
      node.left?.maxEnd ?? Number.NEGATIVE_INFINITY,
      node.right?.maxEnd ?? Number.NEGATIVE_INFINITY,
    );
  };
  const rotateRight = (node: IntervalNode): IntervalNode => {
    const nextRoot = node.left!;
    node.left = nextRoot.right;
    nextRoot.right = node;
    updateMaxEnd(node);
    updateMaxEnd(nextRoot);
    return nextRoot;
  };
  const rotateLeft = (node: IntervalNode): IntervalNode => {
    const nextRoot = node.right!;
    node.right = nextRoot.left;
    nextRoot.left = node;
    updateMaxEnd(node);
    updateMaxEnd(nextRoot);
    return nextRoot;
  };
  const insert = (node: IntervalNode | null, finding: Finding): IntervalNode => {
    if (!node) {
      return {
        finding,
        priority: nextPriority(),
        maxEnd: finding.endIndex,
        left: null,
        right: null,
      };
    }
    if (finding.startIndex < node.finding.startIndex) {
      node.left = insert(node.left, finding);
      if (node.left.priority < node.priority) node = rotateRight(node);
    } else {
      node.right = insert(node.right, finding);
      if (node.right.priority < node.priority) node = rotateLeft(node);
    }
    updateMaxEnd(node);
    return node;
  };
  const overlaps = (node: IntervalNode | null, finding: Finding): boolean => {
    if (!node || node.maxEnd <= finding.startIndex) return false;
    if (node.left && node.left.maxEnd > finding.startIndex && overlaps(node.left, finding)) {
      return true;
    }
    if (
      finding.startIndex < node.finding.endIndex &&
      finding.endIndex > node.finding.startIndex
    ) {
      return true;
    }
    if (node.finding.startIndex >= finding.endIndex) return false;
    return overlaps(node.right, finding);
  };

  let root: IntervalNode | null = null;
  for (const candidate of preferred) {
    if (!overlaps(root, candidate)) root = insert(root, candidate);
  }

  const accepted: Finding[] = [];
  const appendInOrder = (node: IntervalNode | null): void => {
    if (!node) return;
    appendInOrder(node.left);
    accepted.push(node.finding);
    appendInOrder(node.right);
  };
  appendInOrder(root);
  return accepted;
}

export function scanText(text: string, settings?: DetectorSettings): Finding[] {
  if (!text) return [];
  const rawFindings: FindingDetails[] = [];
  const credentialsEnabled = settings?.credentials ?? true;
  const privateKeysEnabled = settings?.privateKeys ?? true;
  const databaseCredentialsEnabled = settings?.databaseCredentials ?? true;
  const emailsEnabled = settings?.emails ?? true;
  const phoneNumbersEnabled = settings?.phoneNumbers ?? true;
  const internalHostsEnabled = settings?.internalHosts ?? true;

  if (CONFIG.detectors.privateKey && privateKeysEnabled) rawFindings.push(...findPrivateKeys(text));
  if ((CONFIG.detectors.awsKey || CONFIG.detectors.providerTokens) && credentialsEnabled) {
    rawFindings.push(...findProviderCredentials(text));
  }
  if (CONFIG.detectors.bearerToken && credentialsEnabled) rawFindings.push(...findJwtTokens(text));
  if ((CONFIG.detectors.httpHeaders || CONFIG.detectors.bearerToken) && credentialsEnabled) {
    rawFindings.push(...findHttpHeaders(text));
  }
  if (CONFIG.detectors.databaseUrl && databaseCredentialsEnabled) {
    rawFindings.push(...findDatabaseUrls(text));
  }
  if (CONFIG.detectors.structuredJson && credentialsEnabled) rawFindings.push(...findJsonSecrets(text));
  if (CONFIG.detectors.secretAssignment && credentialsEnabled) {
    rawFindings.push(...findEnvironmentAssignments(text));
  }
  if (CONFIG.detectors.personalData && emailsEnabled) rawFindings.push(...findEmails(text));
  if (CONFIG.detectors.personalData && phoneNumbersEnabled) rawFindings.push(...findPhoneNumbers(text));
  if (CONFIG.detectors.internalHostnames && internalHostsEnabled) {
    rawFindings.push(...findInternalHostnames(text));
  }

  const findings = rawFindings.map((finding, index) => ({
    id: `${finding.detector}-${finding.startIndex}-${index}`,
    ...finding,
  }));
  const resolvedFindings = resolveOverlappingFindings(findings);
  debugLog('Scanner', `Scan completed with ${resolvedFindings.length} findings`);
  return resolvedFindings;
}
