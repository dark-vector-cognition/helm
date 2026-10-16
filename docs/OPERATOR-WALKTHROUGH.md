# HELM Operator Walkthrough

HELM is a page-based desktop shell for watching local AI systems, repo drift, agents, and machine posture without collapsing all of it into one screaming dashboard. This guide covers the 5.0 shell (Helm Light).

## Shell Layout

HELM keeps a few things visible no matter which page you are on:

- The top header carries the operator wire, `Secure View`, skin selection, and a manual `Refresh` action.
- The scorecards strip keeps machine posture visible without forcing every tab to duplicate CPU, memory, network, agents, ports, repos, disk, and battery summaries.
- The left navigation rail is the page contract of the app. If a surface has its own page, it should not also be squatting somewhere else.
- The shell skin selector lets you swap between `Deck`, `Orbiter`, `Forge`, and `Phantom` without breaking the shared chrome language.
- `Secure View` is the demo-safe switch. It redacts local endpoints, peer IPs, and filesystem paths across visible operator surfaces.
- The header also carries the Sentinel status chip, so alert pressure stays visible even when you are off the Logs page.

## Pages

### Bridge

Use `Bridge` when you want the fastest read on what changed and where to drill next.

- Keeps attention on posture, hotspots, notifications, and the compact briefing layer.
- It is overview-only by design.

### Fleet

Use `Fleet` for repos, workspace drift, and process orchestration.

- `Git Status` turns dirty repos and remote drift into actions like `Stash`, `Fetch`, and `Pull`.
- `Command Center` stays the operational view for sorting and triaging live workspaces.

### Swarm

Use `Swarm` when you want the real agent roster instead of a vague badge.

- Tracks detected agent sessions such as Codex, Claude Code, Cursor, Gemini CLI, and other supported tools.
- Clicking an agent drills into PID, command, workspace, ports, and related timeline context.

### Grid

Use `Grid` for infrastructure posture and network visibility.

- The traffic grid turns live connections into scoped `loopback`, `LAN`, and `internet` topology.
- Ports and the security posture live here instead of being repeated elsewhere.

### AI

The optional local-model loop.

- The AI page owns the model connection, briefings, repair, and usage tracking.
- The model is optional. With none configured the page still renders and briefings show a "No model configured" state.
- The page is for operator control, not general system summary.

### Vault

Use `Vault` to search and browse an Obsidian vault.

- Search queries a vault-rag server, by default at `http://127.0.0.1:8742`. If it is not running the page shows it as offline.
- Reindex runs a local script by default. It only uses `ssh` when the location is set to remote and a host is configured. A blank host is refused.
- Notes you push are written into the vault's `Inbox` folder by default.

### Registry

Use `Registry` when you want the long view instead of the live roster.

- It keeps the permanent historical record of built agents, tools, and systems.
- Entries track impact score, lineage, deployment targets, key outputs, and lessons learned.
- Data persists at `~/.config/helm/agent-registry.json`.

### Radio

Use `Radio` when you want the live audio surface.

- Preset stations, local MP3s, manual URLs, and persisted playback state all live in one tuner view.
- The signal map traces station origin back to the operator's saved home endpoint on a real-world orthographic map.

### Logs

Use `Logs` when you need the raw stream instead of summaries.

- Live log tailing and persisted history live here.
- This page is for “what happened?” rather than “what should I do right now?”

## Sentinel

Sentinel is the background watcher running in the main Electron process. It polls system state on an interval and raises alerts when configured rules trigger.

Built-in coverage includes:
- Agent crash detection
- Sustained high CPU
- Memory pressure
- Port conflicts
- LM Studio idle detection
- Long-running agent detection
- Vault RAG server down
- Idle HIVE sessions and HIVE worktree conflicts

The Sentinel status chip in the header stays green, amber, or red depending on active alert severity.

## Core Actions

### Refresh

Click Refresh in the header or use the tray menu's Refresh Now. Forces a new monitor pass.

### Command Palette

- `Cmd/Ctrl+K` opens the command palette.
- HELM can surface quick actions such as opening a page, killing a port owner, or acting on a workspace group.

### Briefing

- `Cmd/Ctrl+B` requests a local AI briefing.
- With no model configured, HELM only looks for a server on this machine at `http://localhost:1234`. It does not scan your network.

### Model Connection Repair

- Any OpenAI-compatible server works, including LM Studio, Ollama, and llama.cpp.
- `Invoke Repair` probes the configured endpoint and healthy local or LAN fallbacks. It only scans beyond this machine when an endpoint is configured.
- When HELM finds a healthy server, it persists the repaired URL back into config.
- For a model host on another machine, enable network serving there and open the firewall on the chosen port.

## Persistence

HELM keeps local state instead of pretending everything is ephemeral:

- SQLite stores snapshots, alerts, briefings, notifications, posture history, timeline events, and log history.
- Config lives at `~/.config/helm/config.json`.
- Agent registry lives at `~/.config/helm/agent-registry.json`.
- `.env` can override local development settings such as `LM_STUDIO_URL`. Leave it unset to run with no model.

## Recommended Flow

If you are using HELM as intended, the normal loop is:

1. Start in `Bridge`.
2. Follow the signal to `Fleet`, `Swarm`, `Grid`, `AI`, `Vault`, `Radio`, or `Logs`.
3. Use the page-local actions instead of trying to solve everything from the top layer.
4. Come back to `Bridge` when you want posture again instead of detail.
5. Use `Registry` when you want the historical archive instead of the live operating picture.

That is the whole point of the shell. The side nav is not decorative. It is how the app avoids turning back into a giant panel graveyard.
