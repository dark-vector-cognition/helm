import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getRepoCommitHistory, runGitAction, scanForRepos } from './git'
import { VaultClient } from '../vault-client'

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Real runs, no mocks. A repository's own .git/config can set core.fsmonitor to a program, and git
// runs that program during status, fetch, stash and other commands that refresh the index. A repo
// copied from someone else carries that config along. HELM must scan, read and act on such a repo
// without ever running the program.
const describePosix = process.platform === 'win32' || !hasGit() ? describe.skip : describe

describePosix('a core.fsmonitor program in a repository config', () => {
  let root: string
  let repo: string
  let marker: string

  function git(args: string[], cwd = repo): string {
    return execFileSync(
      'git',
      ['-c', 'user.name=Test Author', '-c', 'user.email=test@example.com', ...args],
      { cwd, encoding: 'utf-8' }
    )
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'helm-fsmonitor-')))
    repo = join(root, 'repo')
    marker = join(root, 'fsmonitor-ran')
    execFileSync('git', ['init', '-q', repo])
    writeFileSync(join(repo, 'a.txt'), 'one\n')
    git(['add', 'a.txt'])
    git(['commit', '-q', '-m', 'first'])
    git(['commit', '-q', '--allow-empty', '-m', 'second'])

    // Plant the program last, so the setup above does not trigger it. It only records that it ran.
    const hook = join(root, 'hook.sh')
    writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`)
    chmodSync(hook, 0o755)
    git(['config', 'core.fsmonitor', hook])

    // Give status something to report.
    writeFileSync(join(repo, 'a.txt'), 'changed\n')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    rmSync(root, { recursive: true, force: true })
  })

  it('runs when git is started without HELM, which makes the checks below meaningful', () => {
    git(['status', '--porcelain'])

    expect(existsSync(marker)).toBe(true)
  })

  it('never runs during the repo scan, and the scan still reads the repo', async () => {
    const repos = await scanForRepos([root])

    expect(existsSync(marker)).toBe(false)
    expect(repos).toHaveLength(1)
    expect(repos[0].path).toBe(repo)
    expect(repos[0].dirty).toBe(true)
    expect(repos[0].modified).toBe(1)
  })

  it('never runs during the commit history call, and the call still reads the repo', async () => {
    const commits = await getRepoCommitHistory(repo, 5)

    expect(existsSync(marker)).toBe(false)
    expect(commits.map((commit) => commit.message)).toEqual(['second', 'first'])
  })

  it('never runs during a git action, and the action still works', async () => {
    const fetched = await runGitAction(repo, 'fetch')
    expect(fetched.success).toBe(true)

    const stashed = await runGitAction(repo, 'stash')
    expect(stashed.success).toBe(true)
    expect(stashed.output).toContain('Saved working directory')

    const popped = await runGitAction(repo, 'stash pop')
    expect(popped.success).toBe(true)

    expect(existsSync(marker)).toBe(false)
  })

  it('never runs when the vault client commits a note to such a repo', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => 'offline' }))
    mkdirSync(join(repo, 'Inbox'), { recursive: true })
    execFileSync('git', ['config', 'user.name', 'Test Author'], { cwd: repo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
    const client = new VaultClient({
      vaultRagEndpoint: 'http://127.0.0.1:8742',
      vaultPath: repo,
      vaultRagLocation: 'local',
      vaultRagRemoteHost: 'unused'
    })

    const saved = await client.pushNote('Planted', 'Body')

    expect(saved.success).toBe(true)
    expect(existsSync(marker)).toBe(false)
    // The commit happened, so the git calls ran and did their job.
    expect(execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: repo, encoding: 'utf-8' }).trim()).toBe(
      'HELM: add Planted'
    )
  })
})
