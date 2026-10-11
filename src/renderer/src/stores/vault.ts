import { create } from 'zustand'
import type { VaultSearchResult, VaultChunk, VaultHealthStatus } from '../../../shared/types'
export type { VaultSearchResult, VaultChunk, VaultHealthStatus } from '../../../shared/types'

interface VaultSearchFilters { client?: string; doc_type?: string; top_k: number }
interface VaultOperation { type: string; success: boolean; message: string; timestamp: number }
function failure(type: string, error: unknown): VaultOperation {
  return { type, success: false, message: error instanceof Error ? error.message : String(error), timestamp: Date.now() }
}

interface VaultStore {
  health: VaultHealthStatus | null
  healthLoading: boolean

  query: string
  filters: VaultSearchFilters
  results: VaultSearchResult[]
  searching: boolean
  lastSearchTime: number | null

  activeChunk: VaultChunk | null
  chunkLoading: boolean

  reindexing: boolean
  pushing: boolean
  pulling: boolean
  lastOperation: VaultOperation | null

  pushModalOpen: boolean

  setQuery: (q: string) => void
  setFilters: (f: Partial<VaultSearchFilters>) => void
  checkHealth: () => Promise<void>
  search: () => Promise<void>
  openChunk: (chunkId: string) => Promise<void>
  closeChunk: () => void
  triggerReindex: () => Promise<void>
  pushNote: (title: string, content: string, folder?: string, tags?: string[]) => Promise<void>
  pullSync: () => Promise<void>
  setPushModalOpen: (open: boolean) => void
}

export const useVaultStore = create<VaultStore>((set, get) => ({
  health: null, healthLoading: false,
  query: '', filters: { top_k: 8 }, results: [], searching: false, lastSearchTime: null,
  activeChunk: null, chunkLoading: false,
  reindexing: false, pushing: false, pulling: false, lastOperation: null, pushModalOpen: false,
  setQuery: (query) => set({ query }),
  setFilters: (filters) => set((state) => ({ filters: { ...state.filters, ...filters } })),
  setPushModalOpen: (pushModalOpen) => set({ pushModalOpen }),
  checkHealth: async () => {
    set({ healthLoading: true })
    try {
      set({ health: await window.helm.vaultHealth() })
    } catch (error) {
      set({ health: { online: false, endpoint: get().health?.endpoint ?? '', qdrant_ok: false,
        last_check: Date.now(), last_reindex: null, total_chunks: null, error: failure('health', error).message } })
    } finally { set({ healthLoading: false }) }
  },
  search: async () => {
    const { query, filters } = get()
    if (!query.trim()) return
    set({ searching: true, results: [] })
    try {
      const response = await window.helm.vaultSearch(query, filters)
      if (response.error) throw new Error(response.error)
      set({ results: response.results, lastSearchTime: Date.now() })
    } catch (error) { set({ lastOperation: failure('search', error) }) }
    finally { set({ searching: false }) }
  },
  openChunk: async (chunkId) => {
    set({ chunkLoading: true, activeChunk: null })
    try {
      const chunk = await window.helm.vaultOpenChunk(chunkId)
      if ('error' in chunk) throw new Error(chunk.error)
      set({ activeChunk: chunk })
    } catch (error) { set({ lastOperation: failure('chunk', error) }) }
    finally { set({ chunkLoading: false }) }
  },
  closeChunk: () => set({ activeChunk: null }),
  triggerReindex: async () => {
    set({ reindexing: true })
    try {
      const result = await window.helm.vaultReindex()
      if (!result.success) throw new Error(result.error ?? 'Reindex failed')
      set({ lastOperation: { type: 'reindex', success: true,
        message: result.files_processed === null ? 'Reindex completed' : `Reindexed ${result.files_processed} files`, timestamp: Date.now() } })
      await get().checkHealth()
    } catch (error) { set({ lastOperation: failure('reindex', error) }) }
    finally { set({ reindexing: false }) }
  },
  pushNote: async (title, content, folder, tags) => {
    set({ pushing: true })
    try {
      const result = await window.helm.vaultPushNote(title, content, folder, tags)
      if (!result.success || !result.file_path) throw new Error(result.error ?? 'Note was not saved')
      set({ pushModalOpen: false, lastOperation: { type: 'push', success: true,
        message: `Saved to ${result.file_path}`, timestamp: Date.now() } })
    } catch (error) { set({ lastOperation: failure('push', error) }) }
    finally { set({ pushing: false }) }
  },
  pullSync: async () => {
    set({ pulling: true })
    try {
      const result = await window.helm.vaultPullSync()
      if (!result.success) throw new Error(result.error ?? 'Pull failed')
      set({ lastOperation: { type: 'pull', success: true,
        message: `Pulled ${result.files_updated} files`, timestamp: Date.now() } })
      await get().checkHealth()
    } catch (error) { set({ lastOperation: failure('pull', error) }) }
    finally { set({ pulling: false }) }
  }
}))
