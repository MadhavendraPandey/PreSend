import { browser } from 'wxt/browser';
import type {
  AllowlistEntry,
  DetectorSettings,
  IntegrationHealth,
  PreSendSettings,
  SessionStats,
  SiteId,
  SiteSettings,
} from './types';

export const STORAGE_SCHEMA_VERSION = 1;

const storageKeys = {
  schemaVersion: 'storageSchemaVersion',
  settings: 'settings',
  onboardingCompleted: 'onboardingCompleted',
  integrationHealth: 'integrationHealth',
  integrationHealthBySite: 'integrationHealthBySite',
  allowlistFingerprints: 'localAllowlistFingerprints',
} as const;

export const storageMessageTypes = {
  saveIntegrationHealth: 'presend:save-integration-health',
  recordSessionCheck: 'presend:record-session-check',
  getCurrentIntegrationHealth: 'presend:get-current-integration-health',
  submitFeedbackContribution: 'presend:submit-feedback-contribution',
  retryFeedbackContributions: 'presend:retry-feedback-contributions',
} as const;

const sessionStatsKey = 'sessionStats';

export const DEFAULT_SETTINGS: Readonly<PreSendSettings> = {
  protectionEnabled: true,
  semanticDetection: true,
  feedbackContributionEnabled: false,
  feedbackContributionConsent: false,
  sites: {
    chatgpt: true,
    claude: true,
    gemini: true,
    perplexity: true,
    deepseek: true,
    grok: true,
  },
  detectors: {
    credentials: true,
    privateKeys: true,
    databaseCredentials: true,
    emails: true,
    phoneNumbers: true,
    internalHosts: true,
  },
  history: {
    enabled: false,
    retentionDays: 30,
  },
};

