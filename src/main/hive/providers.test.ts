import { describe, expect, it } from 'vitest'
import { buildProviderCommand, parseProviderEvent } from './providers'
import type { HiveProvider, HiveSpawnRequest } from '../../shared/types'

const request: HiveSpawnRequest = {
  role: 'analyst',
  workingDir: '/tmp/repo with spaces',
  objective: 'Read sample.txt; $(do-not-execute)'
}

describe('provider commands', () => {
  it('defaults to a confined read-only Claude invocation without customizations or MCP', () => {
    const command = buildProviderCommand(request, '/Applications/Claude Code/claude')
    expect(command.command).toBe('/Applications/Claude Code/claude')
    expect(command.args).toEqual(expect.arrayContaining([
      '--restricted', '--safe-mode', '--strict-mcp-config', '--no-session-persistence'
    ]))
    expect(command.args[command.args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep')
    expect(command.args[command.args.indexOf('--permission-mode') + 1]).toBe('plan')
    expect(command.args[command.args.indexOf('--permission-prompts') + 1]).toBe('none')
  })

  it.each<HiveProvider>(['claude-code', 'cursor', 'codex'])('keeps the %s objective off the process arguments', (provider) => {
    const { args } = buildProviderCommand({ ...request, provider })
    expect(args.join(' ')).not.toContain(request.objective)
    expect(args.join(' ')).not.toMatch(/bypass|--force|--trust|--yolo|--approve/)
    expect(args).not.toContain('--ignore-rules')
  })

  it('uses sandboxed Cursor ask mode by default and keeps workspace paths as one argument', () => {
    const { command, args } = buildProviderCommand({ ...request, provider: 'cursor', model: 'opus' })
    expect(command).toBe('cursor-agent')
    expect(args[args.indexOf('--mode') + 1]).toBe('ask')
    expect(args[args.indexOf('--sandbox') + 1]).toBe('enabled')
    expect(args[args.indexOf('--workspace') + 1]).toBe(request.workingDir)
    expect(args).not.toContain('--model')
  })

  it('uses the Codex read-only sandbox, ignores unrelated user config, and retains policy rules', () => {
    const { command, args } = buildProviderCommand({ ...request, provider: 'codex' })
    expect(command).toBe('codex')
    expect(args).toEqual(['exec', '--json', '--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '--color', 'never', '--cd', request.workingDir, '-'])
  })

  it('only expands Claude file tools for explicit workspace-write requests', () => {
    const { args } = buildProviderCommand({ ...request, permissionMode: 'workspace-write', model: 'haiku' })
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep,Edit,Write')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
    expect(args[args.indexOf('--model') + 1]).toBe('haiku')
  })

  it.each<HiveProvider>(['cursor', 'codex'])('keeps provider enforcement for explicit %s workspace-write', (provider) => {
    const { args } = buildProviderCommand({ ...request, provider, permissionMode: 'workspace-write' })
    expect(args[args.indexOf('--sandbox') + 1]).toBe(provider === 'cursor' ? 'enabled' : 'workspace-write')
    expect(args).not.toContain('ask')
  })

  it('rejects invalid providers, permission modes and Claude aliases', () => {
    expect(() => buildProviderCommand({ ...request, provider: 'unknown' as HiveProvider })).toThrow('provider')
    expect(() => buildProviderCommand({ ...request, permissionMode: 'anything' as never })).toThrow('permission')
    expect(() => buildProviderCommand({ ...request, model: '--dangerous' as never })).toThrow('model')
  })
})

describe('provider event parsing', () => {
  it.each<HiveProvider>(['claude-code', 'cursor', 'codex'])('ignores malformed and invented %s completion events', (provider) => {
    for (const event of [null, [], 'done', 7, {}, { type: 'success' }, { success: true, result: 'done' }]) {
      expect(parseProviderEvent(provider, event)).toBeNull()
    }
  })

  it.each<HiveProvider>(['claude-code', 'cursor'])('distinguishes %s initialization, task acceptance and final result', (provider) => {
    expect(parseProviderEvent(provider, { type: 'system', subtype: 'init' })).toEqual({ activity: 'Session initialized' })
    expect(parseProviderEvent(provider, { type: 'assistant', message: { role: 'assistant', content: [] } })).toMatchObject({ accepted: true })
    expect(parseProviderEvent(provider, { type: 'result', subtype: 'success', is_error: false, result: 'Found 2 issues' })).toEqual({ accepted: true, result: 'Found 2 issues', finished: true })
    expect(parseProviderEvent(provider, { type: 'result', subtype: 'success', result: 'unverified' })).toBeNull()
    expect(parseProviderEvent(provider, { type: 'result', subtype: 'success', is_error: false, result: '' })).toBeNull()
  })

  it('does not retain raw Cursor tool arguments in activity', () => {
    expect(parseProviderEvent('cursor', { type: 'tool_call', subtype: 'started', tool_call: { shellToolCall: { command: 'private command' } } })).toEqual({ accepted: true, activity: 'Tool started' })
    expect(parseProviderEvent('cursor', { type: 'tool_call', subtype: 'completed' })).toEqual({ accepted: true, activity: 'Tool completed' })
  })

  it.each<HiveProvider>(['claude-code', 'cursor'])('handles explicit %s terminal errors without treating them as results', (provider) => {
    expect(parseProviderEvent(provider, { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Permission denied'] })).toEqual({ error: 'Permission denied', finished: true })
    expect(parseProviderEvent(provider, { type: 'result', is_error: true, result: 'Quota reached' })).toEqual({ error: 'Quota reached', finished: true })
  })

  it('waits for Codex turn completion after the final agent message', () => {
    expect(parseProviderEvent('codex', { type: 'thread.started', thread_id: 'example' })).toEqual({ activity: 'Session initialized' })
    expect(parseProviderEvent('codex', { type: 'turn.started' })).toEqual({ accepted: true, activity: 'Objective received' })
    expect(parseProviderEvent('codex', { type: 'item.completed', item: { type: 'agent_message', text: 'Verified sample.txt' } })).toEqual({ accepted: true, result: 'Verified sample.txt', activity: 'Agent responded' })
    expect(parseProviderEvent('codex', { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2 } })).toEqual({ finished: true })
    expect(parseProviderEvent('codex', { type: 'turn.completed' })).toBeNull()
  })

  it('preserves Codex failures and generic activity without tool output', () => {
    expect(parseProviderEvent('codex', { type: 'turn.failed', error: { message: 'Permission denied' } })).toEqual({ error: 'Permission denied', finished: true })
    expect(parseProviderEvent('codex', { type: 'error', message: 'Stream disconnected' })).toEqual({ error: 'Stream disconnected' })
    expect(parseProviderEvent('codex', { type: 'item.started', item: { type: 'command_execution', command: 'private command' } })).toEqual({ accepted: true, activity: 'Agent working' })
  })

  it('bounds results and errors and removes terminal escapes', () => {
    expect(parseProviderEvent('claude-code', { type: 'result', subtype: 'success', is_error: false, result: '\u001b[31mresult\u001b[0m' })?.result).toBe('result')
    expect(parseProviderEvent('codex', { type: 'item.completed', item: { type: 'agent_message', text: 'x'.repeat(100_000) } })?.result).toHaveLength(32_768)
    expect(parseProviderEvent('codex', { type: 'error', message: 'x'.repeat(10_000) })?.error).toHaveLength(4096)
  })
})
