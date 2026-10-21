# Changelog

Entries are ordered newest first. `Unreleased` covers mainline work after the latest tagged release, and tagged dates are written in America/Chicago local time.

## v6.0.0 - Unreleased

HELM V6: supervised agent runs, the Signal interface and a signed Mac download.

### Agent Supervision
- Bounded local runs for Claude Code, Cursor and Codex with an explicit provider, workspace, permission mode and time limit
- Distinct stages for acceptance, work, returned result and operator review. A process start does not count as acceptance
- Stop waits for the provider to exit. Retry keeps the earlier record
- Private run journals recover after a restart. Closing the window keeps managed work in the tray; quitting stops it
- Windows managed launch is unavailable. Windows monitoring remains available

### Signal Interface
- Graphite shell, restrained lime accent, clearer navigation and a full-width run workspace
- Visuals pause when hidden or off screen, respect reduced motion and animate only during activity
- The palette applies before canvas effects read it. Page navigation resets scroll position

### AI Connection
- Briefings can pin one named model instead of the first catalog entry, for the configured endpoint only. A successful briefing names its model when the provider reports one
- Empty responses show a failure, never Briefing Ready
- Briefing requests do not follow redirects. A redirect shows as a redirect, not as an offline server
- Provider environment keys apply only to their exact HTTPS endpoints. A briefing to any endpoint outside this machine and the local network sends CPU and memory totals only

### Support
- Optional Support HELM link beside the team enquiry link. No feature gates

### Packaging
- macOS: Developer ID signing, hardened runtime and notarization through a notarytool keychain profile (`scripts/build-mac-release.sh`). The DMG name now includes the architecture
- macOS: Apple Events entitlement and usage text for agent session attach under the hardened runtime. HELM runs `osascript`, and `osascript` sends the Apple Event that opens Terminal
- macOS: a Mac build fails without the Developer ID identity (`forceCodeSigning`). The release workflow no longer publishes on a tag push. It runs by hand for an existing `vX.Y.Z` tag, and it notarizes and staples the DMG before verification
- Windows: the executable is now `helm-light.exe` to avoid a collision with the Kubernetes `helm` command. The application ID is unchanged for upgrades

## v5.0.0 - 2026-10-16

Helm Light: the open-source release.

### License
- Relicensed from PolyForm Noncommercial 1.0.0 to the Apache License 2.0. `LICENSE` carries the full text and `NOTICE` carries the attribution line
- Package metadata, repository links, and the Linux maintainer now point at `dark-vector-cognition/helm` and Dark Vector Cognition LLC

### First Run
- HELM starts and every page renders with no model configured. AI briefings are optional
- Any OpenAI-compatible server can be used for briefings, including LM Studio, Ollama, and llama.cpp
- Optional API key for hosted OpenAI-compatible endpoints: set `apiKey` in `~/.config/helm/config.json`, or set `LLM_API_KEY` together with `LM_STUDIO_URL` in the environment (the environment pair wins, and `LLM_API_KEY` alone is ignored). The key is sent as `Authorization: Bearer <key>` only to the configured endpoint. With no key set, no Authorization header is sent. A save that changes `lmStudioUrl` without a new key deletes the stored key
- The key never reaches the UI process. The settings API returns the config with `apiKey` as an empty string plus a `hasApiKey` flag, saves keep the stored key unless a new non-empty key is sent, and a separate clear action removes it
- With no endpoint configured, `Request Briefing` shows a calm "No model configured" state instead of an offline warning, and only checks this machine on the default port. The network is never scanned unless an endpoint was configured
- `.env.example` no longer sets a model endpoint by default

### Platform
- Electron 35.7.5 to 41.10.7, with `better-sqlite3` 12.11.1 (12.6.2 does not compile against the Electron 41 runtime) and current `vite` and `vitest` patch releases
- Picked up the patched transitive packages from the open security updates: `@xmldom/xmldom`, `lodash`, `ip-address`, `picomatch`, `tmp`, `flatted`, and `tar`
- Node.js 22.12 or newer is now required. CI and release jobs run on Node 22
- Added Windows code paths for the network, port, process, battery, disk, and firewall monitors, plus Windows process protection and `taskkill` handling. These are covered by unit tests but have not been exercised on real Windows hardware
- The Windows firewall (`netsh`) parser splits rules on the rule name line and accepts CRLF output, so each rule keeps its own name and action

