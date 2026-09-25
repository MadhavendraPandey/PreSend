import { browser } from 'wxt/browser';
import { CONFIG, debugLog } from './config';
import { getSettings, storageMessageTypes } from './storage';
import type {
  AllowlistEntry,
  ConfidenceLevel,
  DetectorName,
  FeedbackLabel,
  FeedbackRecord,
  Finding,
} from './types';

const feedbackRecordsKey = 'localFeedbackRecords';
const allowlistFingerprintsKey = 'localAllowlistFingerprints';
const fingerprintSaltKey = 'feedbackFingerprintSalt';

const detectorNames = new Set<DetectorName>([
  'privateKey',
  'awsKey',
  'githubToken',
  'openAiKey',
  'anthropicKey',
  'stripeKey',
  'slackToken',
  'bearerToken',
  'databaseUrl',
  'secretAssignment',
  'jsonSecret',
  'httpHeader',
  'email',
  'phoneNumber',
  'internalHostname',
  'semantic',
]);
const severityNames = new Set(['critical', 'high', 'medium', 'low']);
const confidenceNames = new Set<ConfidenceLevel>(['high', 'medium', 'low']);
const feedbackLabels = new Set<FeedbackLabel>(['correct', 'not-sensitive', 'wrong-category']);

export const feedbackCategoryOptions = [
  ['confidential_business', 'Business-sensitive information'],
  ['customer_confidential', 'Customer-specific information'],
  ['employee_sensitive', 'Employee-sensitive information'],
  ['financial_internal', 'Non-public financial information'],
  ['unreleased_product', 'Unreleased product information'],
  ['internal_security', 'Security-sensitive information'],
  ['legal_confidential', 'Legal-sensitive information'],
  ['proprietary_technical', 'Proprietary technical information'],
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAllowlistEntries(value: unknown): AllowlistEntry[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry): AllowlistEntry[] => {
    // v0.2 stored fingerprints as strings. Keep them effective until the
    // schema migration rewrites them with display-safe metadata.
    if (typeof entry === 'string' && /^[a-f0-9]{64}$/i.test(entry)) {
      return [{
        id: entry,
        fingerprint: entry,
        category: 'Previously allowlisted value',
        createdAt: 0,
      }];
    }
    if (
      !isRecord(entry) ||
      typeof entry.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(entry.fingerprint) ||
      typeof entry.category !== 'string' ||
      typeof entry.createdAt !== 'number' ||
      !Number.isFinite(entry.createdAt)
    ) {
      return [];
    }
    const detector = detectorNames.has(entry.detector as DetectorName)
      ? (entry.detector as DetectorName)
      : undefined;
    return [{
      id: entry.fingerprint,
      fingerprint: entry.fingerprint,
      ...(detector ? { detector } : {}),
      category: entry.category.slice(0, 80),
      createdAt: entry.createdAt,
    }];
  });
}

function normalizeFeedbackRecords(value: unknown): FeedbackRecord[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((record): FeedbackRecord[] => {
    if (
      !isRecord(record) ||
      typeof record.id !== 'string' ||
      !detectorNames.has(record.detector as DetectorName) ||
      typeof record.category !== 'string' ||
      !severityNames.has(record.severity as string) ||
      !confidenceNames.has(record.confidence as ConfidenceLevel) ||
      !feedbackLabels.has(record.feedbackLabel as FeedbackLabel) ||
      typeof record.timestamp !== 'number' ||
      !Number.isFinite(record.timestamp) ||
      typeof record.valueFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(record.valueFingerprint) ||
      !isRecord(record.features) ||
      !['signature', 'structured', 'contextual', 'semantic'].includes(String(record.features.source)) ||
      !['short', 'medium', 'long', 'very-long'].includes(
        String(record.features.lengthBucket),
      ) ||
      !['low', 'medium', 'high'].includes(String(record.features.entropyBucket)) ||
      typeof record.features.placeholderLike !== 'boolean' ||
      !Array.isArray(record.features.structures)
    ) {
      return [];
    }

    return [{
      id: record.id.slice(0, 200),
      detector: record.detector as DetectorName,
      category: record.category.slice(0, 80),
      severity: record.severity as FeedbackRecord['severity'],
      confidence: record.confidence as ConfidenceLevel,
      feedbackLabel: record.feedbackLabel as FeedbackLabel,
      timestamp: record.timestamp,
      valueFingerprint: record.valueFingerprint,
      features: {
        source: record.features.source as FeedbackRecord['features']['source'],
        lengthBucket: record.features.lengthBucket as FeedbackRecord['features']['lengthBucket'],
        entropyBucket: record.features.entropyBucket as FeedbackRecord['features']['entropyBucket'],
        placeholderLike: record.features.placeholderLike,
        structures: record.features.structures
          .filter((structure): structure is string => typeof structure === 'string')
          .map((structure) => structure.slice(0, 80))
          .slice(0, 20),
      },
    }];
  });
}

