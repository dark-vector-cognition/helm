import { execFile } from 'child_process'
import { requireGit, withSafeGitOptions } from '../git-binary'

/**
 * Safe command running for paths that come from config or the file system.
 *
 * Paths never go inside a command string. A command string has its own quoting rules
 * (PowerShell even treats the curly quote characters as quotes), and a path with a quote in it,
 * for example O'Brien, would break the command or run part of the path as code. So:
 *
 * - PowerShell gets a fixed script and reads each value from an environment variable.
 * - Other commands get the value as a separate execFile argument, with no shell.
 */

/** Prefix for the environment variables that carry values into a PowerShell script. */
export const POWERSHELL_ENV_PREFIX = 'HELM_PS_'

export function powerShellArgs(script: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', script]
}

interface RunOptions {
  timeout?: number
  env?: NodeJS.ProcessEnv
  cwd?: string
}

/**
 * Run a program and capture its output. A failure rejects with the error from execFile plus the
 * captured `stdout` and `stderr`. The callback form of execFile passes them as separate arguments
 * and leaves them off the error, so without this the program's own explanation, for example git's
 * "No stash entries found.", would be lost.
 */
function runCapture(
  file: string,
  args: string[],
  options: RunOptions
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      const captured = { stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }
      if (error) reject(Object.assign(error, captured))
      else resolve(captured)
    })
  })
}

async function run(file: string, args: string[], options: RunOptions): Promise<string> {
  return (await runCapture(file, args, options)).stdout
}

/**
 * Run a fixed PowerShell script. `values` become environment variables named
 * HELM_PS_<NAME>; the script reads them as `$env:HELM_PS_<NAME>`. The script text never
 * contains a value, so no value can change what the script does.
 */
export function runPowerShell(
  script: string,
  values: Record<string, string>,
  timeout: number
): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [name, value] of Object.entries(values)) {
    env[`${POWERSHELL_ENV_PREFIX}${name}`] = value
  }
  return run('powershell.exe', powerShellArgs(script), { timeout, env })
}

/** Run a program with separate arguments and no shell. `cwd` is the working directory. */
export function runFile(
  file: string,
  args: string[],
  options: { timeout?: number; cwd?: string } = {}
): Promise<string> {
  return run(file, args, options)
}

/**
 * Run git in `cwd`. git is started by its absolute path, found on PATH only (see git-binary.ts),
 * so a git.exe planted in the repo cannot run. With no shell, neither the arguments nor the path
 * are parsed as a command. core.fsmonitor is turned off, so the repo's own config cannot run a
 * program during the call. Rejects with GitNotFoundError when git is not on PATH. A git failure
 * rejects with the error from execFile, which carries stdout and stderr.
 */
export async function runGit(
  args: string[],
  options: { cwd: string; timeout?: number }
): Promise<{ stdout: string; stderr: string }> {
  const git = await requireGit()
  return runCapture(git, withSafeGitOptions(args), options)
}

/**
 * Expand a file pattern with the shell. The pattern is a positional argument ($1), so it is never
 * parsed as a command. IFS is emptied so a space in the pattern does not split it into several
 * words, while the wildcards still expand. `ls -d --` ends option parsing, so a match whose name
 * starts with a dash is read as a file name and not as an option, and -d lists a matching
 * directory by its own name instead of its contents.
 */
export const SH_EXPAND_GLOB_SCRIPT = 'IFS=; ls -d -- $1 2>/dev/null || true'

/** Find .git directories up to two levels under `dir`. */
export const POWERSHELL_FIND_GIT_SCRIPT =
  "Get-ChildItem -LiteralPath $env:HELM_PS_DIR -Recurse -Depth 2 -Directory -Force -Filter '.git' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName"

/** Expand a file pattern (wildcards allowed) to full paths. */
export const POWERSHELL_EXPAND_GLOB_SCRIPT =
  'Get-ChildItem -Path $env:HELM_PS_PATTERN -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName'
