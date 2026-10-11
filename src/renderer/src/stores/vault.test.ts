import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useVaultStore } from './vault'

const api = {
  vaultHealth: vi.fn(), vaultSearch: vi.fn(), vaultOpenChunk: vi.fn(),
  vaultReindex: vi.fn(), vaultPushNote: vi.fn(), vaultPullSync: vi.fn()
}
const state = () => useVaultStore.getState()
beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('window', { helm: api })
  useVaultStore.setState(useVaultStore.getInitialState(), true)
})
afterEach(() => vi.unstubAllGlobals())

describe('Vault IPC integration', () => {
  it('passes real search and chunk results through the bridge', async () => {
    const row = { chunk_id: 'real-chunk' }
    api.vaultHealth.mockResolvedValue({ online: true, total_chunks: 42 })
    api.vaultSearch.mockResolvedValue({ results: [row], result_count: 1 })
    api.vaultOpenChunk.mockResolvedValue({ ...row, text: 'Real saved content' })
    await state().checkHealth()
    state().setQuery('saved content')
    await state().search()
    await state().openChunk('real-chunk')
    expect(api.vaultSearch).toHaveBeenCalledWith('saved content', { top_k: 8 })
    expect(state().health?.total_chunks).toBe(42)
    expect(state().results).toEqual([row])
    expect(state().activeChunk?.text).toBe('Real saved content')
  })

  it('waits for confirmed persistence and preserves failed drafts', async () => {
    state().setPushModalOpen(true)
    api.vaultPushNote.mockResolvedValue({ success: false, error: 'Disk full' })
    await state().pushNote('Title', 'Body', 'Inbox', ['tag'])
    expect(api.vaultPushNote).toHaveBeenCalledWith('Title', 'Body', 'Inbox', ['tag'])
    expect(state().pushModalOpen).toBe(true)
    expect(state().lastOperation).toMatchObject({ success: false, message: 'Disk full' })
    api.vaultPushNote.mockResolvedValue({ success: true, file_path: '/vault/Inbox/Title.md' })
    await state().pushNote('Title', 'Body', 'Inbox', ['tag'])
    expect(state().pushModalOpen).toBe(false)
    expect(state().lastOperation?.message).toContain('/vault/Inbox/Title.md')
  })

  it('never reports success for failed operations or disconnected IPC', async () => {
    api.vaultSearch.mockResolvedValue({ error: 'Search unavailable' })
    api.vaultOpenChunk.mockResolvedValue({ error: 'Chunk unavailable' })
    api.vaultReindex.mockResolvedValue({ success: false, error: 'Reindex unavailable' })
    api.vaultPullSync.mockRejectedValue(new Error('Sync unavailable'))
    state().setQuery('query')
    for (const operation of [() => state().search(), () => state().openChunk('id'),
      () => state().triggerReindex(), () => state().pullSync()]) {
      await operation()
      expect(state().lastOperation?.success).toBe(false)
    }
    expect(state()).toMatchObject({ searching: false, chunkLoading: false, reindexing: false, pulling: false })
  })

  it('reports actual reindex and sync counts', async () => {
    api.vaultReindex.mockResolvedValue({ success: true, files_processed: 7 })
    api.vaultPullSync.mockResolvedValue({ success: true, files_updated: 2 })
    await state().triggerReindex()
    expect(state().lastOperation?.message).toBe('Reindexed 7 files')
    await state().pullSync()
    expect(state().lastOperation?.message).toBe('Pulled 2 files')
    expect(api.vaultHealth).toHaveBeenCalledTimes(2)
  })
})