### Fixes
- Remote vault reindex refuses a blank or whitespace-only host and never starts `ssh`. Local mode with the empty default host runs the local script. Both cases are tested
- Agent detection no longer counts desktop apps, one-shot exec jobs, or helper services as standing agents
- Quieter defaults: native notifications only for critical alerts, longer throttle and cooldown windows, and higher auto-heal thresholds

### Agent Registry
- Added a permanent historical record of agents with impact scoring, lineage tracking, stack info, key outputs, and lessons learned
- New **Registry** page with ranked list, detail view, status filters, and summary stats. It starts empty on first run
- Full CRUD via IPC: getAgentRegistry, getAgentById, updateAgentEntry, getTopAgents
- Data persists to `~/.config/helm/agent-registry.json`

### Sentinel Watcher
- Background daemon polling system state every 30s with 9 configurable rules: agent-crash, high-cpu, high-memory, port-conflict, vault-rag-down, lm-studio-idle, long-running-agent, hive-idle-reclaim, hive-worktree-conflict
- Notification channels: macOS native notifications, Obsidian vault log (`~/Documents/ai/obsidian-vault/sentinel/`), Slack webhook (configurable)
- Per-rule cooldowns to prevent alert fatigue
- Sentinel status indicator in the HELM header (green/amber/red dot)

### Vault
- Added the **Vault** page: search and browse an Obsidian vault through a vault-rag server, with a status bar, chunk viewer, and note push

### Removed
- Removed the security scan feature: the Grid page panel, its IPC handlers and preload methods, the scan history reader, and its binary-path, network-target and report-path settings. An existing history table in your database is left untouched, with its rows
- Removed the optional voice persona briefing mode, including the `Cmd/Ctrl+Y` shortcut, its lens setting, and its environment overrides. The standard briefing is unchanged
- Removed the fifth built-in HIVE role. HIVE ships four roles: analyst, architect, builder, and ops
- Removed planning notes, the path audit, the wiki journal, and out-of-date screenshots from `docs/`

### Tests
- 41 test files, 447 tests. New coverage for the Windows parsers, the no-model briefing path, the unconfigured endpoint probe, the vault reindex guards, the API key rules, running commands without a shell, finding git without searching the working directory, and running git with the repo's own fsmonitor setting turned off

## v4.0.2 - 2026-03-22

### OOTB Setup
- Removed startup assumptions that depended on the caller's working directory
- Resolved bundled runtime assets from the current clone or packaged resources instead of hardcoded repo layouts
- Replaced the default Fleet scan root with the current clone when HELM is launched from the repo root
- Added a documented `.env.example` with optional overrides for LM Studio, repo scanning, agent feeds, logs, Sentinel, and HIVE

### Reliability
- Made Sentinel vault logging and LuLu parser lookup configurable instead of assuming one machine layout
- Added packaged-resource shipping for registry seed data, Sentinel config, HIVE role prompts, and the LuLu parser helper

### Docs
- Added an LLM-friendly setup prompt at `docs/llm-setup-prompt.md`
- Reordered the README so quick start comes before shell walkthrough details
- Added release collateral for the OOTB setup patch

## v4.0.1 - 2026-03-21

### FM Radio
- Replaced the hardcoded radio home endpoint with a first-run setup popup and persisted user-configured home location
- Updated the signal globe and route readout to handle an unset home endpoint gracefully instead of assuming a built-in city

### Docs
- Updated release collateral to reflect the `v4.0.1` patch tag and the new configurable radio-home flow

## v4.0.0 - 2026-03-21

### Product
- Renamed the product to HELM across app identity, config surfaces, and the visible shell language
- Collapsed the shell into seven owned pages so `Bridge`, `Fleet`, `Swarm`, `Grid`, `AI`, `Radio`, and `Logs` stop repeating the same story
- Added the `Phantom` skin alongside the existing `Deck`, `Orbiter`, and `Forge` themes

