import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const fixture = vi.hoisted(() => ({
  privacyMode: true,
  processCwd: '/srv/runtime-private-directory' as string | undefined,
  agentCwd: '/srv/agent-private-directory',
  command: 'node worker --objective private-task-marker --token private-argument-marker'
}))

vi.mock('./system', () => ({
  useSystemStore: (selector: (state: unknown) => unknown) =>
    selector({
      state: {
        agents: [
          {
            id: 'worker-42',
            name: 'Worker',
            type: 'codex',
            status: 'active',
            source: 'process',
            pid: 42,
            workingDir: fixture.agentCwd
          }
        ],
        processes: [
          {
            name: 'workspace',
            processes: [
              { pid: 42, cpu: 3, mem: 1, command: fixture.command, cwd: fixture.processCwd }
            ]
          }
        ],
        ports: []
      }
    })
}))
vi.mock('./ui', () => ({
  useUIStore: (selector: (state: unknown) => unknown) =>
    selector({ selectedAgentId: null, selectAgent: () => {} })
}))
vi.mock('./hive', () => ({ useHiveStore: vi.fn() }))
vi.mock('./privacy', () => ({
  usePrivacyStore: (selector: (state: unknown) => unknown) => selector(fixture),
  redactSensitiveText: (value: string) => value
}))
import { AgentsPanel } from '../panels/Agents'

describe('agent runtime privacy', () => {
  beforeEach(() => {
    fixture.privacyMode = true
    fixture.processCwd = '/srv/runtime-private-directory'
  })

  it('hides the entire command and working directory in Secure View', () => {
    const markup = renderToStaticMarkup(createElement(AgentsPanel))
    expect(markup).toContain('Hidden in Secure View')
    expect(markup).toContain('Private workspace')
    expect(markup).not.toContain(fixture.command)
    expect(markup).not.toContain('private-task-marker')
    expect(markup).not.toContain('private-argument-marker')
    expect(markup).not.toContain(fixture.processCwd)
    expect(markup).not.toContain(fixture.agentCwd)
  })

  it('shows the complete command and process working directory when Secure View is off', () => {
    fixture.privacyMode = false
    const markup = renderToStaticMarkup(createElement(AgentsPanel))
    expect(markup).toContain(fixture.command)
    expect(markup).toContain(fixture.processCwd)
    expect(markup).not.toContain('Hidden in Secure View')
    expect(markup).not.toContain(fixture.agentCwd)
  })

  it.each([true, false])(
    'protects the agent directory fallback with Secure View %s',
    (privacyMode) => {
      fixture.privacyMode = privacyMode
      fixture.processCwd = undefined
      const markup = renderToStaticMarkup(createElement(AgentsPanel))
      if (privacyMode) {
        expect(markup).toContain('Private workspace')
        expect(markup).not.toContain(fixture.agentCwd)
      } else {
        expect(markup).toContain(fixture.agentCwd)
      }
    }
  )
})
