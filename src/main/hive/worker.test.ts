import { execFileSync, fork, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import ts from 'typescript'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

let root: string
let workerPath: string
const workers: ChildProcess[] = []
const providerGroups = new Set<number>()

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'helm-worker-test-')))
  mkdirSync(join(root, 'hive'))
  workerPath = join(root, 'hive', 'worker.js')
  for (const [source, target] of [
    ['./worker.ts', 'hive/worker.js'], ['./git-evidence.ts', 'hive/git-evidence.js'],
    ['./evidence-safety.ts', 'hive/evidence-safety.js'], ['../git-binary.ts', 'git-binary.js']
  ]) {
    writeFileSync(join(root, target), ts.transpileModule(readFileSync(new URL(source, import.meta.url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
    }).outputText)
  }
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

function launch(command: string, args: string[], timeoutSeconds = 10, cwd = root, env = process.env) {
  const child = fork(workerPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env })
  workers.push(child)
  const messages: Record<string, unknown>[] = []
  child.on('message', (message) => {
    const record = message as Record<string, unknown>
    messages.push(record)
    if (record.type === 'spawn') providerGroups.add(record.pid as number)
  })
  child.send({ type: 'start', command, args, cwd, input: 'clean fixture objective', timeoutSeconds })
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

function fixtureRepo(): { cwd: string; git: (...args: string[]) => string } {
  const cwd = mkdtempSync(join(root, 'git-'))
  const git = (...args: string[]): string => execFileSync('git', [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args
  ], { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
  git('init', '-q', '--template=')
  writeFileSync(join(cwd, 'tracked.txt'), 'before\n')
  git('add', 'tracked.txt')
  git('commit', '-qm', 'Fixture base')
  return { cwd, git }
}

function slowGitEnv(): NodeJS.ProcessEnv {
  const binaries = mkdtempSync(join(root, 'slow-git-'))
  writeFileSync(join(binaries, 'git'), '#!/bin/sh\nexec /bin/sleep 5\n', { mode: 0o700 })
  return { ...process.env, PATH: [binaries, process.env.PATH].filter(Boolean).join(delimiter) }
}

describe('supervisor worker with local processes', () => {
  it('captures the exact tracked patch and untracked names across the provider lifetime', async () => {
    const { cwd, git } = fixtureRepo()
    const baseCommit = git('rev-parse', 'HEAD').trim()
    git('config', 'diff.external', '/does-not-exist-fixture-external-diff')
    git('config', 'filter.unused.clean', '/does-not-exist-fixture-clean-filter')
    const fixture = `const fs = require('node:fs'); fs.writeFileSync('tracked.txt', 'after\\n'); fs.writeFileSync('untracked.txt', 'untracked private contents\\n');`
    const { messages } = launch(process.execPath, ['-e', fixture], 10, cwd)
    const exit = await waitFor(() => messages.find((message) => message.type === 'exit'))
    expect(exit.git).toEqual({ status: 'captured', baseCommit,
      patch: git('diff', '--no-ext-diff', '--no-textconv', '--full-index', 'HEAD', '--'), untracked: ['untracked.txt'] })
    expect(JSON.stringify(exit)).not.toContain('untracked private contents')
  })

  it('withholds evidence without executing a clean filter activated on a tracked path during the run', async () => {
    const { cwd, git } = fixtureRepo()
    writeFileSync(join(cwd, '.gitattributes'), '# no active filters\n')
    git('add', '.gitattributes')
    git('commit', '-qm', 'Track attributes')
    writeFileSync(join(cwd, '.git', 'filter-helper'), 'printf ran > .git/filter-ran\ncat\n')
    git('config', 'filter.fixture.clean', '/bin/sh .git/filter-helper')
    const fixture = `const fs = require('node:fs'); fs.writeFileSync('.gitattributes', 'tracked.txt filter=fixture\\n'); fs.writeFileSync('tracked.txt', 'after\\n');`
    const { messages } = launch(process.execPath, ['-e', fixture], 10, cwd)
    const exit = await waitFor(() => messages.find((message) => message.type === 'exit'))
    expect(exit.git).toEqual({ status: 'unavailable', reason: 'A tracked path uses a configured Git clean or process filter.' })
    expect(existsSync(join(cwd, '.git', 'filter-ran'))).toBe(false)
  })

  it('withholds evidence for a dirty base and still runs the provider', async () => {
    const { cwd } = fixtureRepo()
    writeFileSync(join(cwd, 'tracked.txt'), 'already dirty\n')
    const fixture = `console.log(JSON.stringify({type:'fixture-ran'}))`
    const { messages } = launch(process.execPath, ['-e', fixture], 10, cwd)
    const exit = await waitFor(() => messages.find((message) => message.type === 'exit'))
    expect(exit).toMatchObject({ code: 0, git: { status: 'unavailable', reason: expect.stringContaining('before launch') } })
    expect(messages).toContainEqual({ type: 'event', event: { type: 'fixture-ran' } })
  })

  it('withholds potentially sensitive evidence instead of substituting a redacted patch', async () => {
    const { cwd } = fixtureRepo()
    const fixture = `require('node:fs').writeFileSync('tracked.txt', 'password=local-fixture-value\\n')`
    const { messages } = launch(process.execPath, ['-e', fixture], 10, cwd)
    const exit = await waitFor(() => messages.find((message) => message.type === 'exit'))
    expect(exit.git).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('credential') })
    expect(JSON.stringify(exit)).not.toContain('local-fixture-value')
  })

  it('withholds an oversized patch instead of presenting truncated evidence', async () => {
    const { cwd } = fixtureRepo()
    const fixture = `require('node:fs').writeFileSync('tracked.txt', 'a'.repeat(40_000))`
    const { messages } = launch(process.execPath, ['-e', fixture], 10, cwd)
    const exit = await waitFor(() => messages.find((message) => message.type === 'exit'))
    expect(exit.git).toEqual({ status: 'unavailable', reason: 'Git evidence exceeded the capture limit.' })
  })

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

  it('launches without Git evidence when the optional baseline reaches its short deadline', async () => {
    const fixture = `console.log(JSON.stringify({type:'fixture-ran'}))`
    const { messages } = launch(process.execPath, ['-e', fixture], 10, root, slowGitEnv())
    const exit = await waitFor(() => messages.find((message) => message.type === 'exit'))
    expect(exit).toMatchObject({ code: 0, git: { status: 'unavailable', reason: expect.stringContaining('launch deadline') } })
    expect(messages).toContainEqual({ type: 'event', event: { type: 'fixture-ran' } })
  })

  it('starts the run timeout before Git sampling and does not launch a provider after it expires', async () => {
    const fixture = `console.log(JSON.stringify({type:'fixture-ran'}))`
    const { messages } = launch(process.execPath, ['-e', fixture], 0.1, root, slowGitEnv())
    const exit = await waitFor(() => messages.find((message) => message.type === 'exit'))
    expect(exit).toMatchObject({ stopped: true, error: 'Run time limit reached' })
    expect(messages.some((message) => message.type === 'spawn' || message.type === 'event')).toBe(false)
  })

  it('stops excessive output instead of retaining unbounded text', async () => {
    const { messages } = launch(process.execPath, ['-e', "process.stdout.write('x'.repeat(600000));setInterval(()=>{},1000)"])
    await waitFor(() => messages.find((message) => message.type === 'exit'))
    expect(messages.at(-1)).toMatchObject({ stopped: true, error: 'Provider output exceeded the limit' })
    expect(messages.some((message) => message.type === 'event')).toBe(false)
  })
})
