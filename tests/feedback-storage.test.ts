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
      },
    },
  },
}));

import {
  allowlistFinding,
  clearAllowlist,
  clearFeedbackRecords,
  deleteAllowlistEntry,
  deleteFeedbackRecord,
  filterAllowlistedFindings,
  getAllowlistEntries,
  getAllowlistFingerprintPrefix,
  getFeedbackRecords,
  resetFeedbackState,
  saveFindingFeedback,
} from '../src/feedback';
import { scanText } from '../src/scanner';

describe('feedback persistence', () => {
  beforeEach(() => {
    storageState.values = {};
  });

  it('persists sanitized feedback without the raw finding value', async () => {
    const rawSecret = 'live_secret_value_837465';
    const [finding] = scanText(`CLIENT_SECRET=${rawSecret}`);
    expect(finding).toBeDefined();

    await saveFindingFeedback(finding!, 'correct');
    const serializedStorage = JSON.stringify(storageState.values);
    expect(serializedStorage).not.toContain(rawSecret);
    expect(serializedStorage).not.toContain('originalValue');
    expect(serializedStorage).toContain('valueFingerprint');
    expect(serializedStorage).toContain('correct');
  });

  it('allowlists only the exact fingerprint and leaves other findings active', async () => {
    const [allowedFinding] = scanText('CLIENT_SECRET=live_secret_value_837465');
    const [differentFinding] = scanText('CLIENT_SECRET=different_secret_value_928374');
    expect(allowedFinding).toBeDefined();
    expect(differentFinding).toBeDefined();

    await allowlistFinding(allowedFinding!);
    expect(await filterAllowlistedFindings([allowedFinding!])).toEqual([]);
    expect(await filterAllowlistedFindings([differentFinding!])).toEqual([differentFinding]);
  });

  it('exposes safe allowlist metadata and supports removing one entry', async () => {
    const rawSecret = 'live_secret_value_837465';
    const [finding] = scanText(`CLIENT_SECRET=${rawSecret}`);
    expect(finding).toBeDefined();

    const saved = await allowlistFinding(finding!);
    const [entry] = await getAllowlistEntries();

    expect(entry).toEqual(saved);
    expect(entry?.detector).toBe(finding?.detector);
    expect(entry?.category).toBe(finding?.category);
    expect(getAllowlistFingerprintPrefix(entry!)).toMatch(/^[a-f0-9]{10}$/);
    expect(JSON.stringify(entry)).not.toContain(rawSecret);

    await deleteAllowlistEntry(entry!.id);
    expect(await getAllowlistEntries()).toEqual([]);
    expect(await filterAllowlistedFindings([finding!])).toEqual([finding]);
  });

  it('deduplicates exact allowlist entries without losing their creation metadata', async () => {
    const [finding] = scanText('CLIENT_SECRET=live_secret_value_837465');
    expect(finding).toBeDefined();

    const first = await allowlistFinding(finding!);
    const second = await allowlistFinding(finding!);

    expect(second).toEqual(first);
    expect(await getAllowlistEntries()).toHaveLength(1);
  });

  it('deletes one feedback event and can clear feedback independently', async () => {
    const [first] = scanText('CLIENT_SECRET=live_secret_value_837465');
    const [second] = scanText('CLIENT_SECRET=different_secret_value_928374');
    await saveFindingFeedback(first!, 'correct');
    await saveFindingFeedback(second!, 'not-sensitive');
    const records = await getFeedbackRecords();

    await deleteFeedbackRecord(records[0]!.id);
    expect((await getFeedbackRecords()).map((record) => record.id)).toEqual([records[1]!.id]);

    await clearFeedbackRecords();
    expect(await getFeedbackRecords()).toEqual([]);
  });

  it('clears the allowlist without clearing feedback', async () => {
    const [finding] = scanText('CLIENT_SECRET=live_secret_value_837465');
    await saveFindingFeedback(finding!, 'correct');
    await allowlistFinding(finding!);

    await clearAllowlist();

    expect(await getAllowlistEntries()).toEqual([]);
    expect(await getFeedbackRecords()).toHaveLength(1);
  });

  it('resets feedback, allowlist, and the local fingerprint salt together', async () => {
    const [finding] = scanText('CLIENT_SECRET=live_secret_value_837465');
    await saveFindingFeedback(finding!, 'correct');
    await allowlistFinding(finding!);
    expect(storageState.values.feedbackFingerprintSalt).toBeDefined();

    await resetFeedbackState();

    expect(storageState.values.localFeedbackRecords).toBeUndefined();
    expect(storageState.values.localAllowlistFingerprints).toBeUndefined();
    expect(storageState.values.feedbackFingerprintSalt).toBeUndefined();
  });

  it('continues matching v0.2 fingerprint-only allowlist entries', async () => {
    const [finding] = scanText('CLIENT_SECRET=live_secret_value_837465');
    expect(finding).toBeDefined();
    await allowlistFinding(finding!);
    const fingerprint = (await getAllowlistEntries())[0]!.fingerprint;
    storageState.values.localAllowlistFingerprints = [fingerprint];

    expect(await filterAllowlistedFindings([finding!])).toEqual([]);
    expect((await getAllowlistEntries())[0]).toMatchObject({
      fingerprint,
      category: 'Previously allowlisted value',
      createdAt: 0,
    });
  });
});
