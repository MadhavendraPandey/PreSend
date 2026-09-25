import { browser } from 'wxt/browser';
import { getSettings } from './storage';
import type {
  ConfidenceLevel,
  Finding,
  HistoryAction,
  HistoryEvent,
  Severity,
  SiteId,
} from './types';

const historyEventsKey = 'historyEvents';
const maxHistoryEvents = 1_000;
const dayInMilliseconds = 24 * 60 * 60 * 1_000;

const siteIds = new Set<SiteId>([
  'chatgpt',
  'claude',
  'gemini',
  'perplexity',
  'deepseek',
  'grok',
]);
const actions = new Set<HistoryAction>([
  'redacted',
  'safe-example',
  'sent-anyway',
  'cancelled',
]);
const severities = new Set<Severity>(['critical', 'high', 'medium', 'low']);
const confidenceLevels = new Set<ConfidenceLevel>(['high', 'medium', 'low']);

export interface NewHistoryEvent {
  timestamp?: number;
  site: SiteId;
  categories: string[];
  severity: Severity;
  confidence: ConfidenceLevel;
  action: HistoryAction;
  findingCount?: number;
}

export interface HistoryFilters {
  site?: SiteId;
  action?: HistoryAction;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeHistoryEvent(value: unknown): HistoryEvent | null {
  if (!isRecord(value)) return null;
  const valid =
    typeof value.id === 'string' &&
    typeof value.timestamp === 'number' &&
    Number.isFinite(value.timestamp) &&
    siteIds.has(value.site as SiteId) &&
    Array.isArray(value.categories) &&
    value.categories.every((category) => typeof category === 'string') &&
    severities.has(value.severity as Severity) &&
    confidenceLevels.has(value.confidence as ConfidenceLevel) &&
    actions.has(value.action as HistoryAction) &&
    typeof value.findingCount === 'number' &&
    Number.isInteger(value.findingCount) &&
    value.findingCount > 0;
  if (!valid) return null;

  return {
    id: (value.id as string).slice(0, 200),
    timestamp: value.timestamp as number,
    site: value.site as SiteId,
    categories: sanitizeCategories(value.categories as string[]),
    severity: value.severity as Severity,
    confidence: value.confidence as ConfidenceLevel,
    action: value.action as HistoryAction,
    findingCount: value.findingCount as number,
  };
}

async function readHistoryEvents(): Promise<HistoryEvent[]> {
  const stored = await browser.storage.local.get(historyEventsKey);
  if (!Array.isArray(stored[historyEventsKey])) return [];
  return stored[historyEventsKey].flatMap((value): HistoryEvent[] => {
    const event = normalizeHistoryEvent(value);
    return event && event.categories.length > 0 ? [event] : [];
  });
}

function retainedEvents(
  events: HistoryEvent[],
  retentionDays: 7 | 30 | 90 | null,
  now: number,
): HistoryEvent[] {
  if (retentionDays === null) return events;
  const cutoff = now - retentionDays * dayInMilliseconds;
  return events.filter((event) => event.timestamp >= cutoff);
}

function sanitizeCategories(categories: string[]): string[] {
  return Array.from(
    new Set(
      categories
        .filter((category) => typeof category === 'string')
        .map((category) => category.trim())
        .filter(Boolean)
        .map((category) => category.slice(0, 80)),
    ),
  ).slice(0, 20);
}

function createEventId(timestamp: number): string {
  const suffix = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `history-${timestamp}-${suffix}`;
}

export async function cleanupHistory(now = Date.now()): Promise<HistoryEvent[]> {
  const settings = await getSettings();
  const current = await readHistoryEvents();
  if (settings.history.retentionDays === null) {
    return current.sort((left, right) => right.timestamp - left.timestamp);
  }

  const retained = retainedEvents(current, settings.history.retentionDays, now);
  if (retained.length !== current.length) {
    await browser.storage.local.set({ [historyEventsKey]: retained });
  }
  return retained.sort((left, right) => right.timestamp - left.timestamp);
}

export async function recordHistoryEvent(
  input: NewHistoryEvent,
): Promise<HistoryEvent | null> {
  const settings = await getSettings();
  if (!settings.history.enabled) return null;

  const now = Date.now();
  const timestamp = input.timestamp ?? now;
  const categories = sanitizeCategories(input.categories);
  if (
    !siteIds.has(input.site) ||
    !actions.has(input.action) ||
    !severities.has(input.severity) ||
    !confidenceLevels.has(input.confidence) ||
    !Number.isFinite(timestamp) ||
    categories.length === 0
  ) {
    return null;
  }

  // Construct an explicit allowlisted shape. Extra caller properties (prompt,
  // originalValue, previews, file contents) can never be spread into storage.
  const suppliedFindingCount = input.findingCount;
  const event: HistoryEvent = {
    id: createEventId(timestamp),
    timestamp,
    site: input.site,
    categories,
    severity: input.severity,
    confidence: input.confidence,
    action: input.action,
    findingCount:
      typeof suppliedFindingCount === 'number' && Number.isFinite(suppliedFindingCount)
        ? Math.max(1, Math.floor(suppliedFindingCount))
        : categories.length,
  };
  const current = await readHistoryEvents();
  const retained = retainedEvents(
    [...current, event],
    settings.history.retentionDays,
    now,
  );
  await browser.storage.local.set({
    [historyEventsKey]: retained.slice(-maxHistoryEvents),
  });
  return event;
}

function highestSeverity(findings: Finding[]): Severity {
  const rank: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
  return findings.reduce<Severity>(
    (highest, finding) => rank[finding.severity] > rank[highest] ? finding.severity : highest,
    'low',
  );
}

function highestConfidence(findings: Finding[]): ConfidenceLevel {
  const confidence = Math.max(...findings.map((finding) => finding.confidence));
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.6) return 'medium';
  return 'low';
}

export async function recordFindingsHistory(
  site: SiteId,
  findings: Finding[],
  action: HistoryAction,
  timestamp = Date.now(),
): Promise<HistoryEvent | null> {
  if (findings.length === 0) return null;
  return recordHistoryEvent({
    timestamp,
    site,
    categories: findings.map((finding) => finding.category),
    severity: highestSeverity(findings),
    confidence: highestConfidence(findings),
    action,
    findingCount: findings.length,
  });
}

export async function getHistoryEvents(filters: HistoryFilters = {}): Promise<HistoryEvent[]> {
  const events = await cleanupHistory();
  return events.filter(
    (event) =>
      (!filters.site || event.site === filters.site) &&
      (!filters.action || event.action === filters.action),
  );
}

export async function clearHistory(): Promise<void> {
  await browser.storage.local.remove(historyEventsKey);
}
