import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, realpathSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runGitAction } from './git'

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Real runs, no mocks. A failed action must show the reason git printed, not a bare exit message.
describe.skipIf(!hasGit())('runGitAction with a real repository', () => {
  let root: string
  let repo: string
  let savedLocale: { LC_ALL?: string; LANGUAGE?: string }

  beforeEach(() => {
    // git words its messages in the user's language. The checks below read the English text.
    savedLocale = { LC_ALL: process.env.LC_ALL, LANGUAGE: process.env.LANGUAGE }
    process.env.LC_ALL = 'C'
    process.env.LANGUAGE = 'C'

    root = realpathSync(mkdtempSync(join(tmpdir(), 'helm-action-')))
    repo = join(root, 'repo')
    execFileSync('git', ['init', '-q', repo])
    execFileSync(
      'git',
      ['-c', 'user.name=Test Author', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'],
      { cwd: repo }
    )
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(savedLocale)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  })

  it('stash pop with no stash fails with the reason git gives', async () => {
    const result = await runGitAction(repo, 'stash pop')

    expect(result.success).toBe(false)
    expect(result.output).toContain('No stash entries')
    expect(result.output).not.toContain('Command failed')
  })

  it('pull with no tracking branch fails with the reason git gives', async () => {
    const result = await runGitAction(repo, 'pull')

    expect(result.success).toBe(false)
    expect(result.output).toContain('no tracking information')
    expect(result.output).not.toContain('Command failed')
  })

  it('push with no remote fails with the reason git gives', async () => {
    const result = await runGitAction(repo, 'push')

    expect(result.success).toBe(false)
    expect(result.output).toContain('No configured push destination')
    expect(result.output).not.toContain('Command failed')
  })

  it('shows git output when an action succeeds', async () => {
    await expect(runGitAction(repo, 'stash')).resolves.toEqual({
      success: true,
      output: 'No local changes to save'
    })
  })

  it('reports a directory that is not a repository with the reason git gives', async () => {
    const result = await runGitAction(root, 'fetch')

    expect(result.success).toBe(false)
    expect(result.output).toContain('not a git repository')
    expect(result.output).not.toContain('Command failed')
  })
})
