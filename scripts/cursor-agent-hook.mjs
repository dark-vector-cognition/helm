#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const events = {
  sessionStart: ['idle', 'Cursor session started'],
  beforeSubmitPrompt: ['active', 'Cursor is processing a prompt'],
  preToolUse: ['busy', 'Cursor is using a tool'],
  postToolUse: ['active', 'Cursor tool finished; turn continues'],
  sessionEnd: ['unknown', 'Cursor session ended']
}
const event = process.argv[2]
const response =
  event === 'preToolUse'
    ? { permission: 'allow' }
    : event === 'beforeSubmitPrompt'
      ? { continue: true }
      : {}
const maxInputBytes = 64 * 1024

async function readInput() {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const timeout = setTimeout(() => fail(new Error('Input timeout')), 1500)
    const fail = (error) => {
      clearTimeout(timeout)
      process.stdin.destroy()
      reject(error)
    }
    process.stdin.on('error', fail)
    process.stdin.on('data', (chunk) => {
      size += chunk.length
      if (size > maxInputBytes) return fail(new Error('Input too large'))
      chunks.push(chunk)
    })
    process.stdin.on('end', () => {
      clearTimeout(timeout)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
  })
}

try {
  const input = await readInput()
  const conversationId = input?.conversation_id
  if (
    input?.hook_event_name !== event ||
    typeof conversationId !== 'string' ||
    !conversationId.trim() ||
    conversationId.length > 1024
  )
    throw new Error('Invalid envelope')

  const stopStates = {
    completed: ['idle', 'Cursor turn completed'],
    aborted: ['idle', 'Cursor turn aborted'],
    error: ['unknown', 'Cursor turn stopped with an error']
  }
  const state =
    event === 'stop'
      ? Object.hasOwn(stopStates, input.status)
        ? stopStates[input.status]
        : null
      : Object.hasOwn(events, event)
        ? events[event]
        : null
  if (!state) throw new Error('Unsupported event')

  const agentId = `cursor-${createHash('sha256').update(conversationId).digest('hex').slice(0, 24)}`
  const directory = process.env.HELM_AGENT_FEED_DIR || join(homedir(), '.config', 'helm', 'agents')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryInfo = await lstat(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.mode & 0o077)
    throw new Error('Unsafe directory')
  const target = join(directory, `${agentId}.state.json`)
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  const lastHeartbeat = new Date().toISOString()
  try {
    await writeFile(
      temporary,
      JSON.stringify({
        agent_id: agentId,
        display_name: `Cursor session ${agentId.slice(7, 13)}`,
        last_heartbeat: lastHeartbeat,
        status: state[0],
        current_action: state[1]
      }) + '\n',
      { mode: 0o600, flag: 'wx' }
    )
    // shortcut: Cursor supplies no event sequence; simultaneous callbacks have arrival order only.
    const previousInfo = await lstat(target).catch(() => null)
    if (previousInfo && !previousInfo.isFile()) throw new Error('Unsafe state file')
    const previous = previousInfo
      ? await readFile(target, 'utf8').then(JSON.parse).catch(() => ({}))
      : {}
    if (typeof previous?.last_heartbeat === 'string' && previous.last_heartbeat > lastHeartbeat)
      await unlink(temporary)
    else await rename(temporary, target)
  } finally {
    await unlink(temporary).catch(() => {})
  }
} catch {
  // Observations must never block Cursor or expose its input in diagnostics.
}
process.stdout.write(JSON.stringify(response) + '\n')
