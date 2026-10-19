import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = join(dirname(fileURLToPath(import.meta.url)), 'cursor-agent-hook.mjs')

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'helm-cursor-hook-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return { home, directory: join(home, '.config', 'helm', 'agents') }
}

function invoke(home, event, input, directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, event], {
      env: { HOME: home, ...(directory ? { HELM_AGENT_FEED_DIR: directory } : {}) }
    })
    let stdout = ''
    let stderr = ''
    child.on('error', reject)
    child.stdout.on('data', (data) => {
      stdout += data
    })
    child.stderr.on('data', (data) => {
      stderr += data
    })
    child.stdin.on('error', () => {})
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    if (input !== undefined)
      child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input))
  })
}

function envelope(event, extra = {}) {
  return { hook_event_name: event, conversation_id: 'conversation-private-id', ...extra }
}

function assertPassThrough(result, event) {
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  assert.deepEqual(
    JSON.parse(result.stdout),
    event === 'preToolUse'
      ? { permission: 'allow' }
      : event === 'beforeSubmitPrompt'
        ? { continue: true }
        : {}
  )
}

test('CLI records actual event lifecycle without storing private hook inputs', async (t) => {
  const { home, directory } = await fixture(t)
  const lifecycle = [
    ['sessionStart', {}, 'idle', 'Cursor session started'],
    ['beforeSubmitPrompt', {}, 'active', 'Cursor is processing a prompt'],
    ['preToolUse', {}, 'busy', 'Cursor is using a tool'],
    ['postToolUse', {}, 'active', 'Cursor tool finished; turn continues'],
    ['stop', { status: 'completed' }, 'idle', 'Cursor turn completed'],
    ['stop', { status: 'aborted' }, 'idle', 'Cursor turn aborted'],
    ['stop', { status: 'error' }, 'unknown', 'Cursor turn stopped with an error'],
    ['sessionEnd', {}, 'unknown', 'Cursor session ended']
  ]
  let previousHeartbeat = 0
  for (const [event, extra, status, action] of lifecycle) {
    const result = await invoke(
      home,
      event,
      envelope(event, {
        generation_id: 'private-generation',
        prompt: 'private-prompt',
        attachments: [{ file: '/private/attachment' }],
        tool_name: 'private-mcp-service',
        tool_input: { command: 'private-command' },
        tool_output: 'private-output',
        user_email: 'private@example.test',
        transcript_path: '/private/transcript',
        workspace_roots: ['/private/workspace'],
        ...extra
      })
    )
    assertPassThrough(result, event)
    const names = await readdir(directory)
    assert.equal(names.length, 1)
    assert.match(names[0], /^cursor-[a-f0-9]{24}\.state\.json$/)
    const raw = await readFile(join(directory, names[0]), 'utf8')
    const state = JSON.parse(raw)
    assert.deepEqual(Object.keys(state).sort(), [
      'agent_id',
      'current_action',
      'display_name',
      'last_heartbeat',
      'status'
    ])
    assert.match(state.display_name, /^Cursor session [a-f0-9]{6}$/)
    assert.equal(state.status, status)
    assert.equal(state.current_action, action)
    assert.equal(`${state.agent_id}.state.json`, names[0])
    assert.ok(Date.parse(state.last_heartbeat) >= previousHeartbeat)
    assert.ok(Date.now() - Date.parse(state.last_heartbeat) < 5000)
    previousHeartbeat = Date.parse(state.last_heartbeat)
    assert.doesNotMatch(
      raw,
      /private|conversation-private-id|generation|workspace|transcript|email|"prompt":/
    )
    assert.equal((await stat(join(directory, names[0]))).mode & 0o777, 0o600)
  }
  assert.equal((await stat(directory)).mode & 0o777, 0o700)
  const [name] = await readdir(directory)
  await writeFile(join(directory, name), '{')
  assertPassThrough(await invoke(home, 'preToolUse', envelope('preToolUse')), 'preToolUse')
  assert.equal(JSON.parse(await readFile(join(directory, name), 'utf8')).status, 'busy')
})

test('malformed, oversized and invalid events cannot block permission hooks or emit diagnostics', async (t) => {
  const { home, directory } = await fixture(t)
  for (const event of ['preToolUse', 'beforeSubmitPrompt']) {
    for (const input of [
      '{',
      'x'.repeat(65537),
      null,
      [],
      envelope(event, { conversation_id: '' }),
      envelope(event, { conversation_id: 'x'.repeat(1025) }),
      envelope('sessionEnd')
    ]) {
      assertPassThrough(await invoke(home, event, input), event)
    }
  }
  assertPassThrough(await invoke(home, 'stop', envelope('stop', { status: '__proto__' })), 'stop')
  assertPassThrough(
    await invoke(home, 'stop', envelope('stop', { status: 'unrecognized' })),
    'stop'
  )
  assertPassThrough(
    await invoke(home, 'afterAgentResponse', envelope('afterAgentResponse')),
    'afterAgentResponse'
  )
  await assert.rejects(readdir(directory), { code: 'ENOENT' })
})

