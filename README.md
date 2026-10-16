# HELM: Operator Shell for Local AI Systems

HELM is a desktop ops shell for developers running AI agents, local services, and multi-machine model workflows. It keeps overall system status visible while giving each domain its own page instead of forcing everything into one dense dashboard.

Current version: `5.0.0` (Helm Light, Apache-2.0).

## What's new in 5.0

For anyone who cloned an earlier version:

- **Apache-2.0.** HELM moves from PolyForm Noncommercial 1.0.0 to the Apache License 2.0, so you can use, modify, and redistribute it, including commercially. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
- **First run works without a model.** The app starts and every page renders with no model configured. AI briefings are optional and work with any OpenAI-compatible server (LM Studio, Ollama, llama.cpp, and others). With nothing configured, HELM only checks your own machine on the default port and never scans your network.
- **Electron 41.** Electron 35 to 41.10.7, with `better-sqlite3` 12.11.1 and refreshed build tooling. Node.js 22.12 or newer is now required.
- **Fixes.** Windows code paths for the port, network, process, battery, disk, and firewall monitors, a fix for Windows firewall rule parsing, tighter agent detection, quieter notifications, and a guard so a blank remote vault host can never start an `ssh` call. Details are in the [CHANGELOG](CHANGELOG.md).

Helm Go, the full signed build with auto-update and support, is coming soon.

## Quick Start (2 minutes)

New here? Paste [`docs/llm-setup-prompt.md`](docs/llm-setup-prompt.md) into your AI assistant for guided setup.

```bash
git clone https://github.com/dark-vector-cognition/helm.git
cd helm
cp .env.example .env
npm install
npm run dev
```

Requires Node.js 22.12 or newer. No model is needed to run HELM. If you want AI briefings, point it at any OpenAI-compatible server (see [Local AI Workflow](#local-ai-workflow)).

## Navigation (9 Pages, Zero Panel Duplication)

Every panel appears on exactly one page. No duplicated widgets, no redundant noise.

| Page | What it does |
|------|-------------|
| **Bridge** | Mission control: command center, compact AI briefing, notifications |
| **Fleet** | Repo drift and process orchestration: workspaces, git status, commit history |
| **Swarm** | Agent operations: live agent state, swarm load, session timeline, HIVE control |
| **Grid** | Infrastructure posture: network traffic, security scans, listening ports |
| **AI** | Optional model connection, AI briefings, Claude Code usage tracking |
| **Vault** | Search and browse an Obsidian vault through a vault-rag server, and push notes into it |
| **Registry** | Historical record: ranked agent archive, lineage, outputs, and lessons learned |
| **Radio** | FM streaming tuner with presets, local MP3 import, and direct URL loading |
| **Logs** | Live log tailing and system event stream |

Operator walkthrough: [docs/OPERATOR-WALKTHROUGH.md](docs/OPERATOR-WALKTHROUGH.md)

### Traffic Grid

The capture below is from the 4.0 shell and was taken with `Secure View` enabled, so local hosts, paths, and endpoint details stay redacted.

![HELM Traffic Grid](docs/screenshots/helm-4-grid-topology.png)

## Core Capabilities

- **Bridge** surfaces health, hotspots, command center, and the compact AI briefing
- **Fleet** handles repo drift, process orchestration, git status, and commit history
- **Swarm** tracks active agent processes, cadence, coordination load, and per-agent drill-down, and launches HIVE agents (analyst, architect, builder, ops)
- **Grid** exposes ports, scoped traffic topology, and security tools
- **AI** centralizes the optional model connection, briefing requests, and Claude Code usage tracking
- **Vault** searches and browses an Obsidian vault through a local or remote vault-rag server, and can push notes into it
- **Registry** preserves impact-ranked agent history, lineage, stacks, outputs, and lessons learned. It starts empty on first run
- **Radio** plays public live streams with presets, search, custom URLs, saved volume and station state, and a mapped signal globe tied to your configured home endpoint
- **Logs** keeps live log tailing separated from operational controls
- **Sentinel** watches system state in the background and raises alerts from a set of configurable rules
- **SQLite persistence** stores snapshots, alerts, briefings, notifications, and log history locally

## Local AI Workflow

The model is optional. HELM runs the same with or without one, and every page renders either way.

To turn on AI briefings, point HELM at any OpenAI-compatible server. No cloud inference is required.

- Set `LM_STUDIO_URL` in `.env`, or `lmStudioUrl` in `~/.config/helm/config.json`
- With nothing configured, HELM does not scan your network. `Request Briefing` only looks for a server on this machine at `http://localhost:1234` and otherwise shows a calm "No model configured" state
- Once an endpoint is configured, `Invoke Repair` probes it plus local and LAN-discovered fallbacks, and saves a repaired URL when it finds a healthy server

For cross-machine setups, enable network serving on the model host and make sure the chosen port is reachable through the host firewall.

## Stack

Electron 41 · React 18 · TypeScript · Tailwind 4 · Zustand · SQLite (`better-sqlite3`) · Vite (`electron-vite`) · Vitest

Electron remains the pragmatic cross-OS shell here because HELM depends on desktop IPC, tray integration, local process inspection, filesystem access, and machine-adjacent monitoring.

## Configuration

Config file: `~/.config/helm/config.json`

| Option            | Default                 | Description                                         |
| ----------------- | ----------------------- | --------------------------------------------------- |
| `lmStudioUrl`     | unset (no model)        | OpenAI-compatible server URL for AI briefings       |
| `gitRepoPaths`    | `[]`                    | Paths to monitor for git status                     |
| `monitorInterval` | `2000`                  | Monitor polling interval in milliseconds            |
| `staffBinPath`    | auto-detected           | Path to the `staff` binary for security scans       |

Optional local override:

```bash
cp .env.example .env
# Paths in `.env` may be absolute, `~`-relative, or relative to the repo root.
# Example:
LM_STUDIO_URL=http://localhost:1234
HELM_GIT_REPO_PATHS=.,../shared-repos
```

## Skins

4 built-in skins, toggled with Cmd+Shift+S (Mac) / Ctrl+Shift+S:

- **Deck** - Dark gunmetal chrome, cool cyan accent
- **Orbiter** - Warmer chrome with teal-green accent
- **Forge** - Reactor gold on black, machine warmth
- **Phantom** - Deep violet neon on obsidian, night ops

## Testing

```bash
npm run typecheck
npm test
```

## Platform Support

- **macOS**: primary supported platform
- **Windows and Linux**: guarded monitor paths. Windows parsers for ports, network, processes, battery, disk, and firewall are covered by unit tests but have not been exercised on real Windows hardware. Some local monitor integrations remain macOS-first

## License

HELM is open source under the [Apache License 2.0](LICENSE). Copyright 2026 Dark Vector Cognition LLC. See [NOTICE](NOTICE).
