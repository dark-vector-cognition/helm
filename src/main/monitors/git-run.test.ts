import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const { mockExecFile, mockExec, mockRequireGit } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockExec: vi.fn(),
  mockRequireGit: vi.fn()
}))

vi.mock('child_process', () => ({ execFile: mockExecFile, exec: mockExec }))
vi.mock('../git-binary', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../git-binary')>()),
  requireGit: mockRequireGit
}))

import { GitNotFoundError } from '../git-binary'
import { getRepoCommitHistory, runGitAction, scanForRepos } from './git'

const GIT = '/opt/tools/bin/git'

type Callback = (error: Error | null, stdout?: string, stderr?: string) => void

/** Answer find and git calls the way a real machine would for one repo at /work/app. */
function answerLikeAMachine(): void {
  mockExecFile.mockImplementation(
    (file: string, args: string[], _options: unknown, callback: Callback) => {
      if (file === 'find') return callback(null, '/work/app/.git\n', '')
      const [verb, ...rest] = args
      if (verb === 'rev-parse') return callback(null, 'main\n', '')
      if (verb === 'status' && rest.includes('--branch'))
        return callback(null, '## main...origin/main [ahead 2]\n M a.ts\n', '')
      if (verb === 'status') return callback(null, ' M a.ts\n', '')
      if (verb === 'log') return callback(null, 'abc1234567890|A|a@example.com|1700000000|msg|§§§', '')
      if (verb === 'stash' || verb === 'pull' || verb === 'push' || verb === 'fetch')
        return callback(null, 'ok\n', '')
      return callback(new Error(`unexpected call: ${file} ${args.join(' ')}`))
    }
  )
}

function gitCalls(): Array<{ file: string; args: string[]; cwd?: string }> {
  return mockExecFile.mock.calls
    .filter((call) => call[0] !== 'find' && call[0] !== 'sh' && call[0] !== 'powershell.exe')
    .map((call) => ({ file: call[0], args: call[1], cwd: call[2]?.cwd }))
}

describe('every git call uses the absolute path from the resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireGit.mockResolvedValue(GIT)
    answerLikeAMachine()
  })

  it('the repo scan runs rev-parse and both status calls by absolute path in the repo directory', async () => {
    const repos = await scanForRepos(['/work'])

    expect(repos).toHaveLength(1)
    expect(repos[0]).toMatchObject({ path: '/work/app', branch: 'main', ahead: 2, dirty: true })
    const calls = gitCalls()
    expect(calls.map((call) => call.args)).toEqual(
      expect.arrayContaining([
        ['rev-parse', '--abbrev-ref', 'HEAD'],
        ['status', '--porcelain'],
        ['status', '--branch', '--porcelain']
      ])
    )
    for (const call of calls) {
      expect(call.file).toBe(GIT)
      expect(call.cwd).toBe('/work/app')
    }
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('the commit history runs git log by absolute path', async () => {
    const commits = await getRepoCommitHistory('/work/app', 5)

    expect(commits).toHaveLength(1)
    const [call] = gitCalls()
    expect(call.file).toBe(GIT)
    expect(call.args.slice(0, 1)).toEqual(['log'])
    expect(call.args.slice(-2)).toEqual(['-n', '5'])
    expect(call.cwd).toBe('/work/app')
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('each whitelisted action runs by absolute path with separate arguments and no shell', async () => {
    const expected: Record<string, string[]> = {
      pull: ['pull'],
      push: ['push'],
      stash: ['stash'],
      'stash pop': ['stash', 'pop'],
      fetch: ['fetch']
    }

    for (const [action, args] of Object.entries(expected)) {
      mockExecFile.mockClear()
      const result = await runGitAction('/work/app', action)

      expect(result).toEqual({ success: true, output: 'ok' })
      expect(gitCalls()).toEqual([{ file: GIT, args, cwd: '/work/app' }])
    }
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('an action outside the whitelist runs nothing and never asks for git', async () => {
    for (const action of ['rm -rf /', 'pull; touch x', 'push --force', 'checkout main', '']) {
      const result = await runGitAction('/work/app', action)
      expect(result.success).toBe(false)
    }
    expect(mockExecFile).not.toHaveBeenCalled()
    expect(mockRequireGit).not.toHaveBeenCalled()
  })

  it('shows git output on success', async () => {
    mockExecFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb: Callback) =>
      cb(null, '', 'Everything up-to-date\n')
    )
    await expect(runGitAction('/work/app', 'push')).resolves.toEqual({
      success: true,
      output: 'Everything up-to-date'
    })
  })

  // Real execFile with a callback passes stdout and stderr as separate arguments. The error it
  // builds has a message and an exit code, and no stderr property.
  function realExecFileFailure(stderr: string, stdout = ''): void {
    mockExecFile.mockImplementation((file: string, args: string[], _o: unknown, cb: Callback) => {
      const error = Object.assign(new Error(`Command failed: ${file} ${args.join(' ')}\n${stderr}`), {
        code: 1
      })
      expect(error).not.toHaveProperty('stderr')
      cb(error, stdout, stderr)
    })
  }

  it('shows what git printed on stderr when an action fails', async () => {
    realExecFileFailure('No stash entries found.\n')

    await expect(runGitAction('/work/app', 'stash pop')).resolves.toEqual({
      success: false,
      output: 'No stash entries found.'
    })
  })

  it('shows the exit message when git printed nothing on stderr', async () => {
    realExecFileFailure('', 'CONFLICT (content): merge conflict in a.ts\n')

    const result = await runGitAction('/work/app', 'pull')

    expect(result.success).toBe(false)
    expect(result.output).toContain('Command failed')
    expect(result.output).toContain('pull')
  })

  it('shows the exit message when the failure is not an Error', async () => {
    mockExecFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb: Callback) =>
      cb('boom' as unknown as Error, '', '')
    )

    await expect(runGitAction('/work/app', 'fetch')).resolves.toEqual({
      success: false,
      output: 'Git action failed'
    })
  })
})

describe('git missing from PATH', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRequireGit.mockRejectedValue(new GitNotFoundError())
    answerLikeAMachine()
  })

  it('the repo scan finds no repos and starts no program named git', async () => {
    await expect(scanForRepos(['/work'])).resolves.toEqual([])
    expect(gitCalls()).toEqual([])
    expect(mockExec).not.toHaveBeenCalled()
  })

  it('the commit history is empty', async () => {
    await expect(getRepoCommitHistory('/work/app', 5)).resolves.toEqual([])
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it('an action reports that git was not found', async () => {
    await expect(runGitAction('/work/app', 'pull')).resolves.toEqual({
      success: false,
      output: 'git was not found on PATH'
    })
    expect(mockExecFile).not.toHaveBeenCalled()
  })
})

describe('no source file starts git by its bare name', () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) return sourceFiles(full)
      return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
    })
  }

  it('finds no exec, execFile, spawn or runFile call whose command starts with git', () => {
    const root = join(__dirname, '..', '..')
    const bare = /\b(?:exec|execSync|execFile|execFileSync|execAsync|execFileAsync|spawn|spawnSync|runFile)\(\s*[`'"]git\b/
    const offenders = sourceFiles(root)
      .filter((file) => bare.test(readFileSync(file, 'utf-8')))
      .map((file) => relative(root, file))

    expect(offenders).toEqual([])
  })
})
