import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// A real run of the attack the resolver prevents. A scanned repo holds an executable named git at
// its top. PATH has "." and an empty entry, which mean the working directory, so a program started
// by the bare name git would run the planted file. Windows does this even without those entries; a
// POSIX machine needs them, so this test sets them. HELM must run the real git and never the planted one.
const describePosix = process.platform === 'win32' || !hasGit() ? describe.skip : describe

describePosix('a git planted in a scanned repo', () => {
  let root: string
  let repo: string
  let marker: string
  let savedPath: string | undefined

  function commit(message: string): void {
    execFileSync(
      'git',
      ['-c', 'user.name=Test Author', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', message],
      { cwd: repo }
    )
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'helm-planted-')))
    repo = join(root, 'repo')
    marker = join(root, 'planted-git-ran')
    execFileSync('git', ['init', '-q', repo])
    commit('first')
    commit('second')

    writeFileSync(join(repo, 'git'), `#!/bin/sh\ntouch '${marker}'\necho planted\n`)
    chmodSync(join(repo, 'git'), 0o755)

    savedPath = process.env.PATH
    process.env.PATH = `.:${savedPath}:`
    vi.resetModules()
  })

  afterEach(() => {
    process.env.PATH = savedPath
    vi.resetModules()
    rmSync(root, { recursive: true, force: true })
  })

  it('does not run when HELM reads the commit history, and the real git answers', async () => {
    const { getRepoCommitHistory } = await import('./git')

    const commits = await getRepoCommitHistory(repo, 5)

    expect(existsSync(marker)).toBe(false)
    expect(commits.map((c) => c.message)).toEqual(['second', 'first'])
  })

  it('does not run when HELM scans repos and reads their status', async () => {
    const { scanForRepos } = await import('./git')

    const repos = await scanForRepos([root])

    expect(existsSync(marker)).toBe(false)
    expect(repos.map((r) => r.path)).toEqual([repo])
    expect(repos[0].branch).toBeTruthy()
  })

  it('does not run when HELM runs a git action', async () => {
    const { runGitAction } = await import('./git')

    await runGitAction(repo, 'fetch')

    expect(existsSync(marker)).toBe(false)
  })

  it('the planted file would run if git were started by its bare name from this directory', () => {
    // Proves the setup is a real attack: without the resolver, the planted file runs.
    execFileSync('git', ['--version'], { cwd: repo })
    expect(existsSync(marker)).toBe(true)
  })
})
