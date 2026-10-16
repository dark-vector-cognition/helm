import { execFile } from 'child_process'

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

function run(
  file: string,
  args: string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv }
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { ...options, maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout))
    })
  })
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

/** Run a program with separate arguments and no shell. */
export function runFile(file: string, args: string[], timeout?: number): Promise<string> {
  return run(file, args, { timeout })
}

/**
 * Expand a file pattern with the shell. The pattern is a positional argument ($1), so it is never
 * parsed as a command. IFS is emptied so a space in the pattern does not split it into several
 * words, while the wildcards still expand.
 */
export const SH_EXPAND_GLOB_SCRIPT = 'IFS=; ls $1 2>/dev/null || true'

/** Find .git directories up to two levels under `dir`. */
export const POWERSHELL_FIND_GIT_SCRIPT =
  "Get-ChildItem -LiteralPath $env:HELM_PS_DIR -Recurse -Depth 2 -Directory -Force -Filter '.git' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName"

/** Expand a file pattern (wildcards allowed) to full paths. */
export const POWERSHELL_EXPAND_GLOB_SCRIPT =
  'Get-ChildItem -Path $env:HELM_PS_PATTERN -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName'
