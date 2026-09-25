import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../entrypoints/popup/App';

const state = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  createTab: vi.fn(async () => undefined),
  healthyResponse: {
    site: 'ChatGPT',
    siteId: 'chatgpt',
    protection: 'protected',
    scanner: 'ready',
    textProtection: 'protected',
    fileProtection: 'protected',
    updatedAt: 123,
  },
}));

vi.mock('wxt/browser', () => ({
  browser: {
    tabs: {
      query: vi.fn(async () => [{ id: 42, url: 'https://chatgpt.com/' }]),
      sendMessage: state.sendMessage,
      create: state.createTab,
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://presend-test${path}`,
      openOptionsPage: vi.fn(async () => undefined),
    },
  },
}));

vi.mock('../src/storage', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/storage')>();
  const defaults = original.DEFAULT_SETTINGS;
  return {
    ...original,
    getSettings: vi.fn(async () => ({
      ...defaults,
      sites: { ...defaults.sites },
      detectors: { ...defaults.detectors },
      history: { ...defaults.history },
    })),
    getSessionStats: vi.fn(async () => ({ date: '2026-09-24', checks: 3, warnings: 1 })),
    updateSettings: vi.fn(async () => defaults),
  };
});

describe('popup current-tab health', () => {
  beforeEach(() => {
    state.sendMessage.mockReset();
    state.sendMessage.mockResolvedValue(state.healthyResponse);
    state.createTab.mockClear();
    document.body.replaceChildren(document.createElement('div'));
    document.body.firstElementChild!.id = 'root';
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('queries the active tab content script instead of using stale site-wide health', async () => {
    const root = createRoot(document.getElementById('root')!);
    await act(async () => {
      root.render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(state.sendMessage).toHaveBeenCalledWith(42, {
      type: 'presend:get-current-integration-health',
    });
    expect(document.body.textContent).toContain('ChatGPT');
    expect(document.body.textContent?.match(/Active/g)).toHaveLength(2);
    expect(document.body.textContent).not.toContain('Protected');
    const protectionSwitch = document.querySelector<HTMLInputElement>('[role="switch"]');
    expect(protectionSwitch?.checked).toBe(true);
    expect(document.body.textContent).not.toContain('Change');

    await act(async () => root.unmount());
  });

  it('reports both protections unavailable when the current tab cannot be contacted', async () => {
    state.sendMessage.mockRejectedValueOnce(new Error('No receiver in current tab'));
    const root = createRoot(document.getElementById('root')!);
    await act(async () => {
      root.render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(document.body.textContent?.match(/Protection unavailable/g)).toHaveLength(2);

    await act(async () => root.unmount());
  });

  it('opens distinct Activity and Settings views', async () => {
    const root = createRoot(document.getElementById('root')!);
    await act(async () => {
      root.render(<App />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
    await act(async () => buttons.find((button) => button.textContent === 'Activity')!.click());
    await act(async () => buttons.find((button) => button.textContent === 'Settings')!.click());

    expect(state.createTab).toHaveBeenNthCalledWith(1, {
      url: 'chrome-extension://presend-test/options.html#history',
    });
    expect(state.createTab).toHaveBeenNthCalledWith(2, {
      url: 'chrome-extension://presend-test/options.html',
    });

    await act(async () => root.unmount());
  });
});
