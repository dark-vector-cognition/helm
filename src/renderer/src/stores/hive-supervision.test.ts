import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { HiveSessionInfo, HiveTaskState } from '../../../shared/types'

vi.mock('./system', () => ({
  useSystemStore: (select: (state: unknown) => unknown) => select({ state: { gitRepos: [] } })
}))
vi.mock('./privacy', async () => {
  const actual = await vi.importActual<typeof import('./privacy')>('./privacy')
  return {
    ...actual,
    usePrivacyStore: (select: (state: unknown) => unknown) => select({ privacyMode: true })
  }
})
vi.mock('./hive', async () => {
  const actual = await vi.importActual<typeof import('./hive')>('./hive')
  return {
    useHiveStore: Object.assign(
      (select: (state: unknown) => unknown) => select(actual.useHiveStore.getState()),
      actual.useHiveStore
    )
  }
})
import { useHiveStore } from './hive'
import { HiveLauncher } from '../panels/HiveLauncher'

const session = (taskState?: HiveTaskState): HiveSessionInfo => ({
  id: `run-${taskState ?? 'legacy'}`,
  role: 'analyst',
  model: 'sonnet',
  tmuxSession: '',
  tmuxWindow: '',
  workingDir: '/Users/private/workspace',
  startedAt: 1000,
  status: 'running',
  ...(taskState
    ? {
        taskState,
        provider: 'codex',
        permissionMode: 'read-only',
        objective: 'Review /Users/private/workspace',
        acceptedAt: 2000,
        result: 'Result at https://private.example/review',
        events: [{ at: 2500, state: taskState, message: 'Observed /Users/private/workspace' }],
        error: taskState === 'failed' ? 'Failed at /Users/private/workspace' : undefined
      }
    : {})
})

let release: (() => void)[] = []
let api: {
  hiveListSessions: ReturnType<typeof vi.fn>
  hiveLaunchState: ReturnType<typeof vi.fn>
  onHiveSessionUpdate: ReturnType<typeof vi.fn>
  hiveSpawn: ReturnType<typeof vi.fn>
  hiveRetry: ReturnType<typeof vi.fn>
  hiveReview: ReturnType<typeof vi.fn>
  hiveKillSession: ReturnType<typeof vi.fn>
}