export interface SettingsUpdate {
  protectionEnabled?: boolean;
  semanticDetection?: boolean;
  feedbackContributionEnabled?: boolean;
  feedbackContributionConsent?: boolean;
  sites?: Partial<SiteSettings>;
  detectors?: Partial<DetectorSettings>;
  history?: Partial<PreSendSettings['history']>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneDefaultSettings(): PreSendSettings {
  return {
    protectionEnabled: DEFAULT_SETTINGS.protectionEnabled,
    semanticDetection: DEFAULT_SETTINGS.semanticDetection,
    feedbackContributionEnabled: DEFAULT_SETTINGS.feedbackContributionEnabled,
    feedbackContributionConsent: DEFAULT_SETTINGS.feedbackContributionConsent,
    sites: { ...DEFAULT_SETTINGS.sites },
    detectors: { ...DEFAULT_SETTINGS.detectors },
    history: { ...DEFAULT_SETTINGS.history },
  };
}

function booleanOrDefault(value: unknown, defaultValue: boolean): boolean {
  return typeof value === 'boolean' ? value : defaultValue;
}

function normalizeSettings(value: unknown): PreSendSettings {
  const defaults = cloneDefaultSettings();
  if (!isRecord(value)) return defaults;

  const sites = isRecord(value.sites) ? value.sites : {};
  const detectors = isRecord(value.detectors) ? value.detectors : {};
  const history = isRecord(value.history) ? value.history : {};
  const retentionDays = history.retentionDays;
  const feedbackContributionConsent = booleanOrDefault(
    value.feedbackContributionConsent,
    defaults.feedbackContributionConsent,
  );

  return {
    protectionEnabled: booleanOrDefault(
      value.protectionEnabled ?? value.masterProtection,
      defaults.protectionEnabled,
    ),
    semanticDetection: booleanOrDefault(
      value.semanticDetection,
      defaults.semanticDetection,
    ),
    feedbackContributionEnabled: feedbackContributionConsent && booleanOrDefault(
      value.feedbackContributionEnabled,
      defaults.feedbackContributionEnabled,
    ),
    feedbackContributionConsent,
    sites: {
      chatgpt: booleanOrDefault(sites.chatgpt, defaults.sites.chatgpt),
      claude: booleanOrDefault(sites.claude, defaults.sites.claude),
      gemini: booleanOrDefault(sites.gemini, defaults.sites.gemini),
      perplexity: booleanOrDefault(sites.perplexity, defaults.sites.perplexity),
      deepseek: booleanOrDefault(sites.deepseek, defaults.sites.deepseek),
      grok: booleanOrDefault(sites.grok, defaults.sites.grok),
    },
    detectors: {
      credentials: booleanOrDefault(detectors.credentials, defaults.detectors.credentials),
      privateKeys: booleanOrDefault(detectors.privateKeys, defaults.detectors.privateKeys),
      databaseCredentials: booleanOrDefault(
        detectors.databaseCredentials,
        defaults.detectors.databaseCredentials,
      ),
      emails: booleanOrDefault(detectors.emails, defaults.detectors.emails),
      phoneNumbers: booleanOrDefault(detectors.phoneNumbers, defaults.detectors.phoneNumbers),
      internalHosts: booleanOrDefault(detectors.internalHosts, defaults.detectors.internalHosts),
    },
    history: {
      enabled: booleanOrDefault(history.enabled, defaults.history.enabled),
      retentionDays:
        retentionDays === 7 ||
        retentionDays === 30 ||
        retentionDays === 90 ||
        retentionDays === null
          ? retentionDays
          : defaults.history.retentionDays,
    },
  };
}

function normalizeLegacyAllowlist(value: unknown): AllowlistEntry[] | null {
  if (!Array.isArray(value) || !value.some((entry) => typeof entry === 'string')) {
    return null;
  }

  return value.flatMap((entry): AllowlistEntry[] => {
    if (typeof entry === 'string' && /^[a-f0-9]{64}$/i.test(entry)) {
      return [{
        id: entry,
        fingerprint: entry,
        category: 'Previously allowlisted value',
        createdAt: 0,
      }];
    }
    if (
      isRecord(entry) &&
      typeof entry.fingerprint === 'string' &&
      /^[a-f0-9]{64}$/i.test(entry.fingerprint) &&
      typeof entry.category === 'string' &&
      typeof entry.createdAt === 'number' &&
      Number.isFinite(entry.createdAt)
    ) {
      return [{
        id: entry.fingerprint,
        fingerprint: entry.fingerprint,
        category: entry.category.slice(0, 80),
        createdAt: entry.createdAt,
      }];
    }
    return [];
  });
}

/**
 * Applies the one explicit v0 -> v1 migration and fills newly introduced
 * defaults. It never copies prompt or finding values into storage.
 */
export async function migrateStorage(): Promise<void> {
  const [versionResult, settingsResult, onboardingResult, allowlistResult] = await Promise.all([
    browser.storage.local.get(storageKeys.schemaVersion),
    browser.storage.local.get(storageKeys.settings),
    browser.storage.local.get(storageKeys.onboardingCompleted),
    browser.storage.local.get(storageKeys.allowlistFingerprints),
  ]);
  const storedVersion = versionResult[storageKeys.schemaVersion];
  const storedSettings = settingsResult[storageKeys.settings];
  const onboardingCompleted = onboardingResult[storageKeys.onboardingCompleted];
  const normalizedSettings = normalizeSettings(storedSettings);
  const migratedAllowlist = normalizeLegacyAllowlist(
    allowlistResult[storageKeys.allowlistFingerprints],
  );

  const updates: Record<string, unknown> = {
    [storageKeys.schemaVersion]: STORAGE_SCHEMA_VERSION,
    [storageKeys.settings]: normalizedSettings,
  };

  if (typeof onboardingCompleted !== 'boolean') {
    updates[storageKeys.onboardingCompleted] = false;
  }
  if (migratedAllowlist) {
    updates[storageKeys.allowlistFingerprints] = migratedAllowlist;
  }

  if (
    storedVersion !== STORAGE_SCHEMA_VERSION ||
    JSON.stringify(storedSettings) !== JSON.stringify(normalizedSettings) ||
    typeof onboardingCompleted !== 'boolean' ||
    migratedAllowlist !== null
  ) {
    await browser.storage.local.set(updates);
  }

  // Integration health is operational session state, not durable user data.
  await browser.storage.local.remove([
    storageKeys.integrationHealth,
    storageKeys.integrationHealthBySite,
  ]);
}

export async function initializeStorage(): Promise<void> {
  await migrateStorage();
}

export async function getSettings(): Promise<PreSendSettings> {
  const [result, versionResult] = await Promise.all([
    browser.storage.local.get(storageKeys.settings),
    browser.storage.local.get(storageKeys.schemaVersion),
  ]);
  const stored = result[storageKeys.settings];
  const settings = normalizeSettings(stored);

  if (
    versionResult[storageKeys.schemaVersion] !== STORAGE_SCHEMA_VERSION ||
    JSON.stringify(stored) !== JSON.stringify(settings)
  ) {
    await browser.storage.local.set({
      [storageKeys.schemaVersion]: STORAGE_SCHEMA_VERSION,
      [storageKeys.settings]: settings,
    });
  }
  return settings;
}

export async function saveSettings(settings: PreSendSettings): Promise<PreSendSettings> {
  const normalized = normalizeSettings(settings);
  await browser.storage.local.set({
    [storageKeys.schemaVersion]: STORAGE_SCHEMA_VERSION,
    [storageKeys.settings]: normalized,
  });
  return normalized;
}

export async function updateSettings(update: SettingsUpdate): Promise<PreSendSettings> {
  const current = await getSettings();
  return saveSettings({
    protectionEnabled: update.protectionEnabled ?? current.protectionEnabled,
    semanticDetection: update.semanticDetection ?? current.semanticDetection,
    feedbackContributionEnabled:
      update.feedbackContributionEnabled ?? current.feedbackContributionEnabled,
    feedbackContributionConsent:
      update.feedbackContributionConsent ?? current.feedbackContributionConsent,
    sites: { ...current.sites, ...update.sites },
    detectors: { ...current.detectors, ...update.detectors },
    history: { ...current.history, ...update.history },
  });
}

export async function getOnboardingCompleted(): Promise<boolean> {
  const result = await browser.storage.local.get(storageKeys.onboardingCompleted);
  return result[storageKeys.onboardingCompleted] === true;
}

export async function setOnboardingCompleted(completed: boolean): Promise<void> {
  await browser.storage.local.set({ [storageKeys.onboardingCompleted]: completed });
}

function siteIdForHealth(health: IntegrationHealth): SiteId | null {
  if (health.siteId) return health.siteId;
  const byName: Record<IntegrationHealth['site'], SiteId> = {
    ChatGPT: 'chatgpt',
    Claude: 'claude',
    Gemini: 'gemini',
    Perplexity: 'perplexity',
    DeepSeek: 'deepseek',
    Grok: 'grok',
  };
  return byName[health.site] ?? null;
}

function normalizeIntegrationHealth(value: unknown): IntegrationHealth | null {
  if (!isRecord(value)) return null;
  const siteNames = new Set<IntegrationHealth['site']>([
    'ChatGPT',
    'Claude',
    'Gemini',
    'Perplexity',
    'DeepSeek',
    'Grok',
  ]);
  const valid =
    siteNames.has(value.site as IntegrationHealth['site']) &&
    (value.protection === 'protected' || value.protection === 'unavailable') &&
    (value.scanner === 'ready' || value.scanner === 'unavailable') &&
    typeof value.updatedAt === 'number' &&
    Number.isFinite(value.updatedAt);
  if (!valid) return null;

  const health: IntegrationHealth = {
    site: value.site as IntegrationHealth['site'],
    protection: value.protection as IntegrationHealth['protection'],
    scanner: value.scanner as IntegrationHealth['scanner'],
    updatedAt: value.updatedAt as number,
  };
  if (typeof value.siteId === 'string' && value.siteId in DEFAULT_SETTINGS.sites) {
    health.siteId = value.siteId as SiteId;
  }
  if (typeof value.protectionEnabled === 'boolean') {
    health.protectionEnabled = value.protectionEnabled;
  }
  if (typeof value.siteRecognized === 'boolean') health.siteRecognized = value.siteRecognized;
  if (typeof value.composerDetected === 'boolean') health.composerDetected = value.composerDetected;
  if (typeof value.monitoringActive === 'boolean') health.monitoringActive = value.monitoringActive;
  if (value.textProtection === 'protected' || value.textProtection === 'unavailable') {
    health.textProtection = value.textProtection;
  }
  if (value.fileProtection === 'protected' || value.fileProtection === 'unavailable') {
    health.fileProtection = value.fileProtection;
  }
  return health;
}

export async function saveIntegrationHealth(health: IntegrationHealth): Promise<void> {
  const normalizedHealth = normalizeIntegrationHealth(health);
  if (!normalizedHealth || !browser.storage.session) return;
  const siteId = siteIdForHealth(normalizedHealth);
  if (!siteId) return;

  const stored = await browser.storage.session.get(storageKeys.integrationHealthBySite);
  const storedHealth = stored[storageKeys.integrationHealthBySite];
  const existing: Partial<Record<SiteId, IntegrationHealth>> = {};
  if (isRecord(storedHealth)) {
    for (const storedSiteId of Object.keys(DEFAULT_SETTINGS.sites) as SiteId[]) {
      const normalized = normalizeIntegrationHealth(storedHealth[storedSiteId]);
      if (normalized) existing[storedSiteId] = normalized;
    }
  }
  await browser.storage.session.set({
    [storageKeys.integrationHealthBySite]: { ...existing, [siteId]: normalizedHealth },
  });
}

export async function getIntegrationHealth(
  siteId?: SiteId,
): Promise<IntegrationHealth | null> {
  const stored = browser.storage.session
    ? await browser.storage.session.get(storageKeys.integrationHealthBySite)
    : {};
  const bySite = stored[storageKeys.integrationHealthBySite];
  if (isRecord(bySite)) {
    if (siteId) {
      const selected = normalizeIntegrationHealth(bySite[siteId]);
      if (selected) return selected;
    }

    const latest = Object.values(bySite)
      .map(normalizeIntegrationHealth)
      .filter((health): health is IntegrationHealth => health !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (latest) return latest;
  }

  // v0.2 stored one last-known ChatGPT health record under this key.
  const legacy = await browser.storage.local.get(storageKeys.integrationHealth);
  const legacyHealth = legacy[storageKeys.integrationHealth];
  const normalizedLegacyHealth = normalizeIntegrationHealth(legacyHealth);
  if (!normalizedLegacyHealth) return null;
  if (siteId && siteIdForHealth(normalizedLegacyHealth) !== siteId) return null;
  return normalizedLegacyHealth;
}

export async function getIntegrationHealthBySite(): Promise<Partial<Record<SiteId, IntegrationHealth>>> {
  if (!browser.storage.session) return {};
  const stored = await browser.storage.session.get(storageKeys.integrationHealthBySite);
  const value = stored[storageKeys.integrationHealthBySite];
  if (!isRecord(value)) return {};

  const result: Partial<Record<SiteId, IntegrationHealth>> = {};
  for (const siteId of Object.keys(DEFAULT_SETTINGS.sites) as SiteId[]) {
    const health = normalizeIntegrationHealth(value[siteId]);
    if (health) result[siteId] = health;
  }
  return result;
}

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function getSessionStats(now = new Date()): Promise<SessionStats> {
  const empty: SessionStats = { date: localDateKey(now), checks: 0, warnings: 0 };
  if (!browser.storage.session) return empty;
  const stored = await browser.storage.session.get(sessionStatsKey);
  const value = stored[sessionStatsKey];
  if (
    !isRecord(value) ||
    value.date !== empty.date ||
    typeof value.checks !== 'number' ||
    typeof value.warnings !== 'number'
  ) {
    return empty;
  }
  return {
    date: empty.date,
    checks: Math.max(0, Math.floor(value.checks)),
    warnings: Math.max(0, Math.floor(value.warnings)),
  };
}

export async function recordSessionCheck(
  warningCount: number,
  now = new Date(),
): Promise<SessionStats> {
  const current = await getSessionStats(now);
  const next: SessionStats = {
    date: current.date,
    checks: current.checks + 1,
    warnings: current.warnings + Math.max(0, Math.floor(warningCount)),
  };
  if (browser.storage.session) {
    await browser.storage.session.set({ [sessionStatsKey]: next });
  }
  return next;
}

export async function clearAllPreSendData(): Promise<void> {
  await browser.storage.local.clear();
  if (browser.storage.session) await browser.storage.session.clear();
  await browser.storage.local.set({
    [storageKeys.schemaVersion]: STORAGE_SCHEMA_VERSION,
    [storageKeys.settings]: cloneDefaultSettings(),
    [storageKeys.onboardingCompleted]: false,
  });
}
