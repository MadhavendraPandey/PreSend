import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageState = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storageState.values[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(storageState.values, values);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storageState.values[key];
        }),
        clear: vi.fn(async () => {
          storageState.values = {};
        }),
      },
    },
  },
}));

import {
  cleanupHistory,
  clearHistory,
  getHistoryEvents,
  recordFindingsHistory,
  recordHistoryEvent,
} from '../src/history';
import { DEFAULT_SETTINGS } from '../src/storage';
import type { NewHistoryEvent } from '../src/history';
import type { HistoryAction } from '../src/types';
import { scanText } from '../src/scanner';

function enableHistory(retentionDays: 7 | 30 | 90 | null = 30): void {
  storageState.values.settings = {
    ...DEFAULT_SETTINGS,
    sites: { ...DEFAULT_SETTINGS.sites },
    detectors: { ...DEFAULT_SETTINGS.detectors },
    history: { enabled: true, retentionDays },
  };
}

describe('metadata-only local history', () => {
  beforeEach(() => {
    storageState.values = {};
  });

  it('is off by default and does not create hidden history', async () => {
    const result = await recordHistoryEvent({
      site: 'chatgpt',
      categories: ['Private key'],
      severity: 'critical',
      confidence: 'high',
      action: 'cancelled',
    });

    expect(result).toBeNull();
    expect(storageState.values.historyEvents).toBeUndefined();
  });

  it.each<HistoryAction>([
    'redacted',
    'safe-example',
    'sent-anyway',
    'cancelled',
  ])('stores only allowlisted metadata for the %s action', async (action) => {
    enableHistory();
    const rawSecret = 'sk-proj-raw-secret-that-must-not-be-stored';
    const input: NewHistoryEvent & Record<string, unknown> = {
      site: 'claude',
      categories: ['OpenAI API key', 'OpenAI API key'],
      severity: 'critical',
      confidence: 'high',
      action,
      findingCount: 2,
      prompt: `send ${rawSecret}`,
      originalValue: rawSecret,
      sanitizedPreview: '[REDACTED]',
    };

    const event = await recordHistoryEvent(input);
    const serialized = JSON.stringify(storageState.values.historyEvents);

    expect(event?.action).toBe(action);
    expect(event?.categories).toEqual(['OpenAI API key']);
    expect(event?.findingCount).toBe(2);
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain('prompt');
    expect(serialized).not.toContain('originalValue');
    expect(serialized).not.toContain('sanitizedPreview');
  });

  it('summarizes findings without persisting their raw values', async () => {
    enableHistory();
    const rawSecret = 'live_secret_value_837465';
    const findings = scanText(`CLIENT_SECRET=${rawSecret}\ncontact ops@example.com`);

    const event = await recordFindingsHistory('gemini', findings, 'redacted');

    expect(event?.findingCount).toBe(findings.length);
    expect(event?.severity).toBe('high');
    expect(event?.confidence).toBe('medium');
    expect(JSON.stringify(storageState.values.historyEvents)).not.toContain(rawSecret);
    expect(JSON.stringify(storageState.values.historyEvents)).not.toContain('ops@example.com');
  });

  it.each([7, 30, 90] as const)(
    'removes events older than the configured %i-day retention',
    async (retentionDays) => {
      enableHistory(retentionDays);
      const now = 2_000_000_000_000;
      const cutoff = now - retentionDays * 24 * 60 * 60 * 1_000;
      storageState.values.historyEvents = [
        {
          id: 'expired',
          timestamp: cutoff - 1,
          site: 'chatgpt',
          categories: ['Email address'],
          severity: 'medium',
          confidence: 'high',
          action: 'cancelled',
          findingCount: 1,
        },
        {
          id: 'boundary',
          timestamp: cutoff,
          site: 'claude',
          categories: ['Private key'],
          severity: 'critical',
          confidence: 'high',
          action: 'redacted',
          findingCount: 1,
        },
      ];

      expect((await cleanupHistory(now)).map((event) => event.id)).toEqual(['boundary']);
    },
  );

  it('continues pruning existing metadata after new history collection is disabled', async () => {
    enableHistory(7);
    (storageState.values.settings as typeof DEFAULT_SETTINGS).history.enabled = false;
    storageState.values.historyEvents = [{
      id: 'expired-while-disabled',
      timestamp: 1,
      site: 'chatgpt',
      categories: ['Email address'],
      severity: 'medium',
      confidence: 'high',
      action: 'cancelled',
      findingCount: 1,
    }];

    expect(await cleanupHistory(2_000_000_000_000)).toEqual([]);
  });

  it('keeps all valid events when retention is Forever', async () => {
    enableHistory(null);
    storageState.values.historyEvents = [
      {
        id: 'old-but-kept',
        timestamp: 1,
        site: 'grok',
        categories: ['Internal hostname'],
        severity: 'low',
        confidence: 'high',
        action: 'sent-anyway',
        findingCount: 1,
      },
    ];

    expect((await cleanupHistory(2_000_000_000_000)).map((event) => event.id)).toEqual([
      'old-but-kept',
    ]);
  });

  it('filters by site and action and clears all history', async () => {
    enableHistory(null);
    const now = Date.now();
    await recordHistoryEvent({
      timestamp: now,
      site: 'chatgpt',
      categories: ['Email address'],
      severity: 'medium',
      confidence: 'high',
      action: 'cancelled',
    });
    await recordHistoryEvent({
      timestamp: now + 1,
      site: 'claude',
      categories: ['Database credential'],
      severity: 'critical',
      confidence: 'high',
      action: 'redacted',
    });

    expect((await getHistoryEvents({ site: 'claude' })).map((event) => event.site)).toEqual([
      'claude',
    ]);
    expect((await getHistoryEvents({ action: 'cancelled' })).map((event) => event.action)).toEqual([
      'cancelled',
    ]);

    await clearHistory();
    expect(await getHistoryEvents()).toEqual([]);
  });
});
