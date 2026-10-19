import { describe, it, expect } from 'vitest'
import { detectAgents } from './agents'
import type { ProcessInfo } from '../../shared/types'

const mockProcesses: ProcessInfo[] = [
  {
    pid: 2345,
    user: 'testuser',
    cpu: 12.1,
    mem: 3.4,
    command: '/home/testuser/.nvm/versions/node/v22.0.0/bin/node /usr/local/bin/claude',
    name: 'node',
    cwd: '/home/testuser/projects/sample-app'
  },
  {
    pid: 5678,
    user: 'testuser',
    cpu: 1.2,
    mem: 0.8,
    command: '/usr/local/bin/codex --task refactor',
    name: 'codex',
    cwd: '/home/testuser/projects/health-scoring'
  },
  {
    pid: 1234,
    user: 'testuser',
    cpu: 5.2,
    mem: 1.3,
    command: 'node /home/testuser/projects/sample-app/node_modules/.bin/vite',
    name: 'node',
    cwd: '/home/testuser/projects/sample-app'
  }
]

describe('detectAgents', () => {
  it('identifies Claude Code processes', () => {
    const agents = detectAgents(mockProcesses)
    const claude = agents.find((a) => a.type === 'claude-code')
    expect(claude).toBeDefined()
    expect(claude!.pid).toBe(2345)
    expect(claude!.name).toBe('Claude Code')
  })

  it('identifies Codex processes', () => {
    const agents = detectAgents(mockProcesses)
    const codex = agents.find((a) => a.type === 'codex')
    expect(codex).toBeDefined()
    expect(codex!.pid).toBe(5678)
  })

  it('does not detect Codex desktop app-server processes', () => {
    const procs: ProcessInfo[] = [
      {
        pid: 88081,
        user: 'test',
        cpu: 12.9,
        mem: 0.4,
        command:
          '/Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled',
        name: 'codex'
      }
    ]
    const agents = detectAgents(procs)
    expect(agents).toHaveLength(0)
  })

  it('does not count desktop GPU or service helpers as Codex CLI agents', () => {
    const processes = ['--type=gpu-process', '--type=utility', 'app-server'].map((args, i) => ({
      pid: 1000 + i,
      user: 'test',
      cpu: 20,
      mem: 1,
      name: 'codex',
      command: `/Applications/ChatGPT.app/Contents/Frameworks/Codex Framework.framework/Helpers/Codex (Service).app/Contents/MacOS/Codex (Service) ${args}`
    }))
    expect(detectAgents(processes)).toEqual([])
  })

  it('does not flag non-agent processes', () => {
    const agents = detectAgents(mockProcesses)
    expect(agents.length).toBe(2)
  })

  it('detects working directory for agents', () => {
    const agents = detectAgents(mockProcesses)
    const claude = agents.find((a) => a.type === 'claude-code')
    expect(claude!.workingDir).toBe('/home/testuser/projects/sample-app')
  })

  it('identifies Cursor processes', () => {
    const procs: ProcessInfo[] = [
      {
        pid: 9001,
        user: 'test',
        cpu: 8,
        mem: 2,
        command: '/Applications/Cursor.app/Contents/MacOS/cursor',
        name: 'cursor'
      }
    ]
    const agents = detectAgents(procs)
    expect(agents).toHaveLength(1)
    expect(agents[0].type).toBe('cursor')
    expect(agents[0].name).toBe('Cursor')
    expect(agents[0].status).toBe('unknown')
  })

  it.each([
    '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Renderer).app/Contents/MacOS/Cursor Helper (Renderer) --type=renderer',
    '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper --type=gpu-process',
    '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Plugin).app/Contents/MacOS/Cursor Helper (Plugin) --type=utility',
    '/Applications/Cursor.app/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler',
    '/Applications/Cursor.app/Contents/MacOS/cursor --type gpu-process'
  ])('excludes the Cursor helper %s while retaining the main app', (command) => {
    const procs: ProcessInfo[] = [
      { pid: 1, user: 'test', cpu: 8, mem: 1, command: '/Applications/Cursor.app/Contents/MacOS/cursor', name: 'cursor' },
      { pid: 2, user: 'test', cpu: 90, mem: 1, command, name: 'cursor' }
    ]

    const agents = detectAgents(procs)

    expect(agents).toHaveLength(1)
    expect(agents[0]).toMatchObject({ pid: 1, type: 'cursor', status: 'unknown' })
  })

  it.each(['cursor-agent --print', '/usr/local/bin/cursor-agent --print'])('detects the explicit Cursor CLI %s', (command) => {
    const procs: ProcessInfo[] = [
      { pid: 1, user: 'test', cpu: 10, mem: 1, command, name: 'cursor-agent' }
    ]

    expect(detectAgents(procs)).toMatchObject([{ pid: 1, type: 'cursor', status: 'unknown' }])
  })

  it.each([
    '/usr/local/bin/agent --task build',
    '/usr/bin/python agent.py',
    'echo cursor-agent',
    'node /projects/cursor-agent/server.js',
    '/usr/local/bin/cursor-agent-tool'
  ])('does not mistake unrelated command %s for Cursor CLI', (command) => {
    expect(detectAgents([
      { pid: 1, user: 'test', cpu: 10, mem: 1, command, name: 'agent' }
    ])).toEqual([])
  })

  it('preserves deduplication without inferring task activity from CPU', () => {
    const procs: ProcessInfo[] = [
      { pid: 1, user: 'test', cpu: 0, mem: 1, command: 'cursor-agent', name: 'cursor-agent', cwd: '/projects/example' },
      { pid: 2, user: 'test', cpu: 30, mem: 1, command: 'cursor-agent --print', name: 'cursor-agent', cwd: '/projects/example' }
    ]

    expect(detectAgents(procs)).toMatchObject([{ pid: 2, type: 'cursor', status: 'unknown' }])
    expect(detectAgents(procs)).toHaveLength(1)
  })

  it('identifies Aider processes', () => {
    const procs: ProcessInfo[] = [
      {
        pid: 9002,
        user: 'test',
        cpu: 3,
        mem: 1,
        command: '/usr/local/bin/aider --model gpt-4',
        name: 'aider'
      }
    ]
    const agents = detectAgents(procs)
    expect(agents).toHaveLength(1)
    expect(agents[0].type).toBe('aider')
    expect(agents[0].name).toBe('Aider')
  })

  it('identifies Continue processes', () => {
    const procs: ProcessInfo[] = [
      {
        pid: 9003,
        user: 'test',
        cpu: 2,
        mem: 0.5,
        command: '/extensions/.continue/server',
        name: 'continue'
      }
    ]
    const agents = detectAgents(procs)
    expect(agents).toHaveLength(1)
    expect(agents[0].type).toBe('continue')
    expect(agents[0].name).toBe('Continue')
  })

  it('identifies Gemini CLI processes without duplicating the node wrapper', () => {
    const procs: ProcessInfo[] = [
      {
        pid: 9005,
        user: 'test',
        cpu: 4,
        mem: 1,
        command: 'node /opt/homebrew/bin/gemini --skip-trust',
        name: 'node',
        cwd: '/home/test/projects/helm'
      },
      {
        pid: 9006,
        user: 'test',
        cpu: 0,
        mem: 1,
        command:
          '/opt/homebrew/Cellar/node/26.0.0/bin/node --max-old-space-size=9216 /opt/homebrew/bin/gemini --skip-trust',
        name: 'node',
        cwd: '/home/test/projects/helm'
      }
    ]
    const agents = detectAgents(procs)
    expect(agents).toHaveLength(1)
    expect(agents[0].type).toBe('gemini')
    expect(agents[0].name).toBe('Gemini')
  })

  it('does not detect Gemini Desktop as a standing agent', () => {
    const procs: ProcessInfo[] = [
      {
        pid: 9005,
        user: 'test',
        cpu: 4,
        mem: 1,
        command:
          '/home/test/Applications/Chrome Apps.localized/Gemini.app/Contents/MacOS/app_mode_loader',
        name: 'app_mode_loader'
      }
    ]
    const agents = detectAgents(procs)
    expect(agents).toHaveLength(0)
  })

  it('does not detect Claude Desktop as Claude Code', () => {
    const procs: ProcessInfo[] = [
      {
        pid: 674,
        user: 'test',
        cpu: 6,
        mem: 0.6,
        command: '/Applications/Claude.app/Contents/MacOS/Claude',
        name: 'Claude'
      }
    ]
    const agents = detectAgents(procs)
    expect(agents).toHaveLength(0)
  })

  it('does not detect Claude-adjacent Stream Deck plugins as Claude Code', () => {
    const procs: ProcessInfo[] = [
      {
        pid: 51005,
        user: 'test',
        cpu: 12,
        mem: 0.8,
        command: '/home/test/projects/claude-pet/com.example.claude-pet.sdPlugin/bin/plugin.js',
        name: 'node'
      }
    ]
    const agents = detectAgents(procs)
    expect(agents).toHaveLength(0)
  })

  it('does not detect codex helper tooling as the main Codex agent', () => {
    const procs: ProcessInfo[] = [
      {
        pid: 68259,
        user: 'test',
        cpu: 0,
        mem: 0,
        command: 'node /opt/homebrew/bin/codex-cli-mcp-tool',
        name: 'node'
      }
    ]
    const agents = detectAgents(procs)
    expect(agents).toHaveLength(0)
  })

  it('does not detect Codex Computer Use services as Codex agents', () => {
    const procs: ProcessInfo[] = [
      {
        pid: 14052,
        user: 'test',
        cpu: 29,
        mem: 0.5,
        command:
          '/home/test/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService',
        name: 'SkyComputerUseService'
      }
    ]
    const agents = detectAgents(procs)
    expect(agents).toHaveLength(0)
  })

  it('does not detect one-shot Codex exec jobs as standing Codex agents', () => {
    const procs: ProcessInfo[] = [
      {
        pid: 31977,
        user: 'test',
        cpu: 2.3,
        mem: 0.4,
        command:
          'codex exec --json --skip-git-repo-check --ephemeral --sandbox read-only --model gpt-5.5',
        name: 'codex'
      }
    ]
    const agents = detectAgents(procs)
    expect(agents).toHaveLength(0)
  })

  it('ignores Codex desktop processes and keeps the real CLI agent', () => {
    const procs: ProcessInfo[] = [
      {
        pid: 87935,
        user: 'test',
        cpu: 51.9,
        mem: 0.4,
        command:
          '/Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper --type=gpu-process',
        name: 'Codex'
      },
      {
        pid: 88079,
        user: 'test',
        cpu: 42.6,
        mem: 2.3,
        command:
          '/Applications/Codex.app/Contents/Frameworks/Codex Helper (Renderer).app/Contents/MacOS/Codex Helper (Renderer) --type=renderer',
        name: 'Codex'
      },
      {
        pid: 88081,
        user: 'test',
        cpu: 5.7,
        mem: 0.5,
        command:
          '/Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled',
        name: 'codex'
      },
      {
        pid: 87901,
        user: 'test',
        cpu: 0.4,
        mem: 0.8,
        command: '/Applications/Codex.app/Contents/MacOS/Codex',
        name: 'Codex'
      },
      {
        pid: 87937,
        user: 'test',
        cpu: 0,
        mem: 0.2,
        command:
          '/Applications/Codex.app/Contents/Frameworks/Codex Helper.app/Contents/MacOS/Codex Helper --type=utility --utility-sub-type=network.mojom.NetworkService',
        name: 'Codex'
      },
      {
        pid: 99001,
        user: 'test',
        cpu: 0.4,
        mem: 0.8,
        command:
          '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex',
        name: 'codex',
        cwd: '/home/test/projects/helm'
      }
    ]
    const agents = detectAgents(procs)
    expect(agents).toHaveLength(1)
    expect(agents[0].type).toBe('codex')
    expect(agents[0].pid).toBe(99001)
    expect(agents[0].name).toBe('Codex')
  })

  it('does not mistake CursorUIViewService for the Cursor editor', () => {
    const procs: ProcessInfo[] = [
      {
        pid: 809,
        user: 'test',
        cpu: 0,
        mem: 0.1,
        command:
          '/System/Library/PrivateFrameworks/TextInputUIMacHelper.framework/Versions/A/XPCServices/CursorUIViewService.xpc/Contents/MacOS/CursorUIViewService',
        name: 'CursorUIViewService'
      }
    ]
    const agents = detectAgents(procs)
    expect(agents).toHaveLength(0)
  })

  it('numbers multiple instances of same agent type', () => {
    const procs: ProcessInfo[] = [
      { pid: 100, user: 'test', cpu: 10, mem: 1, command: '/usr/local/bin/claude', name: 'claude' },
      { pid: 101, user: 'test', cpu: 5, mem: 1, command: 'claude', name: 'claude' }
    ]
    const agents = detectAgents(procs)
    expect(agents).toHaveLength(2)
    expect(agents[0].name).toBe('Claude Code')
    expect(agents[1].name).toBe('Claude Code #2')
  })

  it('identifies Copilot processes', () => {
    const procs: ProcessInfo[] = [
      {
        pid: 9004,
        user: 'test',
        cpu: 6,
        mem: 1.5,
        command: '/usr/lib/github-copilot/copilot-agent',
        name: 'copilot-agent'
      }
    ]
    const agents = detectAgents(procs)
    expect(agents).toHaveLength(1)
    expect(agents[0].type).toBe('copilot')
    expect(agents[0].name).toBe('Copilot')
  })

  it.each([0, 0.5, 1, 3, 5.1, 10, 100])('keeps task state unknown at CPU %s%%', (cpu) => {
    const procs: ProcessInfo[] = [
      { pid: 100, user: 'test', cpu, mem: 1, command: '/usr/local/bin/claude', name: 'claude' }
    ]

    const agents = detectAgents(procs)

    expect(agents[0].status).toBe('unknown')
    expect(agents[0].source).toBe('process')
    expect(procs[0].cpu).toBe(cpu)
  })

  it('keeps every detected provider task state unknown', () => {
    const commands = [
      'claude', 'codex', 'gemini', 'cursor', 'aider',
      '/extensions/.continue/server', '/usr/lib/github-copilot/copilot-agent'
    ]
    const procs = commands.map((command, index) => ({
      pid: index + 100, user: 'test', cpu: 30, mem: 1, command, name: command
    }))

    const agents = detectAgents(procs)

    expect(agents).toHaveLength(7)
    expect(agents.every((agent) => agent.status === 'unknown')).toBe(true)
  })
})