beforeEach(() => {
  vi.useFakeTimers()
  api = {
    hiveListSessions: vi.fn().mockResolvedValue([]),
    hiveLaunchState: vi.fn().mockResolvedValue({ enabled: true }),
    onHiveSessionUpdate: vi.fn().mockReturnValue(vi.fn()),
    hiveSpawn: vi.fn().mockResolvedValue({ success: true }),
    hiveRetry: vi.fn().mockResolvedValue({ success: true }),
    hiveReview: vi.fn().mockResolvedValue({ success: true }),
    hiveKillSession: vi.fn().mockResolvedValue({ success: true })
  }
  vi.stubGlobal('window', { helm: api })
  useHiveStore.setState({ sessions: [], enabled: false, loading: false, error: null })
})
afterEach(() => {
  release.forEach((cleanup) => cleanup())
  release = []
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const render = (): string => renderToStaticMarkup(createElement(HiveLauncher))

describe('managed agent launcher', () => {
  it('shows the platform capability reason and keeps launch disabled', async () => {
    api.hiveLaunchState.mockResolvedValue({
      enabled: false,
      reason: 'Managed agent launch is not available on Windows in this build.'
    })
    await useHiveStore.getState().refresh()
    const html = render()
    expect(html).toContain('not available on Windows')
    expect(html).toContain('disabled=""')
    expect(api.hiveSpawn).not.toHaveBeenCalled()
    useHiveStore.setState({ disabledReason: null })
  })
  it('requires explicit enablement and objective approval, with no silent global enable', () => {
    const html = render()
    expect(html).toContain('Agent launch is disabled')
    expect(html).toContain('Claude Code')
    expect(html).toContain('Cursor')
    expect(html).toContain('Codex')
    expect(html).toContain('Provider default')
    expect(html).toContain('Read only')
    expect(html).toContain('Workspace write')
    expect(html).toContain('120 seconds')
    expect(html).toMatch(/disabled=""[^>]*>Launch agent/)
    expect(api.hiveSpawn).not.toHaveBeenCalled()
  })

  it('keeps completed and failed runs inspectable, with state-specific actions and private text redaction', () => {
    useHiveStore.setState({
      enabled: true,
      sessions: [
        session('starting'),
        session('working'),
        session('stopping'),
        session('needs-review'),
        session('reviewed'),
        session('failed'),
        session('stopped'),
        session('interrupted'),
        session()
      ]
    })
    const html = render()
    for (const state of [
      'starting',
      'working',
      'stopping',
      'needs-review',
      'reviewed',
      'failed',
      'stopped',
      'interrupted'
    ])
      expect(html).toContain(`data-state="${state}"`)
    expect(html).toContain('Legacy terminal · running')
    expect(html.match(/>Mark reviewed</g)).toHaveLength(1)
    expect(html.match(/>Retry</g)).toHaveLength(3)
    expect(html.match(/>Attach legacy terminal</g)).toHaveLength(1)
    expect(html.match(/>Stop</g)).toHaveLength(3)
    expect(html).toContain('a result does not prove the objective is complete')
    expect(html).toContain('Inspect result')
    expect(html).toContain('Inspect run history')
    expect(html).toContain('/Users/operator/workspace')
    expect(html).not.toContain('/Users/private')
    expect(html).not.toContain('private.example')
    expect(html).toContain('private-gateway.redacted')
  })

  it('shares one update subscription and 2-second poll, and removes both after the last consumer', async () => {
    release.push(useHiveStore.getState().initialize(), useHiveStore.getState().initialize())
    await vi.advanceTimersByTimeAsync(0)
    expect(api.onHiveSessionUpdate).toHaveBeenCalledTimes(1)
    expect(api.hiveListSessions).toHaveBeenCalledTimes(1)
    const update = api.onHiveSessionUpdate.mock.calls[0][0]
    update([session('working')])
    expect(useHiveStore.getState().sessions[0].taskState).toBe('working')
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.hiveListSessions).toHaveBeenCalledTimes(2)
    release[0]()
    release[0]()
    expect(api.onHiveSessionUpdate.mock.results[0].value).not.toHaveBeenCalled()
    release[1]()
    expect(api.onHiveSessionUpdate.mock.results[0].value).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(4000)
    expect(api.hiveListSessions).toHaveBeenCalledTimes(2)
  })

  it('returns launch failures without losing the requested objective and recovers loading state', async () => {
    const request = {
      provider: 'cursor' as const,
      role: 'analyst',
      permissionMode: 'read-only' as const,
      workingDir: '/workspace',
      objective: 'Review the source',
      timeoutSeconds: 120
    }
    api.hiveSpawn.mockResolvedValueOnce({ success: false, error: 'Cursor is not authenticated' })
    const result = await useHiveStore.getState().spawn(request)
    expect(result.success).toBe(false)
    expect(api.hiveSpawn).toHaveBeenCalledWith(request)
    expect(request.objective).toBe('Review the source')
    expect(useHiveStore.getState()).toMatchObject({
      loading: false,
      error: 'Cursor is not authenticated'
    })
    api.hiveSpawn.mockRejectedValueOnce(new Error('disconnected'))
    expect((await useHiveStore.getState().spawn(request)).success).toBe(false)
    expect(useHiveStore.getState().loading).toBe(false)
  })

  it('refreshes after retry and review and exposes stop rejection', async () => {
    await useHiveStore.getState().retry('failed-run')
    expect(api.hiveRetry).toHaveBeenCalledWith('failed-run')
    await useHiveStore.getState().review('finished-run')
    expect(api.hiveReview).toHaveBeenCalledWith('finished-run')
    api.hiveKillSession.mockResolvedValueOnce({ success: false, error: 'Could not confirm stop' })
    await useHiveStore.getState().killSession('working-run')
    expect(useHiveStore.getState().error).toBe('Could not confirm stop')
    expect(api.hiveListSessions).toHaveBeenCalledTimes(3)
  })

  it('keeps recorded results when refresh fails and disables launch until availability returns', async () => {
    useHiveStore.setState({ enabled: true, sessions: [session('failed')] })
    api.hiveLaunchState.mockRejectedValueOnce(new Error('IPC disconnected'))
    await useHiveStore.getState().refresh()
    expect(useHiveStore.getState().sessions[0].taskState).toBe('failed')
    expect(useHiveStore.getState().enabled).toBe(false)
    expect(useHiveStore.getState().error).toContain('Could not refresh')
    await useHiveStore.getState().refresh()
    expect(useHiveStore.getState().enabled).toBe(true)
    expect(useHiveStore.getState().error).toBeNull()
  })
})
