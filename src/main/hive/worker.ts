import { spawn, type ChildProcess } from 'child_process'

// The IPC connection owns the agent lifetime, including an unexpected Helm exit.
let child: ChildProcess | undefined
let stopped = false
let reason = 'Stopped by operator'
let timeout: ReturnType<typeof setTimeout> | undefined
let escalation: ReturnType<typeof setTimeout> | undefined

function signalTree(signal: NodeJS.Signals): void {
  if (!child?.pid) return
  try { process.kill(-child.pid, signal) } catch { /* Already exited. */ }
}

function stop(message: string): void {
  if (stopped) return
  stopped = true
  reason = message
  signalTree('SIGTERM')
  escalation = setTimeout(() => signalTree('SIGKILL'), 2000)
  if (!child) process.exit(0)
}

function send(message: unknown): void {
  if (process.connected) process.send?.(message, () => {})
}

process.on('disconnect', () => stop('Helm disconnected'))
process.on('message', (message) => {
  const request = message as { type: string; command: string; args: string[]; cwd: string; input: string; timeoutSeconds: number }
  if (request.type === 'stop') return stop('Stopped by operator')
  if (request.type !== 'start' || child || stopped) return
  if (process.platform === 'win32') {
    send({ type: 'exit', code: 1, error: 'Managed launch currently requires macOS or Linux process groups.' })
    process.exit(1)
  }
  child = spawn(request.command, request.args, {
    cwd: request.cwd, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe']
  })
  let pending = ''
  let totalBytes = 0
  child.once('spawn', () => send({ type: 'spawn', pid: child?.pid }))
  child.stdin?.on('error', () => {})
  child.stdin?.end(request.input)
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    totalBytes += Buffer.byteLength(chunk)
    pending += chunk
    if (totalBytes > 4 * 1024 * 1024 || Buffer.byteLength(pending) > 512 * 1024) {
      return stop('Provider output exceeded the limit')
    }
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      try { send({ type: 'event', event: JSON.parse(line) }) } catch { /* Non-JSON output is not a task signal. */ }
    }
  })
  // Do not persist diagnostics that can include provider credentials or local context.
  child.stderr?.resume()
  child.once('error', () => send({ type: 'error', error: 'Provider could not start. Check its executable and sign-in.' }))
  child.once('close', (code) => {
    clearTimeout(timeout)
    clearTimeout(escalation)
    if (pending.trim()) {
      try { send({ type: 'event', event: JSON.parse(pending) }) } catch { /* Ignore incomplete output. */ }
    }
    // A provider can leave descendants after its own process exits.
    signalTree('SIGKILL')
    send({ type: 'exit', code, stopped, error: stopped ? reason : undefined })
    if (process.connected) process.disconnect()
    process.exitCode = 0
  })
  timeout = setTimeout(() => stop('Run time limit reached'), request.timeoutSeconds * 1000)
})
