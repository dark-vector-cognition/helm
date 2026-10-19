import { fork, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

let root: string
let workerPath: string
const workers: ChildProcess[] = []
const providerGroups = new Set<number>()

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'helm-worker-test-'))
  workerPath = join(root, 'worker.cjs')
  const source = readFileSync(new URL('./worker.ts', import.meta.url), 'utf8')
  writeFileSync(workerPath, ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText)
})

afterEach(() => {
  for (const pid of providerGroups) {
    try { process.kill(-pid, 'SIGKILL') } catch { /* Already gone. */ }
  }
  providerGroups.clear()
  for (const worker of workers.splice(0)) {
    if (worker.exitCode === null) worker.kill('SIGKILL')
  }
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

function launch(command: string, args: string[], timeoutSeconds = 10) {
  const child = fork(workerPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  workers.push(child)
  const messages: Record<string, unknown>[] = []
  child.on('message', (message) => {
    const record = message as Record<string, unknown>
    messages.push(record)
    if (record.type === 'spawn') providerGroups.add(record.pid as number)
  })
  child.send({ type: 'start', command, args, cwd: root, input: 'clean fixture objective', timeoutSeconds })
  return { child, messages }
}

async function waitFor<T>(get: () => T | undefined, milliseconds = 5000): Promise<T> {
  const expires = Date.now() + milliseconds
  while (Date.now() < expires) {
    const result = get()
    if (result !== undefined) return result
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Timed out waiting for worker fixture')
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

describe('supervisor worker with local processes', () => {
  it('streams valid JSON only, sends stdin, and flushes a final line without a newline', async () => {
    const fixture = `let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{console.error('private diagnostic');console.log('not JSON');console.log(JSON.stringify({type:'fixture',received:input}));process.stdout.write(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'fixture result'}))})`
    const { messages } = launch(process.execPath, ['-e', fixture])
    await waitFor(() => messages.find((message) => message.type === 'exit'))
    expect(messages.filter((message) => message.type === 'event').map((message) => message.event)).toEqual([
      { type: 'fixture', received: 'clean fixture objective' },
      { type: 'result', subtype: 'success', is_error: false, result: 'fixture result' }
    ])
    expect(messages.at(-1)).toMatchObject({ type: 'exit', code: 0, stopped: false })
    expect(JSON.stringify(messages)).not.toContain('private diagnostic')
  })

  it('reports a missing executable without provider diagnostics', async () => {
    const { messages } = launch(join(root, 'missing-agent'), [])
    await waitFor(() => messages.find((message) => message.type === 'exit'))
    expect(messages).toContainEqual({ type: 'error', error: 'Provider could not start. Check its executable and sign-in.' })
    expect(messages.at(-1)).toMatchObject({ type: 'exit', stopped: false })
    expect(messages.at(-1)?.code).not.toBe(0)
  })

  it('confirms operator stop only after the provider exits, including forced termination', async () => {
    const fixture = `process.on('SIGTERM',()=>{});console.log(JSON.stringify({type:'ready'}));setInterval(()=>{},1000)`
    const { child, messages } = launch(process.execPath, ['-e', fixture])
    await waitFor(() => messages.find((message) => (message.event as { type?: string })?.type === 'ready'))
    const pid = messages.find((message) => message.type === 'spawn')!.pid as number
    child.send({ type: 'stop' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(alive(pid)).toBe(true)
    expect(messages.some((message) => message.type === 'exit')).toBe(false)
    await waitFor(() => messages.find((message) => message.type === 'exit'))
    expect(messages.at(-1)).toMatchObject({ stopped: true, error: 'Stopped by operator' })
    expect(alive(pid)).toBe(false)
  })

  it('kills the provider process group when Helm disconnects, including descendants', async () => {
    const fixture = `const {spawn}=require('node:child_process');const sub=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(JSON.stringify({type:'ready',descendant:sub.pid}));setInterval(()=>{},1000)`
    const { child, messages } = launch(process.execPath, ['-e', fixture])
    const ready = await waitFor(() => messages.find((message) => (message.event as { type?: string })?.type === 'ready'))
    const descendant = (ready.event as { descendant: number }).descendant
    const pid = messages.find((message) => message.type === 'spawn')!.pid as number
    expect(alive(descendant)).toBe(true)
    child.disconnect()
    await waitFor(() => !alive(pid) && !alive(descendant) ? true : undefined)
    expect(alive(pid)).toBe(false)
    expect(alive(descendant)).toBe(false)
  })

  it('stops a process that exceeds its execution time limit', async () => {
    const { messages } = launch(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 0.1)
    await waitFor(() => messages.find((message) => message.type === 'exit'))
    expect(messages.at(-1)).toMatchObject({ stopped: true, error: 'Run time limit reached' })
  })

  it('stops excessive output instead of retaining unbounded text', async () => {
    const { messages } = launch(process.execPath, ['-e', "process.stdout.write('x'.repeat(600000));setInterval(()=>{},1000)"])
    await waitFor(() => messages.find((message) => message.type === 'exit'))
    expect(messages.at(-1)).toMatchObject({ stopped: true, error: 'Provider output exceeded the limit' })
    expect(messages.some((message) => message.type === 'event')).toBe(false)
  })
})
