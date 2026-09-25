import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  onMessage: undefined as ((message: unknown, sender: { tab?: { id?: number; url?: string } }) => unknown) | undefined,
  onInstalled: undefined as ((details: { reason: string }) => unknown) | undefined,
  onStartup: undefined as (() => unknown) | undefined,
  onActivated: undefined as ((activeInfo: { tabId: number }) => unknown) | undefined,
  onUpdated: undefined as ((tabId: number, changeInfo: { url?: string; status?: string }, tab: { url?: string }) => unknown) | undefined,
  initializeStorage: vi.fn(async () => undefined),
  getOnboardingCompleted: vi.fn(async () => false),
  saveIntegrationHealth: vi.fn(async () => undefined),
  recordSessionCheck: vi.fn(async () => undefined),
  createTab: vi.fn(async () => undefined),
  getTab: vi.fn(async () => ({ id: 42, url: 'https://chatgpt.com/' })),
  sendTabMessage: vi.fn(async () => undefined as unknown),
  setBadgeText: vi.fn(async () => undefined),
  setBadgeBackgroundColor: vi.fn(async () => undefined),
  setTitle: vi.fn(async () => undefined),
  getSettings: vi.fn(async () => ({
    protectionEnabled: true,
    sites: { chatgpt: true },
  })),
  cleanupHistory: vi.fn(async () => []),
}));

vi.mock('wxt/utils/define-background', () => ({
  defineBackground: (definition: unknown) => definition,
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      id: 'presend-test',
      getURL: (path: string) => `chrome-extension://presend-test${path}`,
      onMessage: {
        addListener: vi.fn((listener: typeof state.onMessage) => {
          state.onMessage = listener;
        }),
      },
      onInstalled: {
        addListener: vi.fn((listener: (details: { reason: string }) => unknown) => {
          state.onInstalled = listener;
        }),
      },
      onStartup: {
        addListener: vi.fn((listener: () => unknown) => {
          state.onStartup = listener;
        }),
      },
    },
    tabs: {
      create: state.createTab,
      get: state.getTab,
      sendMessage: state.sendTabMessage,
      onActivated: {
        addListener: vi.fn((listener: typeof state.onActivated) => {
          state.onActivated = listener;
        }),
      },
      onUpdated: {
        addListener: vi.fn((listener: typeof state.onUpdated) => {
          state.onUpdated = listener;
        }),
      },
    },
    action: {
      setBadgeText: state.setBadgeText,
      setBadgeBackgroundColor: state.setBadgeBackgroundColor,
      setTitle: state.setTitle,
    },
  },
}));

vi.mock('../src/sites', () => ({
  getSiteIntegration: ({ hostname }: { hostname: string }) =>
    hostname === 'chatgpt.com' ? { id: 'chatgpt' } : null,
}));

vi.mock('../src/history', () => ({
  cleanupHistory: state.cleanupHistory,
}));

vi.mock('../src/storage', () => ({
  storageMessageTypes: {
    saveIntegrationHealth: 'presend:save-integration-health',
    recordSessionCheck: 'presend:record-session-check',
  },
  initializeStorage: state.initializeStorage,
  getOnboardingCompleted: state.getOnboardingCompleted,
  getSettings: state.getSettings,
  saveIntegrationHealth: state.saveIntegrationHealth,
  recordSessionCheck: state.recordSessionCheck,
}));

import background from '../entrypoints/background';

describe('background storage broker', () => {
  beforeEach(() => {
    state.onMessage = undefined;
    state.onInstalled = undefined;
    state.onStartup = undefined;
    state.onActivated = undefined;
    state.onUpdated = undefined;
    state.setBadgeText.mockClear();
    state.setBadgeBackgroundColor.mockClear();
    state.setTitle.mockClear();
    state.sendTabMessage.mockReset();
    state.sendTabMessage.mockResolvedValue(undefined);
    state.getSettings.mockClear();
  });

  it('keeps session writes in the trusted background context', async () => {
    (background as unknown as () => void)();
    const health = {
      site: 'ChatGPT',
      siteId: 'chatgpt',
      protectionEnabled: true,
      protection: 'protected',
      scanner: 'ready',
      monitoringActive: true,
      textProtection: 'protected',
      fileProtection: 'unavailable',
      updatedAt: 1,
    };

    await state.onMessage?.({
      type: 'presend:save-integration-health',
      health,
    }, { tab: { id: 42, url: 'https://chatgpt.com/' } });
    await state.onMessage?.({
      type: 'presend:record-session-check',
      warningCount: 2,
    }, {});
    await state.onMessage?.({
      type: 'presend:record-session-check',
      warningCount: 'not-a-number',
    }, {});

    expect(state.saveIntegrationHealth).toHaveBeenCalledWith(health);
    expect(state.recordSessionCheck).toHaveBeenCalledOnce();
    expect(state.recordSessionCheck).toHaveBeenCalledWith(2);
    await vi.waitFor(() => {
      expect(state.setBadgeText).toHaveBeenCalledWith({ tabId: 42, text: 'ON' });
      expect(state.setBadgeBackgroundColor).toHaveBeenCalledWith({
        tabId: 42,
        color: '#2f7d32',
      });
    });
    await Promise.resolve();
    expect(state.cleanupHistory).toHaveBeenCalled();
  });

  it('refreshes toolbar state from the activated tab and keeps disabled tabs neutral', async () => {
    (background as unknown as () => void)();
    state.sendTabMessage.mockResolvedValue({
      site: 'ChatGPT',
      siteId: 'chatgpt',
      protectionEnabled: true,
      protection: 'unavailable',
      scanner: 'unavailable',
      monitoringActive: false,
      textProtection: 'unavailable',
      fileProtection: 'unavailable',
      updatedAt: 2,
    });

    await state.onActivated?.({ tabId: 42 });
    await vi.waitFor(() => {
      expect(state.setBadgeText).toHaveBeenCalledWith({ tabId: 42, text: '!' });
      expect(state.setBadgeBackgroundColor).toHaveBeenCalledWith({
        tabId: 42,
        color: '#b26a00',
      });
    });

    await state.onMessage?.({
      type: 'presend:save-integration-health',
      health: {
        site: 'ChatGPT',
        siteId: 'chatgpt',
        protectionEnabled: false,
        protection: 'unavailable',
        scanner: 'unavailable',
        monitoringActive: false,
        textProtection: 'unavailable',
        fileProtection: 'unavailable',
        updatedAt: 3,
      },
    }, { tab: { id: 42, url: 'https://chatgpt.com/' } });
    await vi.waitFor(() => {
      expect(state.setBadgeText).toHaveBeenLastCalledWith({ tabId: 42, text: '' });
    });
  });

  it('initializes storage and opens onboarding only for a first install', async () => {
    (background as unknown as () => void)();
    await state.onInstalled?.({ reason: 'install' });

    expect(state.initializeStorage).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(state.createTab).toHaveBeenCalledWith({
        url: 'chrome-extension://presend-test/onboarding.html',
      });
    });

    await state.onStartup?.();
    await Promise.resolve();
    expect(state.cleanupHistory).toHaveBeenCalled();
  });
});