export function confidenceLevel(confidence: number): ConfidenceLevel {
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.6) return 'medium';
  return 'low';
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function getFingerprintSalt(): Promise<string> {
  const stored = await browser.storage.local.get(fingerprintSaltKey);
  const existingSalt = stored[fingerprintSaltKey];

  if (typeof existingSalt === 'string' && existingSalt.length >= 32) {
    return existingSalt;
  }

  const saltBytes = crypto.getRandomValues(new Uint8Array(24));
  const salt = bytesToHex(saltBytes);
  await browser.storage.local.set({ [fingerprintSaltKey]: salt });
  return salt;
}

export async function fingerprintValue(value: string, salt?: string): Promise<string> {
  const localSalt = salt ?? (await getFingerprintSalt());
  const encoded = new TextEncoder().encode(`${localSalt}\u0000${value}`);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return bytesToHex(new Uint8Array(digest));
}

export function createFeedbackRecord(
  finding: Finding,
  feedbackLabel: FeedbackLabel,
  valueFingerprint: string,
  timestamp = Date.now(),
): FeedbackRecord {
  return {
    id: `${timestamp}-${finding.id}-${feedbackLabel}`,
    detector: finding.detector,
    category: finding.category,
    severity: finding.severity,
    confidence: confidenceLevel(finding.confidence),
    feedbackLabel,
    timestamp,
    valueFingerprint,
    features: finding.features,
  };
}

export async function saveFindingFeedback(
  finding: Finding,
  feedbackLabel: FeedbackLabel,
  correctedLabels: string[] = [],
): Promise<void> {
  const valueFingerprint = await fingerprintValue(finding.originalValue);
  const record = createFeedbackRecord(finding, feedbackLabel, valueFingerprint);
  const stored = await browser.storage.local.get(feedbackRecordsKey);
  const existingRecords = normalizeFeedbackRecords(stored[feedbackRecordsKey]);
  const records = [...existingRecords, record].slice(-CONFIG.feedback.maxRecords);

  await browser.storage.local.set({ [feedbackRecordsKey]: records });
  debugLog('Feedback', 'Local feedback saved');
  void contributeFindingFeedback(finding, feedbackLabel, correctedLabels).catch(() => {
    debugLog('Feedback', 'Contribution dispatch failed; local feedback remains saved');
  });
}

