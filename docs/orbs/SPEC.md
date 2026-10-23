# Helm Orbs: spec v0.1

Status: draft. Breaking changes are allowed until v1.0.

Helm is a substrate. Capability arrives as Orbs. Every handoff passes a Gate.
Those are the only three primitives. Everything else is built from them.

| Primitive | What it is                                                                | File              |
| --------- | ------------------------------------------------------------------------- | ----------------- |
| Substrate | Base Helm: window, sign-in, MCP gateway, secret store, run log, task pool | none (it is Helm) |
| Orb       | One unit of capability: a model, a skill, or a graph of Orbs              | `orb.json`        |
| Gate      | A check on a handoff: admit typed output or reject it                     | `gate.json`       |

Derived ideas:

- The LLM interface is the first gate. It routes a request to an Orb.
- A graph is Orbs joined by gates. A graph is itself an Orb, so graphs nest.
- A collection is packaging: a list of Orbs that install together.

## 1. Orb kinds

| `kind`  | Role                                                     | Analogy   |
| ------- | -------------------------------------------------------- | --------- |
| `model` | Compute. Runs skills.                                    | Node pool |
| `skill` | Work. Runs on any model Orb that passes its healthcheck. | Pod       |
| `graph` | Work built from other Orbs and gates.                    | Workflow  |

Keep models and skills apart. A skill Orb never names a model. The substrate picks
the model Orb for each run. Rule: the cheapest model Orb that passes the skill's
healthcheck.

## 2. Orb requests, the substrate supplies

An Orb does not bring its own infrastructure. It lists what it needs in `requests`:

- `mcps`: MCP servers the Orb calls through the substrate's gateway.
- `secrets`: secret names. The substrate resolves values at run time.
  A manifest never contains a secret value.

## 3. Access: who gets access and when

`access.approval`:

- `none`: runs without a prompt.
- `first-use`: the operator approves once per install.
- `every-run`: the operator approves each run.

`access.localOnly: true` builds a data wall. The Orb's data may reach only model
Orbs with `model.dataBoundary: "local"`. The substrate enforces this with
`canRun(work, model)` before it schedules a run.

## 4. Healthcheck: prove the median

Skill and graph Orbs must declare a healthcheck. Model Orbs need not.

- `evalSet`: path to the eval cases, relative to the Orb folder.
- `passThreshold`: share of cases that must pass, in (0, 1].
- `minCases`: smallest eval set the substrate accepts.

The substrate refuses to load an Orb whose healthcheck fails. A skill description
alone is a claim. The eval set is the proof.

Median outcomes do not stack. Five steps that each pass 90% of the time pass
together 59% of the time (0.9^5). So a graph Orb carries its own end-to-end eval
set. Scores of its parts do not count.

## 5. Graphs

```json
"graph": {
  "entry": "fetch",
  "nodes": [{ "id": "fetch", "mode": "code" }, ...],
  "edges": [{ "from": "fetch", "to": "convert", "gate": "file-type" }, ...],
  "gates": [{ "id": "file-type", "path": "gates/file-type.gate.json" }, ...]
}
```

Each node sits on the lowest rung that works:

| `mode`       | Use when                             | Deviation                |
| ------------ | ------------------------------------ | ------------------------ |
| `code`       | The step is a rule.                  | None                     |
| `classifier` | The step picks from a fixed list.    | Low                      |
| `llm`        | The step needs judgment or language. | Fenced by `outputSchema` |

Rules the validator enforces:

- Every edge names a gate that the graph declares.
- Every `llm` node declares `outputSchema`.
- Every `classifier` and `llm` node names the Orb it `uses`.
- `entry` names a node. Node ids are unique.

## 6. Gates

```json
{
  "specVersion": "0.1",
  "name": "markdown-shape",
  "version": "1.0.0",
  "decision": "jev",
  "inputs": ["markdown"],
  "enforces": { "schema": "schemas/markdown-doc.json" },
  "onFail": "retry",
  "maxRetries": 2
}
```

- `decision`: `rule`, `classifier`, `jev` or `human`.
- `onFail`: `retry` (needs `maxRetries`), `escalate` or `reject`.
  A `human` gate cannot retry.
- `record`: default `true`. The run log records every gate decision. Drift
  monitoring reads these records, so deviation becomes a measured number.

The model is not deterministic, even at temperature 0. Gates make the path
deterministic and check every output. That is the guarantee this spec makes.

## 7. Versions

`name` is kebab-case. `version` is semver. A changed Orb or Gate gets a new
version. The run log stores the version with each run, so a replay uses the
same Orb.

## 8. Files in this folder

- `schema/orb.schema.json`, `schema/gate.schema.json`: JSON Schemas (draft 2020-12)
  for editors and third-party authors.
- `examples/pdf-to-markdown`: a skill Orb behind a data wall.
- `examples/local-model`: a model Orb with a local data boundary.
- `examples/doc-digest`: a graph Orb with three gates, one of them human.
- `src/main/orbs/manifest.ts`: the validator the substrate runs. No dependencies.

## 9. Not in v0.1

- Collections manifest.
- Orb install, update and removal flows.
- Router scoring and cost data.
- Signing and provenance of third-party Orbs.
