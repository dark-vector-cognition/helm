# Agent support and task status

Helm separates process discovery from task reports. A detected process has an unknown task state. CPU and memory are process samples, not evidence that an agent is busy, waiting or finished. Cursor renderer, GPU, utility and crashpad helpers do not count as agents.

Built-in discovery covers supported Claude Code, Codex, Gemini, Cursor, Aider, Continue and Copilot executable patterns. Cursor's main application can appear as a detected process. The exact `cursor-agent` executable can also appear. An unrelated command called `agent` does not establish Cursor identity. Discovery does not expose every session inside an editor.

Use a state feed for actual task lifecycle reports. Any local agent can write the contract below, including custom agents whose type appears as `Agent`. Cloud or remote agents need an explicit local feed transport; Helm does not automatically inspect their remote sessions.

## Cursor local agent hooks

The included adapter consumes Cursor's documented hook events. It records a separate hashed identity for each conversation. It never saves prompts, commands, tool output, email, transcript paths or raw conversation identifiers. It does not read Cursor's session database.

1. Find the absolute Node.js executable path. Use Node.js 22.12 or newer.
2. Find the absolute path to `scripts/cursor-agent-hook.mjs` in this clone.
3. Open [the hook configuration example](examples/cursor-hooks.json).
4. Replace its Node and script placeholders with those absolute paths. Quote paths that contain spaces.
5. Merge the example entries into the project's `.cursor/hooks.json`. Keep every existing hook and setting.
6. If you prefer user-wide hooks, merge into `~/.cursor/hooks.json` instead.
7. Start a Cursor session in that project. Check the state feed and Swarm's Task state column.

Do not overwrite an existing hooks file with the example. Existing permission and security hooks remain authoritative. This observer emits the required allow/continue response for its own permission hooks. It never denies a command, changes tool inputs or starts a follow-up prompt. Observation failures do not block Cursor.

[Cursor's hook documentation](https://cursor.com/docs/hooks) defines the available events and hook configuration. Cursor versions and modes can emit different event sets. The integration depends on the events that the installed version actually emits.

| Observed event | Reported state |
| --- | --- |
| Session starts | idle |
| Prompt submitted | active |
| Tool starts | busy |
| Tool ends | active |
| Turn completes or aborts | idle |
| Turn errors or session ends | unknown |

These are event reports, not a measure of the quality or completion of the user's goal. `idle` after a completed turn means that turn ended.

The adapter writes under `~/.config/helm/agents`. Set `HELM_AGENT_FEED_DIR` for another private directory, and add that same directory to Helm's `agentFeedPaths` configuration. A custom directory must have user-only permissions. New directories and files use 0700 and 0600 on this Mac. Windows ACL behavior has not been verified.

The adapter limits stdin to 64 KiB and 1.5 seconds. Malformed, oversized or unwritable reports are skipped without saving input. Check file timestamps if a report does not arrive. It creates no background heartbeat. A long-running call can become unknown until another real event arrives. Concurrent callbacks have receipt order only because the hook envelope has no authoritative event sequence.

Run `npm run test:agent-hooks` to exercise the actual stdin adapter with isolated fixtures. Fixture tests do not establish that a particular Cursor installation emits every hook.

## Feed contract for other agents

Write one `*.state.json` file for each agent in a configured `agentFeedPaths` directory. Use a stable, non-sensitive `agent_id`, a current UTC `last_heartbeat`, and an explicit `status` of `active`, `busy`, `idle`, `waiting` or `unknown`. Write a temporary file and atomically rename it so Helm cannot read a partial report.

```json
{
  "agent_id": "custom-reviewer",
  "status": "waiting",
  "last_heartbeat": "CURRENT_UTC_TIMESTAMP",
  "current_action": "Review complete; awaiting an operator"
}
```

Replace `CURRENT_UTC_TIMESTAMP` on every real update. A report must be less than two minutes old. Missing, invalid, future or stale timestamps produce an unknown state. Missing or invalid task states also stay unknown. Action text alone does not establish a busy state, and a missed heartbeat does not establish a waiting state.

An optional `display_name` gives the agent a readable label; keep it non-sensitive. Other optional fields include `session_start`, `current_tick`, `total_ticks`, `total_actions`, `goals` and `current_action`. Do not put secrets or private prompts into a feed. The source and heartbeat are visible in the detail view. An unknown state is a missing signal, not a pass or a completed task.
