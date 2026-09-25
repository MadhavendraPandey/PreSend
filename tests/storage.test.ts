import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageState = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  sessionValues: {} as Record<string, unknown>,
}));

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: {
        get: vi.fn(async (keys?: string | string[]) => {
          if (typeof keys === 'string') return { [keys]: storageState.values[keys] };
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((key) => [key, storageState.values[key]]));
          }
          return { ...storageState.values };
        }),
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
      session: {
        get: vi.fn(async (key: string) => ({ [key]: storageState.sessionValues[key] })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          Object.assign(storageState.sessionValues, values);
        }),
        clear: vi.fn(async () => {
          storageState.sessionValues = {};
        }),
      },
    },
  },
}));

import {
  clearAllPreSendData,
  DEFAULT_SETTINGS,
  getIntegrationHealth,
  getOnboardingCompleted,
  getSettings,
  migrateStorage,
  saveIntegrationHealth,
  setOnboardingCompleted,
  STORAGE_SCHEMA_VERSION,
  updateSettings,
} from '../src/storage';

describe('versioned local storage', () => {
  beforeEach(() => {
    storageState.values = {};
    storageState.sessionValues = {};
  });

  it('starts with protection on, every supported site and detector on, and history off', async () => {
    const settings = await getSettings();

    expect(settings).toEqual(DEFAULT_SETTINGS);
    expect(settings.protectionEnabled).toBe(true);
    expect(settings.feedbackContributionEnabled).toBe(false);
    expect(settings.feedbackContributionConsent).toBe(false);
    expect(Object.values(settings.sites)).toEqual([true, true, true, true, true, true]);
    expect(Object.values(settings.detectors)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(settings.history).toEqual({ enabled: false, retentionDays: 30 });
  });

  it('merges scoped updates without resetting unrelated choices', async () => {
    await updateSettings({
      protectionEnabled: false,
      sites: { claude: false },
      detectors: { emails: false },
      history: { enabled: true, retentionDays: 90 },
      feedbackContributionEnabled: true,
      feedbackContributionConsent: true,
    });
    const settings = await updateSettings({ sites: { grok: false } });

    expect(settings.protectionEnabled).toBe(false);
    expect(settings.sites.claude).toBe(false);
    expect(settings.sites.grok).toBe(false);
    expect(settings.sites.chatgpt).toBe(true);
    expect(settings.detectors.emails).toBe(false);
    expect(settings.detectors.privateKeys).toBe(true);
    expect(settings.history).toEqual({ enabled: true, retentionDays: 90 });
    expect(settings.feedbackContributionEnabled).toBe(true);
    expect(settings.feedbackContributionConsent).toBe(true);
  });

  it('explicitly migrates partial v0 settings and legacy fingerprint allowlists', async () => {
    const fingerprint = 'a'.repeat(64);
    storageState.values = {
      settings: {
        masterProtection: false,
        sites: { chatgpt: false },
        detectors: { privateKeys: false },
        history: { enabled: true, retentionDays: 7 },
      },
      localAllowlistFingerprints: [fingerprint],
      localFeedbackRecords: [{ id: 'preserved-feedback' }],
      integrationHealth: { site: 'ChatGPT', updatedAt: 1 },
      integrationHealthBySite: { chatgpt: { site: 'ChatGPT', updatedAt: 1 } },
    };

    await migrateStorage();
    const firstMigration = JSON.parse(JSON.stringify(storageState.values));
    await migrateStorage();

    expect(storageState.values).toEqual(firstMigration);
    expect(storageState.values.storageSchemaVersion).toBe(STORAGE_SCHEMA_VERSION);
    expect(storageState.values.localFeedbackRecords).toEqual([{ id: 'preserved-feedback' }]);
    expect(storageState.values.integrationHealth).toBeUndefined();
    expect(storageState.values.integrationHealthBySite).toBeUndefined();
    expect(storageState.values.localAllowlistFingerprints).toEqual([
      {
        id: fingerprint,
        fingerprint,
        category: 'Previously allowlisted value',
        createdAt: 0,
      },
    ]);
    const settings = storageState.values.settings as typeof DEFAULT_SETTINGS;
    expect(settings.protectionEnabled).toBe(false);
    expect(settings.semanticDetection).toBe(true);
    expect(settings.feedbackContributionEnabled).toBe(false);
    expect(settings.feedbackContributionConsent).toBe(false);
    expect(settings.sites.chatgpt).toBe(false);
    expect(settings.sites.claude).toBe(true);
    expect(settings.detectors.privateKeys).toBe(false);
    expect(settings.detectors.credentials).toBe(true);
  });

  it('tracks onboarding state without storing content', async () => {
    expect(await getOnboardingCompleted()).toBe(false);
    await setOnboardingCompleted(true);
    expect(await getOnboardingCompleted()).toBe(true);
  });

  it('stores site-aware health while keeping the old getter contract', async () => {
    await saveIntegrationHealth({
      site: 'ChatGPT',
      siteId: 'chatgpt',
      protection: 'protected',
      scanner: 'ready',
      textProtection: 'protected',
      fileProtection: 'unavailable',
      updatedAt: 10,
    });
    await saveIntegrationHealth({
      site: 'Claude',
      siteId: 'claude',
      protection: 'unavailable',
      scanner: 'unavailable',
      textProtection: 'unavailable',
      fileProtection: 'unavailable',
      updatedAt: 20,
    });

    expect((await getIntegrationHealth('chatgpt'))?.site).toBe('ChatGPT');
    expect((await getIntegrationHealth('claude'))?.fileProtection).toBe('unavailable');
    expect((await getIntegrationHealth())?.site).toBe('Claude');
    expect(storageState.values.integrationHealthBySite).toBeUndefined();
    expect(storageState.sessionValues.integrationHealthBySite).toBeDefined();
  });

  it('clears every local value, including salts and onboarding, then restores defaults', async () => {
    const rawSecret = 'should-never-survive-clear';
    storageState.values = {
      settings: { protectionEnabled: false },
      historyEvents: [{ prompt: rawSecret }],
      localFeedbackRecords: [{ preview: rawSecret }],
      localAllowlistFingerprints: ['f'.repeat(64)],
      feedbackFingerprintSalt: 'local-salt',
      onboardingCompleted: true,
      integrationHealthBySite: { chatgpt: { updatedAt: 1 } },
    };

    await clearAllPreSendData();

    expect(storageState.values).toEqual({
      storageSchemaVersion: STORAGE_SCHEMA_VERSION,
      settings: DEFAULT_SETTINGS,
      onboardingCompleted: false,
    });
    expect(JSON.stringify(storageState.values)).not.toContain(rawSecret);
    expect(storageState.sessionValues).toEqual({});
  });
});
