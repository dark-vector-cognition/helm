import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('Signal adoption', () => {
  it('adopts Signal once and preserves a subsequent palette choice', async () => {
    const data = new Map([
      ['helm-shell-skin', JSON.stringify({ state: { activeSkin: 'phantom' }, version: 0 })]
    ])
    const localStorage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => data.set(key, value),
      removeItem: (key: string) => data.delete(key)
    }
    vi.stubGlobal('window', { localStorage })
    const first = await import('./skin')
    expect(first.useSkinStore.getState().activeSkin).toBe('signal')
    expect(first.HELM_SKINS.map((s) => s.id)).toContain('phantom')
    first.useSkinStore.getState().setActiveSkin('phantom')
    vi.resetModules()
    const reopened = await import('./skin')
    expect(reopened.useSkinStore.getState().activeSkin).toBe('phantom')
  })
})
