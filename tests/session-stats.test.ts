import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageState = vi.hoisted(() => ({
  local: {} as Record<string, unknown>,
  session: {} as Record<string, unknown>,
}));

function storageArea(area: 'local' | 'session') {
  return {
    get: vi.fn(async (key: string) => ({ [key]: storageState[area][key] })),
    set: vi.fn(async (values: Record<string, unknown>) => {
      Object.assign(storageState[area], values);
    }),
    clear: vi.fn(async () => {
      storageState[area] = {};
    }),
  };
}

vi.mock('wxt/browser', () => ({
  browser: {
    storage: {
      local: storageArea('local'),
      session: storageArea('session'),
    },
  },
}));

import { getSessionStats, recordSessionCheck } from '../src/storage';

describe('session-only popup counts', () => {
  beforeEach(() => {
    storageState.local = {};
    storageState.session = {};
  });

  it('counts checks and warnings without prompt data', async () => {
    const now = new Date(2026, 8, 23, 14, 0, 0);
    await recordSessionCheck(0, now);
    await recordSessionCheck(2, now);

    expect(await getSessionStats(now)).toEqual({
      date: '2026-09-23',
      checks: 2,
      warnings: 2,
    });
    const serialized = JSON.stringify(storageState.session);
    expect(serialized).not.toContain('prompt');
    expect(serialized).not.toContain('originalValue');
  });

  it('starts a fresh counter on a new local date', async () => {
    await recordSessionCheck(3, new Date(2026, 8, 23, 23, 59, 0));
    expect(await getSessionStats(new Date(2026, 8, 24, 0, 1, 0))).toEqual({
      date: '2026-09-24',
      checks: 0,
      warnings: 0,
    });
  });
});
