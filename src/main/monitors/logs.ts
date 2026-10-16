import { watch, type FSWatcher } from 'fs'
import { readFile, stat } from 'fs/promises'
import { basename, join } from 'path'
import { homedir, tmpdir } from 'os'
import { isWindows } from '../platform'
import {
  POWERSHELL_EXPAND_GLOB_SCRIPT,
  SH_EXPAND_GLOB_SCRIPT,
  runFile,
  runPowerShell
} from './shell-run'
import type { HelmConfig, LogLine } from '../../shared/types'

export type LogBatchKind = 'initial' | 'tail'
type LogStreamCallback = (lines: LogLine[], kind: LogBatchKind) => void

interface WatchedFile {
  path: string
  label: string
  offset: number
  watcher: FSWatcher | null
}

const MAX_INITIAL_LINES = 100
const watchedFiles = new Map<string, WatchedFile>()
let logCallback: LogStreamCallback | null = null

function classifyLevel(text: string): LogLine['level'] {
  const lower = text.toLowerCase()
  if (lower.includes('error') || lower.includes('err ') || lower.includes('fatal')) return 'error'
  if (lower.includes('warn') || lower.includes('warning')) return 'warn'
  if (lower.includes('debug') || lower.includes('trace')) return 'debug'
  return 'info'
}

async function tailFile(
  filePath: string,
  fromOffset: number
): Promise<{ lines: LogLine[]; newOffset: number }> {
  try {
    const stats = await stat(filePath)
    if (stats.size <= fromOffset) return { lines: [], newOffset: fromOffset }

    const content = await readFile(filePath, 'utf-8')
    const newContent = content.slice(fromOffset)
    const label = basename(filePath)

    const lines = newContent
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((text) => ({
        timestamp: Date.now(),
        source: label,
        text: text.trim(),
        level: classifyLevel(text)
      }))

    return { lines, newOffset: stats.size }
  } catch {
    return { lines: [], newOffset: fromOffset }
  }
}

async function getInitialLines(filePath: string): Promise<{ lines: LogLine[]; offset: number }> {
  try {
    const content = await readFile(filePath, 'utf-8')
    const allLines = content.split('\n').filter((l) => l.trim().length > 0)
    const label = basename(filePath)

    const recentLines = allLines.slice(-MAX_INITIAL_LINES).map((text) => ({
      timestamp: Date.now(),
      source: label,
      text: text.trim(),
      level: classifyLevel(text)
    }))

    return { lines: recentLines, offset: Buffer.byteLength(content, 'utf-8') }
  } catch {
    return { lines: [], offset: 0 }
  }
}

async function watchLogFile(filePath: string): Promise<void> {
  if (watchedFiles.has(filePath)) return

  const { lines: initialLines, offset } = await getInitialLines(filePath)

  const watched: WatchedFile = {
    path: filePath,
    label: basename(filePath),
    offset,
    watcher: null
  }

  if (initialLines.length > 0 && logCallback) {
    logCallback(initialLines, 'initial')
  }

  try {
    watched.watcher = watch(filePath, async (eventType) => {
      if (eventType === 'change') {
        const { lines, newOffset } = await tailFile(filePath, watched.offset)
        watched.offset = newOffset
        if (lines.length > 0 && logCallback) {
          logCallback(lines, 'tail')
        }
      }
    })
  } catch {
    // File may not be watchable
  }

  watchedFiles.set(filePath, watched)
}

export async function expandGlobPattern(pattern: string): Promise<string[]> {
  try {
    let stdout: string

    if (isWindows()) {
      // The pattern reaches PowerShell as an environment variable, never inside the script text.
      stdout = await runPowerShell(POWERSHELL_EXPAND_GLOB_SCRIPT, { PATTERN: pattern }, 5000)
    } else {
      stdout = await runFile('sh', ['-c', SH_EXPAND_GLOB_SCRIPT, 'sh', pattern])
    }

    return stdout
      .trim()
      .split(/\r?\n/)
      .filter((f) => f.length > 0)
  } catch {
    return []
  }
}

async function discoverLogFiles(config?: HelmConfig): Promise<string[]> {
  const home = homedir()
  const today = new Date().toISOString().split('T')[0]
  const yearMonth = today.slice(0, 7)

  const defaultPatterns = isWindows()
    ? [
        join(home, '.claude', 'projects', '*', 'logs', '*.log'),
        join(tmpdir(), 'helm-*.log'),
        join(home, '.lmstudio', 'server-logs', yearMonth, '*.log'),
        join(home, 'AppData', 'Local', 'npm-cache', '_logs', '*.log')
      ]
    : [
        join(home, '.claude', 'projects', '*', 'logs', '*.log'),
        join(tmpdir(), 'helm-*.log')
      ]

  const files: string[] = []

  // Add explicitly configured log file paths (literal paths, not globs)
  if (config?.logFilePaths) {
    for (const filePath of config.logFilePaths) {
      if (filePath) files.push(filePath)
    }
  }

  for (const pattern of defaultPatterns) {
    const found = await expandGlobPattern(pattern)
    files.push(...found)
  }

  return [...new Set(files)]
}

export async function startLogMonitoring(
  callback: LogStreamCallback,
  config?: HelmConfig
): Promise<string[]> {
  logCallback = callback

  const files = await discoverLogFiles(config)
  for (const file of files) {
    await watchLogFile(file)
  }

  return files
}

export function stopLogMonitoring(): void {
  for (const watched of watchedFiles.values()) {
    watched.watcher?.close()
  }
  watchedFiles.clear()
  logCallback = null
}

export function getLogSources(): string[] {
  return Array.from(watchedFiles.keys())
}
