import { useCallback, useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  clearAllowlist,
  clearFeedbackRecords,
  deleteAllowlistEntry,
  deleteFeedbackRecord,
  getAllowlistEntries,
  getAllowlistFingerprintPrefix,
  getFeedbackRecords,
} from '../../src/feedback';
import { getContributedFeedbackCount } from '../../src/feedback-contribution';
import { clearHistory, getHistoryEvents } from '../../src/history';
import {
  clearAllPreSendData,
  DEFAULT_SETTINGS,
  getSettings,
  updateSettings,
} from '../../src/storage';
import type {
  AllowlistEntry,
  DetectorSettings,
  FeedbackRecord,
  HistoryAction,
  HistoryEvent,
  HistoryRetentionDays,
  PreSendSettings,
  SiteId,
} from '../../src/types';

const siteLabels: Record<SiteId, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
  deepseek: 'DeepSeek',
  grok: 'Grok',
};

const detectorLabels: Record<keyof DetectorSettings, string> = {
  credentials: 'Credentials and secrets',
  privateKeys: 'Private keys',
  databaseCredentials: 'Database credentials',
  emails: 'Email addresses',
  phoneNumbers: 'Phone numbers',
  internalHosts: 'Internal hostnames',
};

const actionLabels: Record<HistoryAction, string> = {
  redacted: 'Redacted',
  'safe-example': 'Replaced with safe example',
  'sent-anyway': 'Sent anyway',
  cancelled: 'Cancelled',
};

function formatDate(timestamp: number): string {
  if (timestamp === 0) return 'Imported from an earlier version';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp);
}

function freshDefaults(): PreSendSettings {
  return {
    ...DEFAULT_SETTINGS,
    sites: { ...DEFAULT_SETTINGS.sites },
    detectors: { ...DEFAULT_SETTINGS.detectors },
    history: { ...DEFAULT_SETTINGS.history },
  };
}