test('feed failures remain fail-open and do not replace unsafe existing directories', async (t) => {
  const { home } = await fixture(t)
  const blocked = join(home, 'not-a-directory')
  await writeFile(blocked, 'unchanged')
  assertPassThrough(await invoke(home, 'preToolUse', envelope('preToolUse'), blocked), 'preToolUse')
  assert.equal(await readFile(blocked, 'utf8'), 'unchanged')
  const openDirectory = join(home, 'public-feed')
  await mkdir(openDirectory, { mode: 0o755 })
  assertPassThrough(
    await invoke(home, 'beforeSubmitPrompt', envelope('beforeSubmitPrompt'), openDirectory),
    'beforeSubmitPrompt'
  )
  assert.deepEqual(await readdir(openDirectory), [])
})

test('a stalled stdin producer times out and still permits the tool', async (t) => {
  const { home, directory } = await fixture(t)
  const start = Date.now()
  assertPassThrough(await invoke(home, 'preToolUse', undefined), 'preToolUse')
  assert.ok(Date.now() - start < 5000)
  await assert.rejects(readdir(directory), { code: 'ENOENT' })
})

test('parallel conversations use separate hashed filenames and atomic complete JSON', async (t) => {
  const { home } = await fixture(t)
  const directory = join(home, 'isolated-feed')
  const identities = [
    '../../escape',
    '/absolute/session',
    ...Array.from({ length: 12 }, (_, i) => `conversation-${i}`)
  ]
  const results = await Promise.all(
    identities.map((conversation_id) =>
      invoke(home, 'preToolUse', envelope('preToolUse', { conversation_id }), directory)
    )
  )
  results.forEach((result) => assertPassThrough(result, 'preToolUse'))
  const names = await readdir(directory)
  assert.equal(names.length, identities.length)
  for (const name of names) {
    assert.match(name, /^cursor-[a-f0-9]{24}\.state\.json$/)
    assert.equal(JSON.parse(await readFile(join(directory, name), 'utf8')).status, 'busy')
  }
  assert.deepEqual((await readdir(home)).sort(), ['isolated-feed'])
})

test('overlapping callbacks for one conversation leave one complete file and no temporary files', async (t) => {
  const { home, directory } = await fixture(t)
  const results = await Promise.all(
    Array.from({ length: 12 }, () => invoke(home, 'preToolUse', envelope('preToolUse')))
  )
  results.forEach((result) => assertPassThrough(result, 'preToolUse'))
  const [name, ...others] = await readdir(directory)
  assert.deepEqual(others, [])
  assert.equal(JSON.parse(await readFile(join(directory, name), 'utf8')).status, 'busy')
  assertPassThrough(await invoke(home, 'stop', envelope('stop', { status: 'completed' })), 'stop')
  assert.equal(JSON.parse(await readFile(join(directory, name), 'utf8')).status, 'idle')
})

test('example hook commands execute with quoted paths and the correct event response', async (t) => {
  const { home, directory } = await fixture(t)
  const spacedScript = join(home, 'hook with spaces.mjs')
  await copyFile(script, spacedScript)
  const example = JSON.parse(
    await readFile(new URL('../docs/examples/cursor-hooks.json', import.meta.url), 'utf8')
  )
  assert.equal(example.version, 1)
  assert.deepEqual(Object.keys(example.hooks), [
    'sessionStart',
    'beforeSubmitPrompt',
    'preToolUse',
    'postToolUse',
    'stop',
    'sessionEnd'
  ])
  for (const [event, hooks] of Object.entries(example.hooks)) {
    assert.equal(hooks.length, 1)
    const command = hooks[0].command
      .replace('/absolute/path/to/node', process.execPath)
      .replace('/absolute/path/to/helm/scripts/cursor-agent-hook.mjs', spacedScript)
    const result = await new Promise((resolve, reject) => {
      const child = spawn(command, { shell: true, env: { HOME: home, HELM_AGENT_FEED_DIR: directory } })
      let stdout = ''; let stderr = ''
      child.on('error', reject)
      child.stdout.on('data', (data) => { stdout += data })
      child.stderr.on('data', (data) => { stderr += data })
      child.on('close', (code) => resolve({ code, stdout, stderr }))
      child.stdin.end(JSON.stringify(envelope(event, { status: 'completed' })))
    })
    assertPassThrough(result, event)
  }
})
