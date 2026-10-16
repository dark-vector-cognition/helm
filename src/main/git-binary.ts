import { constants } from 'fs'
import { access, stat } from 'fs/promises'
import path from 'path'

/**
 * Find git as an absolute path, so HELM never runs a program that a scanned repository planted.
 *
 * Why: the Fleet page runs git with a repo as its working directory. On Windows, starting a
 * program by bare name, through execFile or through the shell, looks in that working directory
 * before PATH, so a git.exe at the top of a repo would run instead of the real git. An absolute
 * path has no search at all.
 *
 * The search reads PATH entries only:
 * - It never looks in the working directory.
 * - It skips every PATH entry that is not a full path (an empty entry, ".", "bin", and on Windows
 *   "\bin" or "C:bin"), because those resolve against the working directory.
 * - On Windows it tries the extensions from PATHEXT in order. execFile cannot start a script
 *   without a shell, so only .exe and .com count. With no usable PATHEXT it tries .com then .exe.
 */

/** What the search needs from the machine. Tests replace it. */
export interface PathLookup {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  /** True when the full path names a regular file that can be run. */
  isExecutableFile: (fullPath: string) => Promise<boolean>
}

const RUNNABLE_WINDOWS_EXTENSIONS = ['.com', '.exe']

function readEnv(
  env: Record<string, string | undefined>,
  name: string,
  platform: NodeJS.Platform
): string | undefined {
  if (platform !== 'win32') return env[name]
  // Windows variable names are not case sensitive, and a copied environment loses that.
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase())
  return key === undefined ? undefined : env[key]
}

function isFullPath(entry: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(entry)
  return entry.startsWith('/')
}

function windowsExtensions(pathExt: string | undefined): string[] {
  const listed = (pathExt || '')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => RUNNABLE_WINDOWS_EXTENSIONS.includes(ext))
  const unique = [...new Set(listed)]
  return unique.length > 0 ? unique : RUNNABLE_WINDOWS_EXTENSIONS
}

/** The absolute path of `name` found on PATH, or null. Reads PATH only, never the working directory. */
export async function findOnPath(name: string, lookup: PathLookup): Promise<string | null> {
  if (!name || /[\\/]/.test(name)) return null

  const { platform, env } = lookup
  const pathValue = readEnv(env, 'PATH', platform)
  if (!pathValue) return null

  const joinPath = platform === 'win32' ? path.win32.join : path.posix.join
  const delimiter = platform === 'win32' ? ';' : ':'
  const fileNames =
    platform === 'win32'
      ? windowsExtensions(readEnv(env, 'PATHEXT', platform)).map((ext) => `${name}${ext}`)
      : [name]

  for (const rawEntry of pathValue.split(delimiter)) {
    let entry = rawEntry.trim()
    if (platform === 'win32' && entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"')) {
      entry = entry.slice(1, -1).trim()
    }
    if (!isFullPath(entry, platform)) continue

    for (const fileName of fileNames) {
      const candidate = joinPath(entry, fileName)
      if (await lookup.isExecutableFile(candidate)) return candidate
    }
  }

  return null
}

async function isExecutableFileOnDisk(fullPath: string): Promise<boolean> {
  try {
    if (!(await stat(fullPath)).isFile()) return false
    if (process.platform !== 'win32') await access(fullPath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function defaultLookup(): PathLookup {
  return {
    platform: process.platform,
    env: process.env,
    isExecutableFile: isExecutableFileOnDisk
  }
}

/**
 * A resolver that finds git once and remembers the answer. A miss is not remembered, so installing
 * git while HELM runs works on the next call. Calls made while a search runs share that search.
 */
export function createGitResolver(
  getLookup: () => PathLookup = defaultLookup
): () => Promise<string | null> {
  let cached: Promise<string | null> | null = null

  return () => {
    if (cached) return cached
    const search = findOnPath('git', getLookup()).catch(() => null)
    cached = search
    void search.then((found) => {
      if (found === null && cached === search) cached = null
    })
    return search
  }
}

/** The absolute path of git, or null when git is not on PATH. */
export const resolveGit = createGitResolver()

export class GitNotFoundError extends Error {
  constructor() {
    super('git was not found on PATH')
    this.name = 'GitNotFoundError'
  }
}

/** The absolute path of git. Throws GitNotFoundError when git is not on PATH. */
export async function requireGit(): Promise<string> {
  const git = await resolveGit()
  if (!git) throw new GitNotFoundError()
  return git
}

/**
 * Options placed before the subcommand of every git call HELM makes.
 *
 * `core.fsmonitor=false` stops git from running the program that a repository's own .git/config
 * names in core.fsmonitor. git runs that program during status, fetch, stash and other commands
 * that refresh the index, so without this a repository could run code during the Fleet scan.
 * A setting given with -c on the command line wins over the repository's config file.
 */
export const GIT_SAFE_OPTIONS: readonly string[] = ['-c', 'core.fsmonitor=false']

/** `args` (the git subcommand and its arguments) with GIT_SAFE_OPTIONS in front. */
export function withSafeGitOptions(args: string[]): string[] {
  return [...GIT_SAFE_OPTIONS, ...args]
}
