import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { getSiteIntegration } from '../../src/sites';
import {
  getSessionStats,
  getSettings,
  storageMessageTypes,
  updateSettings,
} from '../../src/storage';
import type { IntegrationHealth, PreSendSettings, SessionStats, SiteId } from '../../src/types';

interface CurrentSite {
  id: SiteId;
  name: string;
}

function isIntegrationHealth(value: unknown, siteId: SiteId): value is IntegrationHealth {
  if (typeof value !== 'object' || value === null) return false;
  const health = value as Partial<IntegrationHealth>;
  return health.siteId === siteId &&
    (health.textProtection === 'protected' || health.textProtection === 'unavailable') &&
    (health.fileProtection === 'protected' || health.fileProtection === 'unavailable') &&
    typeof health.updatedAt === 'number';
}

function protectionStatus(
  site: CurrentSite | null,
  settings: PreSendSettings | null,
  health: IntegrationHealth | null,
  kind: 'text' | 'file',
): string {
  if (!site) return 'Not active on this site';
  if (!settings?.protectionEnabled || !settings.sites[site.id]) return 'Off in settings';
  if (!health) return 'Protection unavailable';
  const value = kind === 'text' ? health.textProtection : health.fileProtection;
  return value === 'protected' ? 'Active' : 'Protection unavailable';
}

export default function App() {
  const [health, setHealth] = useState<IntegrationHealth | null>(null);
  const [settings, setSettings] = useState<PreSendSettings | null>(null);
  const [site, setSite] = useState<CurrentSite | null>(null);
  const [siteChecked, setSiteChecked] = useState(false);
  const [stats, setStats] = useState<SessionStats>({ date: '', checks: 0, warnings: 0 });

  useEffect(() => {
    void Promise.all([
      getSettings(),
      getSessionStats(),
      browser.tabs.query({ active: true, currentWindow: true }),
    ]).then(async ([loadedSettings, loadedStats, tabs]) => {
      setSettings(loadedSettings);
      setStats(loadedStats);
      const activeTab = tabs[0];
      let activeSite: CurrentSite | null = null;
      try {
        const hostname = activeTab?.url ? new URL(activeTab.url).hostname : '';
        const integration = getSiteIntegration({ hostname } as Location);
        if (integration) activeSite = { id: integration.id, name: integration.name };
      } catch {
        activeSite = null;
      }
      setSite(activeSite);
      setSiteChecked(true);
      let activeHealth: IntegrationHealth | null = null;
      if (activeSite && typeof activeTab?.id === 'number') {
        try {
          const response: unknown = await browser.tabs.sendMessage(activeTab.id, {
            type: storageMessageTypes.getCurrentIntegrationHealth,
          });
          if (isIntegrationHealth(response, activeSite.id)) activeHealth = response;
        } catch {
          // No responding content script means protection is unavailable on this tab.
        }
      }
      setHealth(activeHealth);
    });
  }, []);

  const toggleProtection = async () => {
    if (!settings) return;
    const next = await updateSettings({ protectionEnabled: !settings.protectionEnabled });
    setSettings(next);
  };

  const openSettings = () => {
    const url = browser.runtime.getURL('/options.html');
    void browser.tabs.create({ url });
  };
  const openActivity = () => {
    const url = `${browser.runtime.getURL('/options.html')}#history`;
    void browser.tabs.create({ url });
  };

  const textStatus = protectionStatus(site, settings, health, 'text');
  const fileStatus = protectionStatus(site, settings, health, 'file');

  return (
    <main>
      <header>
        <div>
          <h1>PreSend</h1>
          <p>Local protection</p>
        </div>
      </header>

      <dl>
        <div>
          <dt>Protection</dt>
          <dd>
            <label className="switch-control">
              <input
                type="checkbox"
                role="switch"
                aria-label="Protection"
                checked={Boolean(settings?.protectionEnabled)}
                disabled={!settings}
                onChange={() => void toggleProtection()}
              />
              <span className="switch-track" aria-hidden="true"><span /></span>
            </label>
          </dd>
        </div>
        <div>
          <dt>Current site</dt>
          <dd>{siteChecked ? site?.name ?? 'Unsupported site' : 'Checking…'}</dd>
        </div>
        <div>
          <dt>Text protection</dt>
          <dd className={textStatus === 'Active' ? 'protected' : 'unavailable'}>{textStatus}</dd>
        </div>
        <div>
          <dt>File protection</dt>
          <dd className={fileStatus === 'Active' ? 'protected' : 'unavailable'}>{fileStatus}</dd>
        </div>
      </dl>

      <section className="today" aria-label="Current browser session activity">
        <h2>Session <small>current browser session</small></h2>
        <div>
          <span><strong>{stats.checks}</strong>Checks</span>
          <span><strong>{stats.warnings}</strong>Warnings</span>
        </div>
      </section>

      <div className="actions">
        <button type="button" onClick={openActivity}>Activity</button>
        <button type="button" className="primary" onClick={openSettings}>Settings</button>
      </div>

      <p className="privacy">Prompts and files are scanned only in your browser.</p>
    </main>
  );
}
