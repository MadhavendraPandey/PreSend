import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { cleanupHistory } from '../src/history';
import {
  enqueueFeedbackContribution,
  isFeedbackContributionPayload,
  retryPendingFeedbackContributions,
} from '../src/feedback-contribution';
import {
  getOnboardingCompleted,
  getSettings,
  initializeStorage,
  recordSessionCheck,
  saveIntegrationHealth,
  storageMessageTypes,
} from '../src/storage';
import { getSiteIntegration } from '../src/sites';
import type { IntegrationHealth } from '../src/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function initializeBackgroundStorage(): Promise<void> {
  await initializeStorage();
  await cleanupHistory();
  await retryPendingFeedbackContributions();
}

type ActionState = 'active' | 'unavailable' | 'neutral';

function isIntegrationHealth(value: unknown): value is IntegrationHealth {
  if (!isRecord(value)) return false;
  return typeof value.site === 'string' &&
    (value.textProtection === 'protected' || value.textProtection === 'unavailable') &&
    typeof value.monitoringActive === 'boolean' &&
    typeof value.updatedAt === 'number';
}

async function setActionState(tabId: number, state: ActionState): Promise<void> {
  const badgeText = state === 'active' ? 'ON' : state === 'unavailable' ? '!' : '';
  const title = state === 'active'
    ? 'PreSend: text protection active'
    : state === 'unavailable'
      ? 'PreSend: text protection unavailable'
      : 'PreSend';
  const updates: Promise<void>[] = [
    browser.action.setBadgeText({ tabId, text: badgeText }),
    browser.action.setTitle({ tabId, title }),
  ];
  if (state !== 'neutral') {
    updates.push(browser.action.setBadgeBackgroundColor({
      tabId,
      color: state === 'active' ? '#2f7d32' : '#b26a00',
    }));
  }
  await Promise.all(updates);
}

function actionStateForHealth(health: IntegrationHealth): ActionState {
  if (health.protectionEnabled === false) return 'neutral';
  return health.monitoringActive && health.textProtection === 'protected'
    ? 'active'
    : 'unavailable';
}

async function refreshTabAction(tabId: number, knownUrl?: string): Promise<void> {
  const tab = knownUrl ? null : await browser.tabs.get(tabId).catch(() => null);
  const url = knownUrl ?? tab?.url;
  let integration = null;
  try {
    integration = url
      ? getSiteIntegration({ hostname: new URL(url).hostname } as Location)
      : null;
  } catch {
    integration = null;
  }
  if (!integration) {
    await setActionState(tabId, 'neutral');
    return;
  }

  const settings = await getSettings().catch(() => null);
  if (!settings?.protectionEnabled || !settings.sites[integration.id]) {
    await setActionState(tabId, 'neutral');
    return;
  }

  try {
    const response: unknown = await browser.tabs.sendMessage(tabId, {
      type: storageMessageTypes.getCurrentIntegrationHealth,
    });
    await setActionState(
      tabId,
      isIntegrationHealth(response) ? actionStateForHealth(response) : 'unavailable',
    );
  } catch {
    await setActionState(tabId, 'unavailable');
  }
}

export default defineBackground(() => {
  void initializeBackgroundStorage();

  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    if (!isRecord(message)) return undefined;
    if (message.type === storageMessageTypes.saveIntegrationHealth) {
      const health = message.health as IntegrationHealth;
      if (typeof sender.tab?.id === 'number' && isIntegrationHealth(health)) {
        void setActionState(sender.tab.id, actionStateForHealth(health));
      }
      return saveIntegrationHealth(health);
    }
    if (
      message.type === storageMessageTypes.recordSessionCheck &&
      typeof message.warningCount === 'number' &&
      Number.isFinite(message.warningCount)
    ) {
      return recordSessionCheck(message.warningCount);
    }
    if (
      message.type === storageMessageTypes.submitFeedbackContribution &&
      isFeedbackContributionPayload(message.payload)
    ) {
      return enqueueFeedbackContribution(message.payload);
    }
    if (message.type === storageMessageTypes.retryFeedbackContributions) {
      return retryPendingFeedbackContributions();
    }
    return undefined;
  });

  browser.tabs.onActivated.addListener(({ tabId }) => {
    void refreshTabAction(tabId);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === 'complete') {
      void refreshTabAction(tabId, changeInfo.url ?? tab.url);
    }
  });

  browser.runtime.onStartup.addListener(() => {
    void initializeBackgroundStorage();
  });

  browser.runtime.onInstalled.addListener((details) => {
    void (async () => {
      await initializeBackgroundStorage();
      if (details.reason !== 'install' || await getOnboardingCompleted()) return;
      await browser.tabs.create({ url: browser.runtime.getURL('/onboarding.html') });
    })();
  });
});
