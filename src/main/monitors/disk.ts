import { exec } from 'child_process'
import { promisify } from 'util'
import { isWindows } from '../platform'

const execAsync = promisify(exec)

export interface DiskMount {
  filesystem: string
  mount: string
  totalBytes: number
  usedBytes: number
  availableBytes: number
  usagePercent: number
}

export interface DiskState {
  mounts: DiskMount[]
  maxUsagePercent: number
  timestamp: number
}

/**
 * Parse `df -Pk` output into typed mount entries.
 *
 * df -Pk outputs:
 *   Filesystem     1024-blocks      Used Available Capacity Mounted on
 *   /dev/disk3s1s1   489825072  12345678 123456789    10%   /
 */
export function parseDfOutput(raw: string): DiskMount[] {
  const lines = raw.trim().split('\n')
  if (lines.length <= 1) return []

  const results: DiskMount[] = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    // Split by whitespace - last field (mount point) may contain spaces
    const parts = line.split(/\s+/)
    if (parts.length < 6) continue

    const filesystem = parts[0]
    const totalBlocks = parseInt(parts[1], 10)
    const usedBlocks = parseInt(parts[2], 10)
    const availableBlocks = parseInt(parts[3], 10)
    const capacityStr = parts[4]
    const mount = parts.slice(5).join(' ')

    if (isNaN(totalBlocks) || isNaN(usedBlocks) || isNaN(availableBlocks)) continue

    // Skip pseudo-filesystems
    if (filesystem === 'devfs' || filesystem === 'map' || filesystem.startsWith('map ')) continue
    if (totalBlocks === 0) continue

    const usagePercent = parseInt(capacityStr.replace('%', ''), 10)

    results.push({
      filesystem,
      mount,
      totalBytes: totalBlocks * 1024,
      usedBytes: usedBlocks * 1024,
      availableBytes: availableBlocks * 1024,
      usagePercent: isNaN(usagePercent)
        ? (usedBlocks / totalBlocks) * 100
        : usagePercent
    })
  }

  return results
}

/**
 * Parse PowerShell Get-Volume CSV output into typed mount entries.
 *
 * Expected CSV columns: Filesystem, Mount, TotalBytes, UsedBytes, AvailableBytes
 */
export function parseWindowsDiskOutput(raw: string): DiskMount[] {
  const lines = raw.trim().split('\n')
  if (lines.length <= 1) return []

  const results: DiskMount[] = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim().replace(/"/g, '')
    if (!line) continue

    const parts = line.split(',')
    if (parts.length < 5) continue

    const filesystem = parts[0].trim()
    const mount = parts[1].trim()
    const totalBytes = parseInt(parts[2].trim(), 10)
    const usedBytes = parseInt(parts[3].trim(), 10)
    const availableBytes = parseInt(parts[4].trim(), 10)

    if (isNaN(totalBytes) || isNaN(usedBytes) || isNaN(availableBytes)) continue
    if (totalBytes === 0) continue

    const usagePercent = (usedBytes / totalBytes) * 100

    results.push({
      filesystem,
      mount,
      totalBytes,
      usedBytes,
      availableBytes,
      usagePercent
    })
  }

  return results
}

/**
 * Get current disk usage by running `df -Pk` (Unix) or PowerShell Get-Volume (Windows).
 */
export async function getDiskUsage(): Promise<DiskState> {
  const now = Date.now()

  try {
    let mounts: DiskMount[]

    if (isWindows()) {
      const cmd = `powershell.exe -NoProfile -Command "Get-Volume | Where-Object {$_.DriveLetter -ne $null -and $_.Size -gt 0} | Select-Object @{N='Filesystem';E={$_.DriveLetter + ':'}}, @{N='Mount';E={$_.DriveLetter + ':\\\\'}}, @{N='TotalBytes';E={$_.Size}}, @{N='UsedBytes';E={$_.Size - $_.SizeRemaining}}, @{N='AvailableBytes';E={$_.SizeRemaining}} | ConvertTo-Csv -NoTypeInformation"`
      const { stdout } = await execAsync(cmd, { timeout: 10000 })
      mounts = parseWindowsDiskOutput(stdout)
    } else {
      const { stdout } = await execAsync('df -Pk', { timeout: 5000 })
      mounts = parseDfOutput(stdout)
    }

    const maxUsagePercent = mounts.length > 0
      ? Math.max(...mounts.map((m) => m.usagePercent))
      : 0

    return { mounts, maxUsagePercent, timestamp: now }
  } catch {
    return { mounts: [], maxUsagePercent: 0, timestamp: now }
  }
}
