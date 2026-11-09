import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { resolveGit, withSafeGitOptions } from '../git-binary'
import type { HiveReviewEvidence } from '../../shared/types'
import { resemblesCredential } from './evidence-safety'

type GitEvidence = HiveReviewEvidence['git']
type GitUnavailable = Extract<GitEvidence, { status: 'unavailable' }>
type GitReader = (args: string[], limit?: number, allowNoMatch?: boolean) => Promise<string>
type GitBase = { status: 'clean'; commit: string; gitDir: string; executable: string }

const SAMPLE_MS = 4_000
const INDEX_LIMIT = 512 * 1024
const PATCH_LIMIT = 24 * 1024
const STATUS_LIMIT = 8 * 1024
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const CONTROL = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/
const SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\.[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|p12|pfx|key))$/i

class EvidenceUnavailable extends Error {}

function unavailable(reason: string): GitUnavailable {
  return { status: 'unavailable', reason }
}

function failure(error: unknown): GitUnavailable {
  return unavailable(error instanceof EvidenceUnavailable ? error.message : 'Git evidence could not be read safely.')
}

function reader(executable: string, cwd: string): GitReader {
  const deadline = Date.now() + SAMPLE_MS
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
  Object.assign(env, {
    GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: '',
    GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C'
  })
  return (args, limit = STATUS_LIMIT, allowNoMatch = false) => new Promise((resolve, reject) => {
    const timeout = deadline - Date.now()
    if (timeout <= 0) {
      reject(new EvidenceUnavailable('Git evidence collection reached its time limit.'))
      return
    }
    execFile(executable, withSafeGitOptions([
      '--no-pager', '-c', 'core.untrackedCache=false', ...args
    ]), { cwd, env, timeout, maxBuffer: limit, encoding: 'buffer' }, (error, stdout) => {
      if (error && !(allowNoMatch && error.code === 1 && stdout.length === 0)) {
        reject(new EvidenceUnavailable(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ? 'Git evidence exceeded the capture limit.'
          : error.killed ? 'Git evidence collection reached its time limit.' : 'Git evidence could not be read safely.'))
        return
      }
      try { resolve(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stdout)) }
      catch { reject(new EvidenceUnavailable('Git evidence contains non-UTF-8 data.')) }
    })
  })
}

function gitLine(value: string): string {
  const line = value.slice(0, -1)
  if (!value.endsWith('\n') || !line || CONTROL.test(line)) throw new EvidenceUnavailable('Git returned an ambiguous repository location or revision.')
  return line
}

async function identity(git: GitReader, cwd: string): Promise<{ gitDir: string; commit: string }> {
  const root = gitLine(await git(['rev-parse', '--show-toplevel']).catch(() => {
    throw new EvidenceUnavailable('The selected directory is not an accessible Git worktree.')
  }))
  if (await realpath(root) !== cwd) throw new EvidenceUnavailable('Select the Git worktree root to capture its changes.')
  const gitDir = await realpath(gitLine(await git(['rev-parse', '--absolute-git-dir'])))
  const commit = gitLine(await git(['rev-parse', '--verify', 'HEAD^{commit}']))
  if (!COMMIT.test(commit)) throw new EvidenceUnavailable('Git returned an ambiguous base commit.')
  return { gitDir, commit }
}

async function checkIndex(git: GitReader): Promise<string> {
  const filters = await git(['config', '--includes', '--null', '--name-only', '--get-regexp', '^filter\..*\.(clean|process)$'], STATUS_LIMIT, true)
  if (filters) throw new EvidenceUnavailable('Git clean or process filters are configured for this worktree.')
  const index = await git(['ls-files', '-v', '--stage', '-z'], INDEX_LIMIT)
  for (const entry of index.split('\0').filter(Boolean)) {
    if (!/^H (?:100[67][0-7]{2}|120000) [a-f0-9]{40,64} 0\t/.test(entry)) {
      throw new EvidenceUnavailable('The Git index contains hidden, conflicted, or unsupported entries.')
    }
  }
  return index
}

function status(git: GitReader): Promise<string> {
  return git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=none'])
}

export async function sampleGitBase(cwd: string): Promise<GitBase | GitUnavailable> {
  try {
    const executable = await resolveGit()
    if (!executable) return unavailable('Git is unavailable in HELM’s launch environment.')
    const git = reader(executable, cwd)
    const before = await identity(git, cwd)
    await checkIndex(git)
    if (await status(git)) return unavailable('The Git worktree already had changes before launch.')
    const after = await identity(git, cwd)
    if (before.commit !== after.commit || before.gitDir !== after.gitDir) {
      return unavailable('The Git worktree changed while HELM sampled its base.')
    }
    return { status: 'clean', executable, ...before }
  } catch (error) { return failure(error) }
}

export async function captureGitChanges(cwd: string, base: GitBase | GitUnavailable): Promise<GitEvidence> {
  if (base.status === 'unavailable') return base
  try {
    const git = reader(base.executable, cwd)
    const sameBase = async () => {
      const current = await identity(git, cwd)
      if (current.commit !== base.commit || current.gitDir !== base.gitDir) {
        throw new EvidenceUnavailable('The Git worktree or HEAD changed during the run.')
      }
    }
    await sameBase()
    const index = await checkIndex(git)
    const changes = await status(git)
    const diff = () => git([
      'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--no-relative',
      '--ignore-submodules=none', '--full-index', '--src-prefix=a/', '--dst-prefix=b/', base.commit, '--'
    ], PATCH_LIMIT)
    const patch = await diff()
    const untracked: string[] = []
    let tracked = false
    for (const entry of changes.split('\0').filter(Boolean)) {
      const path = entry.slice(3)
      if (!/^(?:\?\?|[ MADT]{2}) /.test(entry) || !path || CONTROL.test(path)) {
        return unavailable('Git reported ambiguous change metadata.')
      }
      if (SENSITIVE_PATH.test(path) || resemblesCredential(path)) return unavailable('Git evidence may contain a credential.')
      if (entry.startsWith('?? ')) untracked.push(path)
      else {
        if (entry[0] !== ' ' && entry[1] !== ' ') return unavailable('A tracked file has both staged and unstaged changes.')
        tracked = true
      }
    }
    if (tracked !== Boolean(patch)) return unavailable('Git reported tracked changes that do not match one exact patch.')
    if (/^Binary files .+ differ$/m.test(patch)) return unavailable('Git changes contain binary data that cannot be shown as a text patch.')
    if (CONTROL.test(patch.replace(/[\n\r\t]/g, ''))) return unavailable('Git evidence contains unsafe display characters.')
    if (resemblesCredential(patch)) return unavailable('Git evidence may contain a credential.')
    if (index !== await checkIndex(git) || changes !== await status(git) || patch !== await diff()) {
      return unavailable('The Git worktree changed while HELM captured its evidence.')
    }
    await sameBase()
    return { status: 'captured', baseCommit: base.commit, patch, untracked }
  } catch (error) { return failure(error) }
}