### Operations
- Added Swarm drill-down so agent rows open into PID, command, ports, goals, and timeline context
- Rebuilt Grid around a live traffic-topology canvas with scoped `loopback`, `LAN`, and `internet` peers
- Replaced filler header trivia with local AI ticker updates for agents, skills, and operator activity

### Persistence
- Moved the shell toward true continuity with persisted snapshots, alerts, briefings, notifications, timeline events, and log history
- Tightened startup restore so persisted state shows up in the UI instead of feeling fresh every launch

### FM Radio
- Restored the signal globe as a real station-to-home route, now rendered from actual world land geometry instead of placeholder continent blobs
- Fixed the home receiving point to a stable route anchor

### Docs
- Refreshed the README with current 4.0 captures for AI control, the signal map, and the traffic grid
- Added dedicated release notes for `v4.0.0` and pointed release automation at tag-specific notes

## v3.1.0 - 2026-03-18

### Shell
- Reworked the shell into a tighter machine-chrome shell with clearer hierarchy across header, nav, scorecards, panels, and the command palette
- Expanded the skin system to `Deck`, `Orbiter`, and `Forge`, with persisted shell-wide theming instead of isolated treatment changes
- Tightened the AI page presentation so the visualizer and action tray read like one instrument instead of a pile of neighboring widgets

### FM Radio
- Added a dedicated `FM Radio` page with a Winamp-style stereo relay layout, presets, search, transport controls, manual stream loading, and local MP3 import
- Added a main-process localhost radio relay so remote streams, manual URLs, and local files play through a stable Electron media path
- Added native audio-file picking, persisted local library entries, and a singleton audio engine so playback survives navigation

### Reliability
- Allowed loopback media in the renderer CSP and tightened window startup so the FM deck and shell surface appear reliably on launch
- Fixed Electron launch visibility and autoplay-policy issues that were blocking radio playback and, in some cases, leaving the app visually absent on startup

### License
- Starting with `v3.0.0`, HELM ships under PolyForm Noncommercial 1.0.0 instead of MIT
- Earlier releases through `v2.1.2` remain available under the terms they were originally distributed under

## v3.0.0 - 2026-03-18

### Product
- Recast the shell around a full chrome system so header, nav, scorecards, panels, insight cards, and the command palette all share the same retro-futurist control-room surface
- Added persisted `Deck` and `Orbiter` skins, with `Orbiter` becoming the tighter default shell for new sessions
- Added the new `FM Radio` page with preset station search, tuner controls, loading/error states, and support for custom stream URLs

### Release
- Starting with `v3.0.0`, HELM ships under PolyForm Noncommercial 1.0.0 instead of MIT
- Earlier releases through `v2.1.2` remain available under the terms they were originally distributed under

## v2.1.2 - 2026-03-15

### Product
- Re-contained the Live Lattice AI sphere inside a responsive `2:1` frame so the globe scales with the AI page instead of overflowing into neighboring panels
- Refocused the AI page around the LM Studio surface instead of duplicating `Notifications`, `Agents`, `Timeline`, and `Command Center` inside the same view

### Reliability
- Fixed the Agents sidebar badge so it reflects the detected roster instead of only showing queued agents
- Tightened agent detection to ignore Codex helper processes, `codex-cli-mcp-tool`, and macOS `CursorUIViewService` false positives

### Operations
- Fixed GitHub Actions CI on Node 20 by rebuilding `better-sqlite3` for the Node runtime before Vitest runs

### Docs
- Updated the README to reflect the shipped Live Lattice patch line and current release state
- Added an operator walkthrough covering pages, actions, shortcuts, and the current local AI workflow

## v2.1.1 - 2026-03-15

### Reliability
- Fixed agent detection so Codex helper processes and `CursorUIViewService` no longer inflate the agent roster
- Simplified the Agents sidebar badge so it shows the actual detected agent count instead of the old waiting-only value

### Operations
- Fixed GitHub Actions CI on Node 20 by rebuilding `better-sqlite3` for the Node runtime before running Vitest

