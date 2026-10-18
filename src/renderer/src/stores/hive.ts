import { create } from 'zustand'
import type { HiveSessionInfo, HiveSpawnRequest, HiveSpawnResult } from '../../../shared/types'

interface HiveStore {
  sessions: HiveSessionInfo[]
  enabled: boolean
  disabledReason: string | null
  loading: boolean
  error: string | null
  initialize: () => () => void
  refresh: () => Promise<void>
  spawn: (request: HiveSpawnRequest) => Promise<HiveSpawnResult>
  retry: (sessionId: string) => Promise<HiveSpawnResult>
  review: (sessionId: string) => Promise<void>
  killSession: (sessionId: string) => Promise<void>
  sendMessage: (sessionId: string, message: string) => Promise<{ success: boolean; error?: string }>
  attach: (sessionId: string) => Promise<void>
  updateContext: (objective: string) => Promise<void>
  getContext: () => Promise<string>
}

let subscribers = 0
let unsubscribe: (() => void) | undefined
let poll: ReturnType<typeof setInterval> | undefined

export const useHiveStore = create<HiveStore>((set, get) => {
  async function launch(action: () => Promise<HiveSpawnResult>): Promise<HiveSpawnResult> {
    set({ loading: true, error: null })
    try {
      const result = await action()
      if (result.success) await get().refresh()
      else set({ error: result.error ?? 'Launch failed' })
      return result
    } catch (err) {
      const error = `Launch error: ${err}`
      set({ error })
      return { success: false, error }
    } finally {
      set({ loading: false })
    }
  }

  async function control(
    action: () => Promise<{ success: boolean; error?: string }>
  ): Promise<void> {
    set({ error: null })
    try {
      const result = await action()
      if (!result.success) set({ error: result.error ?? 'Session action failed' })
      await get().refresh()
    } catch (err) {
      set({ error: `Session action error: ${err}` })
    }
  }

  return {
    sessions: [],
    enabled: false,
    disabledReason: null,
    loading: false,
    error: null,
    initialize: () => {
      if (subscribers++ === 0) {
        void get().refresh()
        unsubscribe = window.helm.onHiveSessionUpdate((sessions) => set({ sessions }))
        poll = setInterval(() => {
          void get().refresh()
        }, 2000)
      }
      let released = false
      return () => {
        if (released) return
        released = true
        if (--subscribers === 0) {
          unsubscribe?.()
          unsubscribe = undefined
          clearInterval(poll)
          poll = undefined
        }
      }
    },
    refresh: async () => {
      try {
        const [sessions, state] = await Promise.all([
          window.helm.hiveListSessions(),
          window.helm.hiveLaunchState()
        ])
        set((current) => ({
          sessions,
          enabled: state.enabled,
          disabledReason: state.reason ?? null,
          error: current.error?.startsWith('Could not refresh agent runs:') ? null : current.error
        }))
      } catch (err) {
        set({ enabled: false, error: `Could not refresh agent runs: ${err}` })
      }
    },
    spawn: (request) => launch(() => window.helm.hiveSpawn(request)),
    retry: (sessionId) => launch(() => window.helm.hiveRetry(sessionId)),
    review: (sessionId) => control(() => window.helm.hiveReview(sessionId)),
    killSession: (sessionId) => control(() => window.helm.hiveKillSession(sessionId)),
    sendMessage: (sessionId, message) => window.helm.hiveSendMessage(sessionId, message),
    attach: (sessionId) => control(() => window.helm.hiveAttach(sessionId)),
    updateContext: (objective) => control(() => window.helm.hiveUpdateContext(objective)),
    getContext: async () => {
      try {
        return await window.helm.hiveGetContext()
      } catch (err) {
        set({ error: `Could not load shared context: ${err}` })
        return ''
      }
    }
  }
})
