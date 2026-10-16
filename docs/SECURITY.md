# HELM Security Audit Report

> This report is a point-in-time audit of the 4.0 line, dated 2026-03-06. It has not been re-run for 5.0. In particular, `npm audit` currently reports advisories, mostly in build and test tooling, so treat the dependency results below as historical.

**Date:** 2026-03-06
**Scope:** Source code, dependencies, Electron configuration
**Auditor:** Claude Code (automated static analysis)

---

## Overall Rating: A-

HELM demonstrates strong security fundamentals: proper context isolation, sandboxed renderer, a well-scoped preload bridge, URL protocol validation, and process-kill safeguards.

**Update (2026-03-06):** The findings from the initial B+ audit that still apply to this release have been resolved:
- Sandbox mode enabled in webPreferences
- `shell.openExternal` now validates URL protocol (http/https only)
- `.gitignore` updated with `*.sqlite`, `*.db`, `*.sqlite-wal`, `*.sqlite-shm` patterns

Remaining gap to A at audit time: no CSP (Content-Security-Policy) configured for the renderer. A CSP has since been added in `src/renderer/index.html`.

---

## 1. Dependency Vulnerabilities

**Status: PASS**

```
npm audit: 0 vulnerabilities found
```

All direct and transitive dependencies were clean as of this audit date. That is no longer true of the 5.0 lockfile: run `npm audit` for current results.

---

## 2. Hardcoded Sensitive Values

**Status: PASS**

No API keys, tokens, or credentials were found anywhere in source.

**What's good:**
- No `ANTHROPIC_API_KEY` or `sk-ant-*` tokens in source
- API keys are loaded exclusively from environment variables and `.env` files
- `.env*` is in `.gitignore`
- LM Studio URL defaults to localhost, configurable via env var

---

## 3. .gitignore Coverage

**Status: PASS**

The `.gitignore` correctly covers:

| Pattern | Protects |
|---------|----------|
| `.env*` | Environment files with secrets |
| `*.local` | Local override files |
| `node_modules` | Dependencies |
| `dist`, `out` | Build artifacts |
| `*.log*` | Log files |
| `reports/` | Generated reports |

**Recommendation:** Consider adding `*.sqlite` and `*.db` to prevent accidental commits of local database files.

---

## 4. Electron Security Best Practices

### 4a. Context Isolation

**Status: PASS**

`contextIsolation` defaults to `true` in Electron 28+ and is not explicitly disabled. The preload script correctly uses `contextBridge.exposeInMainWorld()` to bridge the renderer.

### 4b. Node Integration

**Status: PASS**

`nodeIntegration` defaults to `false` in Electron 28+ and is not explicitly enabled. The renderer has no direct access to Node.js APIs.

### 4c. Sandbox Mode

**Status: PASS (fixed)**

The window's `webPreferences` in `src/main/index.ts` do not disable the sandbox, so the renderer is sandboxed by default on current Electron. The preload script runs in a sandboxed context with only `contextBridge` and `ipcRenderer` available, with no full Node.js access from the renderer.

### 4d. shell.openExternal

**Status: PASS (fixed)**

```typescript
// src/main/index.ts, setWindowOpenHandler
mainWindow.webContents.setWindowOpenHandler((details) => {
  try {
    const parsed = new URL(details.url)
    if (['https:', 'http:'].includes(parsed.protocol)) {
      shell.openExternal(details.url)
    }
  } catch {
    // Malformed URL: ignore
  }
  return { action: 'deny' }
})
```

URLs are validated before opening. Only `http:` and `https:` protocols are allowed. Malformed URLs are silently rejected.

### 4e. Other Electron Settings

**Status: PASS**

- `webSecurity` is not disabled (defaults to `true`)
- `allowRunningInsecureContent` is not enabled
- `enableRemoteModule` is not enabled
- `nodeIntegrationInSubFrames` is not enabled

---

## 5. Preload Bridge (contextBridge)

**Status: PASS**

`src/preload/index.ts` follows Electron security best practices:

- Uses `contextBridge.exposeInMainWorld('helm', api)` for proper isolation
- All IPC calls use typed channel constants from `shared/types.ts`
- No `require()`, `eval()`, `exec()`, `spawn()`, or `Function()` in preload
- No raw `ipcRenderer` exposed to renderer: all calls are wrapped in typed functions
- Return types are properly constrained (no generic `any` passthrough of Node APIs)

**Sensitive APIs exposed via IPC:**
| API | Risk | Mitigation |
|-----|------|------------|
| `killProcess(pid)` | High | PID validation, protected process list, PID-recycle check, uses `execFile` (not `exec`) |
| `signalProcess(pid, signal)` | High | Same safeguards as killProcess |
| `killGroup(pids, name)` | High | Same safeguards, applied per-process |
| `runGitAction(repoPath, action)` | Medium | Should be verified: action must be from a fixed set |
| `saveConfig(config)` | Low | Writes to XDG config path only |

---

## 6. Shell Command Execution

**Status: PASS (with notes)**

HELM's main process makes extensive use of `child_process.exec()` for system monitoring (`ps`, `lsof`, `nettop`, `df`, etc.). Review:

| Module | Method | Input Source | Injection Risk |
|--------|--------|-------------|----------------|
| `processes.ts` | `exec` | Hardcoded `ps aux` | None |
| `ports.ts` | `exec` | Hardcoded `lsof` | None |
| `network.ts` | `exec` | Hardcoded `nettop` | None |
| `battery.ts` | `exec` | Hardcoded `pmset` | None |
| `disk.ts` | `exec` | Hardcoded `df` | None |
| `git.ts` | `exec` | Fixed git commands; the repo path is the working directory, not part of the command | None |
| `git.ts`, `logs.ts` (path discovery) | `execFile` | Config and file system paths, passed as separate arguments (POSIX) or environment variables (PowerShell), never inside a command string | None |
| `actions.ts` | `execFile` | PID from renderer | Mitigated: `execFile` avoids shell, PID validated as integer |

**What's good:**
- `actions.ts` uses `execFile` (not `exec`), which is immune to shell injection

---

## 7. Summary

### What's Good

- **Clean `npm audit` at the time of the audit** (see the note at the top of this report)
- **No secrets in source**: all credentials via env vars, `.env` properly gitignored
- **Proper context isolation**: `contextBridge` used correctly, no Node APIs leaked to renderer
- **Process kill safeguards**: PID validation, protected process list, PID-recycle detection, `execFile` usage
- **No dangerous Electron flags**: `webSecurity`, `nodeIntegration`, `allowRunningInsecureContent` all at safe defaults

### Resolved Findings

| Priority | Finding | Status |
|----------|---------|--------|
| **Medium** | Preload ran unsandboxed | FIXED: sandbox is enabled |
| **Medium** | `shell.openExternal` accepts any URL protocol | FIXED: http/https allowlist |
| **Low** | `.gitignore` missing `*.sqlite`/`*.db` patterns | FIXED: patterns added |

### Remaining Recommendations

1. **Tighten the Content-Security-Policy**: a CSP now ships in `src/renderer/index.html` (self-only scripts, loopback media and connections). Consider removing `'unsafe-inline'` from `style-src`.
2. **Code-sign the .dmg**: required for macOS Gatekeeper. Not a source-level issue but needed for distribution.