### Docs
- Updated the README so the documented release state matches the shipped v2.1.1 patch line

## v2.1.0 - 2026-03-15

### Product
- Added the interactive AI core with a contained lattice visualization, globe sweep, and mono/color controls
- Expanded the Workspaces page into a real action surface with command-center sort controls, repo triage filters, bulk git actions, and dashboard shortcuts into the pages that need attention

### Intelligence
- Made Claude Code usage much more reactive by overlaying stale cache data with fresh session-log totals and exposing a `Refresh Live` action in the UI
- Improved agent awareness so Codex desktop and Claude CLI sessions are detected more reliably, and clarified CPU usage as per-core consumption instead of pretending `144%` is black magic

### Operations
- Added a GitHub Actions `CI` workflow that runs Vitest on pushes and pull requests to `main`
- Updated scorecards and overview summaries so total agents, engaged agents, repo drift, and CC spend route into the right operational views

### Tests
- Added coverage for live Claude usage aggregation and the expanded agent-detection process matching paths

## v2.0.0 - 2026-03-15

### Product
- Rebuilt the shell around dedicated pages for `Overview`, `Workspaces`, `Agents`, `Systems`, `AI`, and `Activity` instead of a single dense dashboard
- Added a persistent navigation shell with global status, health scorecards, and faster drill-down between operational views

### AI

### Reliability
- Preserved the LM Studio self-heal flow, including LAN repair support for remote Windows GPU hosts running LM Studio
- Improved renderer efficiency by mounting only the active page and allowing scorecards to wrap instead of compressing into a single strip

### Docs
- Refreshed the README for the v2 shell and added current screenshots for the `Overview` and `AI` pages

## v1.1.1 - 2026-03-15

### Reliability
- Added ARP-neighbor LM Studio discovery so `Invoke Repair` can recover when the LM Studio host is another machine on the LAN
- Improved unreachable diagnostics for remote LM Studio hosts, including explicit guidance for enabling network serving and firewall access

### Tests
- Added coverage for ARP-based remote endpoint repair and ARP neighbor parsing

## v1.1.0 - 2026-03-15

### Features
- LM Studio endpoint discovery and automatic failover across configured, localhost, and local network addresses
- Manual `Invoke Repair` action in the Local AI panel for one-click LM Studio recovery
- Briefing flows now persist repaired LM Studio endpoints back into HELM config

### Reliability
- Added the missing `CONFIG_SAVE` IPC handler so renderer-side config writes can actually be persisted
- Improved LM Studio failure messaging to report the checked endpoints instead of a generic fetch failure

### Tests
- Added LM Studio repair-path coverage for stale endpoint recovery, healthy endpoint passthrough, and unreachable endpoint reporting

## v1.0.0 - 2026-03-07

### Features
- File-backed autonomous agent ingestion (`*.state.json`, `*.trace.jsonl`)
- Network fallback to `netstat` when `nettop` permission-restricted
- AI briefing engine - on-demand Claude Haiku briefings via Cmd+B
- Auto-heal engine with 5 default rules and 60s cooldowns
- Process monitoring with smart grouping by project/agent/service
- Port monitoring via `lsof` parsing with port-to-process mapping
- AI agent detection for 8 types (Claude, Codex, Gemini, Cursor, Aider, Continue, Copilot)
- Git status tracking - multi-repo scanning with branch, dirty state, ahead/behind
- Network bandwidth monitoring via `nettop` with per-process rates (macOS)
- Firewall rule correlation via LuLu plist parsing (macOS)
- Live log file tailing
- Dashboard with 9 panels, 4 SVG chart components, and scorecards strip
- Time-series ring buffer (60 snapshots, ~2min history) with sparklines
- System tray with color-coded health indicator
- SQLite persistence (snapshots, alerts, briefings, notifications)
- XDG-compliant config system
- Desktop notifications with 30s throttle
- Platform detection with macOS/Linux/Windows guards

### Security
- Electron sandbox hardening
- `openExternal` URL validation
- `.gitignore` audit for sensitive files

### Tests
- 188 tests passing