export default function App() {
  const [settings, setSettings] = useState<PreSendSettings>(freshDefaults);
  const [history, setHistory] = useState<HistoryEvent[]>([]);
  const [feedback, setFeedback] = useState<FeedbackRecord[]>([]);
  const [allowlist, setAllowlist] = useState<AllowlistEntry[]>([]);
  const [historySite, setHistorySite] = useState<SiteId | ''>('');
  const [historyAction, setHistoryAction] = useState<HistoryAction | ''>('');
  const [status, setStatus] = useState('Loading settings…');
  const [contributedCount, setContributedCount] = useState(0);
  const [showContributionConfirmation, setShowContributionConfirmation] = useState(false);

  const reloadManagedData = useCallback(async () => {
    const [nextSettings, nextHistory, nextFeedback, nextAllowlist, nextContributedCount] = await Promise.all([
      getSettings(),
      getHistoryEvents(),
      getFeedbackRecords(),
      getAllowlistEntries(),
      getContributedFeedbackCount(),
    ]);
    setSettings(nextSettings);
    setHistory(nextHistory);
    setFeedback(nextFeedback);
    setAllowlist(nextAllowlist);
    setContributedCount(nextContributedCount);
    setStatus('Settings saved locally');
  }, []);

  useEffect(() => {
    void reloadManagedData().catch(() => setStatus('PreSend could not load local settings.'));
  }, [reloadManagedData]);

  const filteredHistory = useMemo(
    () => history.filter(
      (event) => (!historySite || event.site === historySite) &&
        (!historyAction || event.action === historyAction),
    ),
    [history, historyAction, historySite],
  );

  const persist = async (nextSettings: PreSendSettings) => {
    setSettings(nextSettings);
    setStatus('Saving…');
    try {
      const saved = await updateSettings({
        protectionEnabled: nextSettings.protectionEnabled,
        semanticDetection: nextSettings.semanticDetection,
        feedbackContributionEnabled: nextSettings.feedbackContributionEnabled,
        feedbackContributionConsent: nextSettings.feedbackContributionConsent,
        sites: nextSettings.sites,
        detectors: nextSettings.detectors,
        history: nextSettings.history,
      });
      setSettings(saved);
      setStatus('Settings saved locally');
    } catch {
      setStatus('PreSend could not save this setting.');
    }
  };

  const toggleSite = (site: SiteId) => void persist({
    ...settings,
    sites: { ...settings.sites, [site]: !settings.sites[site] },
  });

  const toggleDetector = (detector: keyof DetectorSettings) => void persist({
    ...settings,
    detectors: { ...settings.detectors, [detector]: !settings.detectors[detector] },
  });

  const changeRetention = (value: string) => {
    const retentionDays: HistoryRetentionDays = value === 'forever'
      ? null
      : Number(value) as 7 | 30 | 90;
    void persist({ ...settings, history: { ...settings.history, retentionDays } })
      .then(reloadManagedData);
  };

  const setContributionEnabled = async (enabled: boolean, consent: boolean) => {
    await persist({
      ...settings,
      feedbackContributionEnabled: enabled,
      feedbackContributionConsent: consent,
    });
    if (enabled) {
      void browser.runtime.sendMessage({
        type: 'presend:retry-feedback-contributions',
      }).catch(() => undefined);
    }
  };

  const toggleContribution = () => {
    if (settings.feedbackContributionEnabled) {
      void setContributionEnabled(false, settings.feedbackContributionConsent);
      return;
    }
    if (settings.feedbackContributionConsent) {
      void setContributionEnabled(true, true);
      return;
    }
    setShowContributionConfirmation(true);
  };

  const confirmAndClearAll = async () => {
    if (!window.confirm(
      'Clear all PreSend settings, history, feedback, allowlists, and local identifiers?',
    )) return;
    await clearAllPreSendData();
    await reloadManagedData();
    setStatus('All PreSend local data cleared; defaults restored');
  };

  const activityView = window.location.hash === '#history';

  return (
    <main className={activityView ? 'activity-view' : 'settings-view'}>
      <header className="page-header">
        <img src="/icons/icon-48.png" width="42" height="42" alt="" />
        <div>
          <h1>{activityView ? 'PreSend Activity' : 'PreSend Settings'}</h1>
          <p>{activityView ? 'Local protection events and history.' : 'Protection for supported AI chats.'}</p>
        </div>
      </header>

      <p className="save-status" role="status" aria-live="polite">{status}</p>

      <section className="settings-only" aria-labelledby="protection-heading">
        <h2 id="protection-heading">Protection</h2>
        <label className="setting-row prominent">
          <span><strong>Master protection</strong><small>Turn all PreSend checks on or off.</small></span>
          <input
            type="checkbox"
            checked={settings.protectionEnabled}
            onChange={() => void persist({
              ...settings,
              protectionEnabled: !settings.protectionEnabled,
            })}
          />
        </label>
      </section>

      <section className="settings-only" aria-labelledby="model-improvement-heading">
        <h2 id="model-improvement-heading">Model improvement</h2>
        <label className="setting-row prominent">
          <span>
            <strong>Contribute detection feedback</strong>
            <small>Send passages you explicitly rate to help improve future PreSend models.</small>
          </span>
          <input
            type="checkbox"
            checked={settings.feedbackContributionEnabled}
            onChange={toggleContribution}
          />
        </label>
        {showContributionConfirmation && (
          <div className="consent-confirmation" role="dialog" aria-labelledby="contribution-confirmation-heading">
            <strong id="contribution-confirmation-heading">Enable feedback contribution?</strong>
            <p>When enabled, passages you rate using Correct, Not Sensitive, or Wrong Category will be sent to PreSend to improve future detection models. Only the detected passage and classification feedback are contributed.</p>
            <div>
              <button type="button" onClick={() => setShowContributionConfirmation(false)}>Cancel</button>
              <button type="button" onClick={() => {
                setShowContributionConfirmation(false);
                void setContributionEnabled(true, true);
              }}>Enable</button>
            </div>
          </div>
        )}
        <p className="section-note contribution-count">Contributed feedback: {contributedCount}</p>
      </section>

      <section className="settings-only" aria-labelledby="sites-heading">
        <h2 id="sites-heading">Supported sites</h2>
        <div className="settings-list">
          {(Object.keys(siteLabels) as SiteId[]).map((site) => (
            <label className="setting-row" key={site}>
              <span>{siteLabels[site]}</span>
              <input
                type="checkbox"
                checked={settings.sites[site]}
                disabled={!settings.protectionEnabled}
                onChange={() => toggleSite(site)}
              />
            </label>
          ))}
        </div>
      </section>

      <section className="settings-only" aria-labelledby="detectors-heading">
        <h2 id="detectors-heading">Detectors</h2>
        <div className="settings-list">
          <label className="setting-row">
            <span>
              <strong>Semantic detection</strong>
              <small>Checks meaning locally with the bundled model.</small>
            </span>
            <input
              type="checkbox"
              checked={settings.semanticDetection}
              disabled={!settings.protectionEnabled}
              onChange={() => void persist({
                ...settings,
                semanticDetection: !settings.semanticDetection,
              })}
            />
          </label>
          {(Object.keys(detectorLabels) as Array<keyof DetectorSettings>).map((detector) => (
            <label className="setting-row" key={detector}>
              <span>{detectorLabels[detector]}</span>
              <input
                type="checkbox"
                checked={settings.detectors[detector]}
                disabled={!settings.protectionEnabled}
                onChange={() => toggleDetector(detector)}
              />
            </label>
          ))}
        </div>
      </section>

      <section id="history" className="activity-only" aria-labelledby="history-heading">
        <h2 id="history-heading">Activity history</h2>
        <p className="section-note">
          History is off by default and stores event metadata only. It never stores prompts, values, or previews.
        </p>
        <label className="setting-row">
          <span><strong>Save activity metadata</strong></span>
          <input
            type="checkbox"
            checked={settings.history.enabled}
            onChange={() => void persist({
              ...settings,
              history: { ...settings.history, enabled: !settings.history.enabled },
            }).then(reloadManagedData)}
          />
        </label>
        <label className="select-row">
          Retention
          <select
            value={settings.history.retentionDays ?? 'forever'}
            disabled={!settings.history.enabled}
            onChange={(event) => changeRetention(event.target.value)}
          >
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="forever">Forever</option>
          </select>
        </label>
        <div className="filters" aria-label="Activity filters">
          <select value={historySite} onChange={(event) => setHistorySite(event.target.value as SiteId | '')}>
            <option value="">All sites</option>
            {(Object.keys(siteLabels) as SiteId[]).map((site) => (
              <option key={site} value={site}>{siteLabels[site]}</option>
            ))}
          </select>
          <select value={historyAction} onChange={(event) => setHistoryAction(event.target.value as HistoryAction | '')}>
            <option value="">All actions</option>
            {(Object.keys(actionLabels) as HistoryAction[]).map((action) => (
              <option key={action} value={action}>{actionLabels[action]}</option>
            ))}
          </select>
          <button type="button" onClick={() => void clearHistory().then(reloadManagedData)}>
            Clear history
          </button>
        </div>
        {filteredHistory.length === 0 ? (
          <p className="empty">No stored activity.</p>
        ) : (
          <ul className="records">
            {filteredHistory.map((event) => (
              <li key={event.id}>
                <strong>{siteLabels[event.site]}</strong>
                <span>{event.categories.join(', ')}</span>
                <small>
                  {formatDate(event.timestamp)} · {event.severity} / {event.confidence} confidence · {actionLabels[event.action]}
                </small>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="settings-only" aria-labelledby="feedback-heading">
        <h2 id="feedback-heading">Feedback and allowlist</h2>
        <p className="section-note">Local feedback stores metadata and salted one-way fingerprints. Failed opt-in contributions remain in a bounded local queue.</p>
        <div className="subheading-row">
          <h3>Feedback</h3>
          <button type="button" onClick={() => void clearFeedbackRecords().then(reloadManagedData)}>
            Clear feedback
          </button>
        </div>
        {feedback.length === 0 ? <p className="empty">No feedback saved.</p> : (
          <ul className="records compact">
            {feedback.map((record) => (
              <li key={record.id}>
                <span><strong>{record.category}</strong> · {record.feedbackLabel}</span>
                <small>{formatDate(record.timestamp)}</small>
                <button type="button" onClick={() => void deleteFeedbackRecord(record.id).then(reloadManagedData)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="subheading-row">
          <h3>Exact-value allowlist</h3>
          <button type="button" onClick={() => void clearAllowlist().then(reloadManagedData)}>
            Clear allowlist
          </button>
        </div>
        {allowlist.length === 0 ? <p className="empty">No allowlist entries.</p> : (
          <ul className="records compact">
            {allowlist.map((entry) => (
              <li key={entry.id}>
                <span><strong>{entry.category}</strong> · fingerprint {getAllowlistFingerprintPrefix(entry)}…</span>
                <small>{formatDate(entry.createdAt)}</small>
                <button type="button" onClick={() => void deleteAllowlistEntry(entry.id).then(reloadManagedData)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="settings-only" aria-labelledby="privacy-heading">
        <h2 id="privacy-heading">Privacy</h2>
        <ul className="privacy-list">
          <li>Scanning happens locally in your browser.</li>
          <li>Detected passages leave the browser only when feedback contribution is enabled and you rate a finding.</li>
          <li>PreSend contains no telemetry or advertising trackers.</li>
          <li>Optional history stores metadata only.</li>
        </ul>
      </section>

      <section className="danger-zone settings-only" aria-labelledby="data-heading">
        <h2 id="data-heading">Data</h2>
        <p>Remove settings, history, feedback, allowlists, local salts, and onboarding state.</p>
        <button type="button" className="danger" onClick={() => void confirmAndClearAll()}>
          Clear All PreSend Data
        </button>
      </section>
    </main>
  );
}
