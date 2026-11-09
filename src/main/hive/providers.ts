import type { HiveCommandEvidence, HiveProvider, HiveSpawnRequest } from '../../shared/types'
import { COMMAND_LENGTH_LIMIT, resemblesCredential } from './evidence-safety'

export function buildProviderCommand(
  request: HiveSpawnRequest,
  claudeBinPath = 'claude'
): { command: string; args: string[] } {
  const provider = request.provider ?? 'claude-code'
  const permission = request.permissionMode ?? 'read-only'
  if (permission !== 'read-only' && permission !== 'workspace-write') {
    throw new Error('Unsupported agent permission mode')
  }
  // Every provider reads the objective from stdin, outside the process argument list.
  if (provider === 'claude-code') {
    if (request.model && !['opus', 'sonnet', 'haiku'].includes(request.model)) {
      throw new Error('Unsupported Claude Code model')
    }
    const tools = permission === 'read-only' ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write'
    return {
      command: claudeBinPath,
      args: [
        '--print', '--output-format', 'stream-json', '--verbose',
        '--safe-mode', '--restricted', '--no-chrome', '--disable-slash-commands',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--setting-sources', '', '--no-session-persistence',
        '--tools', tools, '--permission-mode', permission === 'read-only' ? 'plan' : 'acceptEdits',
        '--permission-prompts', 'none',
        ...(request.model ? ['--model', request.model] : [])
      ]
    }
  }
  if (provider === 'cursor') {
    return {
      command: 'cursor-agent',
      args: [
        '--print', '--output-format', 'stream-json', '--sandbox', 'enabled',
        '--workspace', request.workingDir,
        ...(permission === 'read-only' ? ['--mode', 'ask'] : [])
      ]
    }
  }
  if (provider === 'codex') {
    return {
      command: 'codex',
      args: [
        'exec', '--json', '--ephemeral', '--ignore-user-config',
        '--sandbox', permission, '--color', 'never', '--cd', request.workingDir, '-'
      ]
    }
  }
  throw new Error('Unsupported agent provider')
}

interface ProviderEvent {
  accepted?: boolean
  activity?: string
  result?: string
  error?: string
  finished?: boolean
  command?: { id: string; value: HiveCommandEvidence } | null
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown, limit = 32_768): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').slice(0, limit)
}

function isTestCommand(command: string): boolean {
  const shell = command.match(/^\/(?:usr\/)?bin\/(?:bash|zsh|sh) -lc (?:'([^']+)'|"([^"$`\\]+)")$/)
  const body = (shell ? shell[1] ?? shell[2] : command).trim()
  // Recognize only simple invocations. Shell expressions and pipelines can mask
  // a test process's exit code, even when the command text contains a test runner.
  if (!/^[\w./@+,:=-]+(?: +[\w./@+,:=-]+)*$/.test(body)) return false
  const args = body.split(/ +/)
  if (args.some((arg) => /^(?:-h|-V|--(?:help|version|collect-only|list|list-tests|dry-run|showconfig))$/.test(arg)) || /\bvitest list(?: |$)/.test(body)) return false
  return /^(?:(?:npm|pnpm|yarn|bun) (?:run )?test(?::[\w-]+)*|(?:npx |pnpm exec )?vitest(?: run)?|(?:uv run )?pytest|python(?:3(?:\.\d+)?)? (?:-B )?-m (?:unittest|pytest)|node --test|(?:cargo|go|swift|dotnet|make) test)(?: |$)/.test(body)
}

function commandEvidence(item: Record<string, unknown>): ProviderEvent['command'] {
  const { id, command, exit_code: exitCode } = item
  if (typeof id !== 'string' || !id || id.length > 100 || typeof command !== 'string' || !command.trim() ||
    command.length > COMMAND_LENGTH_LIMIT || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(command) ||
    /\bcurl\b.*\s(?:-[ubU]|--(?:user|proxy-user|oauth2-bearer|cookie)(?:\b|=))/.test(command) ||
    /--(?:api-key|token|password|secret|auth)(?:[ =]|$)/i.test(command) || resemblesCredential(command)) return null
  return {
    id,
    value: { command, exitCode: typeof exitCode === 'number' && Number.isSafeInteger(exitCode) ? exitCode : null, isTest: isTestCommand(command) }
  }
}

export function parseProviderEvent(provider: HiveProvider, value: unknown): ProviderEvent | null {
  const event = record(value)
  if (!event || typeof event.type !== 'string') return null
  if (provider === 'claude-code' || provider === 'cursor') {
    if (event.type === 'system' && event.subtype === 'init') {
      return { activity: 'Session initialized' }
    }
    if (event.type === 'user' && record(event.message)?.role === 'user') {
      return { accepted: true, activity: 'Objective received' }
    }
    if (event.type === 'assistant' && record(event.message)?.role === 'assistant') {
      return { accepted: true, activity: 'Agent responding' }
    }
    if (provider === 'cursor' && event.type === 'tool_call' &&
        (event.subtype === 'started' || event.subtype === 'completed')) {
      return { accepted: true, activity: event.subtype === 'started' ? 'Tool started' : 'Tool completed' }
    }
    if (event.type === 'result') {
      if (event.is_error === true) {
        const errors = Array.isArray(event.errors)
          ? event.errors.slice(0, 8).map((error) => text(error, 512)).filter(Boolean).join('\n')
          : undefined
        return { error: text(event.result, 4096) ?? (errors || 'Agent reported a failure'), finished: true }
      }
      const result = text(event.result)
      if (event.subtype === 'success' && event.is_error === false && result) {
        return { accepted: true, result, finished: true }
      }
    }
    return null
  }
  if (provider !== 'codex') return null
  if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
    return { activity: 'Session initialized' }
  }
  if (event.type === 'turn.started') return { accepted: true, activity: 'Objective received' }
  if (event.type === 'turn.failed') {
    return { error: text(record(event.error)?.message, 4096) ?? 'Agent turn failed', finished: true }
  }
  if (event.type === 'error') {
    return { error: text(event.message, 4096) ?? 'Agent reported an error' }
  }
  if (event.type === 'turn.completed' && record(event.usage)) return { finished: true }
  const item = record(event.item)
  if (!item || typeof item.type !== 'string') return null
  if (event.type === 'item.completed' && item.type === 'command_execution') {
    return { accepted: true, activity: 'Step completed', command: commandEvidence(item) }
  }
  if (event.type === 'item.completed' && item.type === 'agent_message') {
    const result = text(item.text)
    return result ? { accepted: true, result, activity: 'Agent responded' } : null
  }
  if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
    if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'reasoning', 'todo_list'].includes(item.type)) {
      return { accepted: true, activity: event.type === 'item.completed' ? 'Step completed' : 'Agent working' }
    }
  }
  return null
}