function predictedLabel(finding: Finding): string {
  const semanticLabel = finding.features.structures.find((value) => value.startsWith('semantic:'));
  if (semanticLabel) return semanticLabel.slice('semantic:'.length);
  return finding.category.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export async function contributeFindingFeedback(
  finding: Finding,
  feedbackLabel: FeedbackLabel,
  correctedLabels: string[] = [],
): Promise<void> {
  const settings = await getSettings();
  if (!settings.feedbackContributionEnabled || !settings.feedbackContributionConsent) return;
  const label = predictedLabel(finding);
  const corrected = feedbackLabel === 'not-sensitive'
    ? ['public']
    : feedbackLabel === 'wrong-category'
      ? correctedLabels
      : [label];
  if (feedbackLabel === 'wrong-category' && corrected.length === 0) return;
  const payload = {
    text: finding.originalValue.slice(0, CONFIG.feedback.maxContributionTextCharacters),
    predicted_labels: [label],
    predicted_scores: { [label]: finding.confidence },
    feedback: feedbackLabel.replaceAll('-', '_') as 'correct' | 'not_sensitive' | 'wrong_category',
    corrected_labels: corrected,
    model_version: CONFIG.feedback.modelVersion,
    extension_version: browser.runtime.getManifest().version,
    created_at: new Date().toISOString(),
  };
  await browser.runtime.sendMessage({
    type: storageMessageTypes.submitFeedbackContribution,
    payload,
  });
}

export async function allowlistFinding(finding: Finding): Promise<AllowlistEntry> {
  const fingerprint = await fingerprintValue(finding.originalValue);
  const stored = await browser.storage.local.get(allowlistFingerprintsKey);
  const existingEntries = normalizeAllowlistEntries(stored[allowlistFingerprintsKey]);
  const existingEntry = existingEntries.find((entry) => entry.fingerprint === fingerprint);
  const entry: AllowlistEntry = existingEntry ?? {
    id: fingerprint,
    fingerprint,
    detector: finding.detector,
    category: finding.category,
    createdAt: Date.now(),
  };
  const entries = [
    ...existingEntries.filter((candidate) => candidate.fingerprint !== fingerprint),
    entry,
  ].slice(-CONFIG.feedback.maxAllowlistEntries);

  await browser.storage.local.set({ [allowlistFingerprintsKey]: entries });
  debugLog('Feedback', 'Exact-value fingerprint added to local allowlist');
  return entry;
}

export async function filterAllowlistedFindings(findings: Finding[]): Promise<Finding[]> {
  if (findings.length === 0) return [];

  const stored = await browser.storage.local.get(allowlistFingerprintsKey);
  const fingerprints = new Set(
    normalizeAllowlistEntries(stored[allowlistFingerprintsKey]).map(
      (entry) => entry.fingerprint,
    ),
  );

  if (fingerprints.size === 0) return findings;

  const candidateFingerprints = await Promise.all(
    findings.map((finding) => fingerprintValue(finding.originalValue)),
  );
  return findings.filter((_, index) => !fingerprints.has(candidateFingerprints[index] ?? ''));
}

export async function getFeedbackRecords(): Promise<FeedbackRecord[]> {
  const stored = await browser.storage.local.get(feedbackRecordsKey);
  return normalizeFeedbackRecords(stored[feedbackRecordsKey]).sort(
    (left, right) => right.timestamp - left.timestamp,
  );
}

export async function deleteFeedbackRecord(id: string): Promise<void> {
  const records = await getFeedbackRecords();
  await browser.storage.local.set({
    [feedbackRecordsKey]: records.filter((record) => record.id !== id),
  });
}

export async function clearFeedbackRecords(): Promise<void> {
  await browser.storage.local.remove(feedbackRecordsKey);
}

export async function getAllowlistEntries(): Promise<AllowlistEntry[]> {
  const stored = await browser.storage.local.get(allowlistFingerprintsKey);
  return normalizeAllowlistEntries(stored[allowlistFingerprintsKey]).sort(
    (left, right) => right.createdAt - left.createdAt,
  );
}

export function getAllowlistFingerprintPrefix(
  entry: AllowlistEntry,
  length = 10,
): string {
  return entry.fingerprint.slice(0, Math.max(4, Math.min(length, 64)));
}

export async function deleteAllowlistEntry(id: string): Promise<void> {
  const entries = await getAllowlistEntries();
  await browser.storage.local.set({
    [allowlistFingerprintsKey]: entries.filter(
      (entry) => entry.id !== id && entry.fingerprint !== id,
    ),
  });
}

export async function clearAllowlist(): Promise<void> {
  await browser.storage.local.remove(allowlistFingerprintsKey);
}

export async function resetFeedbackState(): Promise<void> {
  await browser.storage.local.remove([
    feedbackRecordsKey,
    allowlistFingerprintsKey,
    fingerprintSaltKey,
  ]);
}
