// Orb and Gate manifests, spec v0.1. See docs/orbs/SPEC.md.
// Dependency-free validation so the substrate can refuse a bad Orb before it loads.

export const SPEC_VERSION = '0.1'
export const ORB_KINDS = ['model', 'skill', 'graph'] as const
export const NODE_MODES = ['code', 'classifier', 'llm'] as const
export const GATE_DECISIONS = ['rule', 'classifier', 'jev', 'human'] as const
export const GATE_ON_FAIL = ['retry', 'escalate', 'reject'] as const
export const APPROVALS = ['none', 'first-use', 'every-run'] as const
export const DATA_BOUNDARIES = ['local', 'vendor'] as const
export const MODEL_RUNTIMES = ['cli', 'api', 'local'] as const

export type OrbKind = (typeof ORB_KINDS)[number]
export type NodeMode = (typeof NODE_MODES)[number]
export type GateDecision = (typeof GATE_DECISIONS)[number]
export type GateOnFail = (typeof GATE_ON_FAIL)[number]

export interface OrbRequests {
  mcps?: string[]
  /** Secret names only. The substrate resolves values; a manifest never holds them. */
  secrets?: string[]
}

export interface OrbAccess {
  approval: (typeof APPROVALS)[number]
  /** True: this Orb's data may only reach model Orbs whose dataBoundary is "local". */
  localOnly?: boolean
}

export interface OrbHealthcheck {
  evalSet: string
  passThreshold: number
  minCases: number
}

export interface GraphNode {
  id: string
  /** Orb name this node calls. Omit for plain code nodes. */
  uses?: string
  mode: NodeMode
  /** Required when mode is "llm": path to a JSON Schema the output must match. */
  outputSchema?: string
}

export interface GraphEdge {
  from: string
  to: string
  /** Gate id from graph.gates. Every handoff passes through a gate. */
  gate: string
}

export interface OrbGraph {
  entry: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  gates: { id: string; path: string }[]
}

export interface OrbModel {
  provider: string
  runtime: (typeof MODEL_RUNTIMES)[number]
  dataBoundary: (typeof DATA_BOUNDARIES)[number]
}

export interface OrbManifest {
  specVersion: string
  name: string
  version: string
  kind: OrbKind
  description: string
  skill?: { path: string }
  model?: OrbModel
  graph?: OrbGraph
  requests?: OrbRequests
  access: OrbAccess
  healthcheck?: OrbHealthcheck
  ui?: { globe?: boolean; icon?: string }
}

export interface GateManifest {
  specVersion: string
  name: string
  version: string
  decision: GateDecision
  inputs: string[]
  /** Path to the JSON Schema the admitted output must match. */
  enforces: { schema: string }
  onFail: GateOnFail
  maxRetries?: number
  /** Witness records every gate decision unless set to false. */
  record?: boolean
}

export interface ValidationResult {
  ok: boolean
  errors: string[]
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const SEMVER_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr)
const oneOf = <T extends readonly string[]>(list: T, v: unknown): v is T[number] =>
  typeof v === 'string' && (list as readonly string[]).includes(v)

function checkHeader(m: Obj, errors: string[]): void {
  if (m.specVersion !== SPEC_VERSION) errors.push(`specVersion must be "${SPEC_VERSION}"`)
  if (!isStr(m.name) || !NAME_RE.test(m.name)) errors.push('name must be kebab-case')
  if (!isStr(m.version) || !SEMVER_RE.test(m.version)) errors.push('version must be semver')
}

export function validateOrb(input: unknown): ValidationResult {
  const errors: string[] = []
  if (!isObj(input)) return { ok: false, errors: ['manifest must be an object'] }
  const m = input
  checkHeader(m, errors)
  if (!oneOf(ORB_KINDS, m.kind)) errors.push(`kind must be one of ${ORB_KINDS.join(', ')}`)
  if (!isStr(m.description)) errors.push('description is required')

  if (!isObj(m.access) || !oneOf(APPROVALS, m.access.approval)) {
    errors.push(`access.approval must be one of ${APPROVALS.join(', ')}`)
  } else if (m.access.localOnly !== undefined && typeof m.access.localOnly !== 'boolean') {
    errors.push('access.localOnly must be a boolean')
  }

  if (m.requests !== undefined) {
    if (!isObj(m.requests)) errors.push('requests must be an object')
    else {
      if (m.requests.mcps !== undefined && !isStrArr(m.requests.mcps)) {
        errors.push('requests.mcps must be strings')
      }
      if (m.requests.secrets !== undefined && !isStrArr(m.requests.secrets)) {
        errors.push('requests.secrets must be secret names')
      }
    }
  }

  // Skill and graph Orbs must prove their median; model Orbs are compute.
  if (m.kind === 'skill' || m.kind === 'graph') {
    const h = m.healthcheck
    if (!isObj(h)) errors.push(`${m.kind} Orbs require a healthcheck`)
    else {
      if (!isStr(h.evalSet)) errors.push('healthcheck.evalSet is required')
      if (typeof h.passThreshold !== 'number' || h.passThreshold <= 0 || h.passThreshold > 1) {
        errors.push('healthcheck.passThreshold must be in (0, 1]')
      }
      if (!Number.isInteger(h.minCases) || (h.minCases as number) < 1) {
        errors.push('healthcheck.minCases must be an integer >= 1')
      }
    }
  }

  if (m.kind === 'skill' && (!isObj(m.skill) || !isStr(m.skill.path))) {
    errors.push('skill Orbs require skill.path')
  }

  if (m.kind === 'model') {
    const md = m.model
    if (!isObj(md) || !isStr(md.provider)) errors.push('model Orbs require model.provider')
    if (!isObj(md) || !oneOf(MODEL_RUNTIMES, md.runtime)) errors.push('model.runtime is invalid')
    if (!isObj(md) || !oneOf(DATA_BOUNDARIES, md.dataBoundary)) {
      errors.push('model.dataBoundary is invalid')
    }
  }

  if (m.kind === 'graph') validateGraph(m.graph, errors)

  return { ok: errors.length === 0, errors }
}

function validateGraph(g: unknown, errors: string[]): void {
  if (!isObj(g)) {
    errors.push('graph Orbs require graph')
    return
  }
  const nodes = Array.isArray(g.nodes) ? g.nodes : []
  const edges = Array.isArray(g.edges) ? g.edges : []
  const gates = Array.isArray(g.gates) ? g.gates : []
  if (nodes.length === 0) errors.push('graph.nodes must not be empty')

  const nodeIds = new Set<string>()
  for (const n of nodes) {
    if (!isObj(n) || !isStr(n.id)) {
      errors.push('every node needs an id')
      continue
    }
    if (nodeIds.has(n.id)) errors.push(`duplicate node id "${n.id}"`)
    nodeIds.add(n.id)
    if (!oneOf(NODE_MODES, n.mode)) errors.push(`node "${n.id}" mode is invalid`)
    if (n.mode === 'llm' && !isStr(n.outputSchema)) {
      errors.push(`node "${n.id}" is an llm node and needs outputSchema`)
    }
    if (n.mode !== 'code' && !isStr(n.uses)) errors.push(`node "${n.id}" must name the Orb it uses`)
  }

  const gateIds = new Set<string>()
  for (const gt of gates) {
    if (!isObj(gt) || !isStr(gt.id) || !isStr(gt.path)) errors.push('every gate needs id and path')
    else gateIds.add(gt.id)
  }

  if (!isStr(g.entry) || !nodeIds.has(g.entry)) errors.push('graph.entry must name a node')

  for (const e of edges) {
    if (!isObj(e)) {
      errors.push('every edge must be an object')
      continue
    }
    if (!isStr(e.from) || !nodeIds.has(e.from))
      errors.push(`edge from unknown node "${String(e.from)}"`)
    if (!isStr(e.to) || !nodeIds.has(e.to)) errors.push(`edge to unknown node "${String(e.to)}"`)
    if (!isStr(e.gate) || !gateIds.has(e.gate)) {
      errors.push(`edge ${String(e.from)} -> ${String(e.to)} has no known gate`)
    }
  }
}

export function validateGate(input: unknown): ValidationResult {
  const errors: string[] = []
  if (!isObj(input)) return { ok: false, errors: ['manifest must be an object'] }
  const m = input
  checkHeader(m, errors)
  if (!oneOf(GATE_DECISIONS, m.decision)) {
    errors.push(`decision must be one of ${GATE_DECISIONS.join(', ')}`)
  }
  if (!isStrArr(m.inputs) || m.inputs.length === 0)
    errors.push('inputs must list at least one input')
  if (!isObj(m.enforces) || !isStr(m.enforces.schema)) errors.push('enforces.schema is required')
  if (!oneOf(GATE_ON_FAIL, m.onFail))
    errors.push(`onFail must be one of ${GATE_ON_FAIL.join(', ')}`)
  if (m.onFail === 'retry' && (!Number.isInteger(m.maxRetries) || (m.maxRetries as number) < 1)) {
    errors.push('onFail "retry" requires maxRetries >= 1')
  }
  if (m.decision === 'human' && m.onFail === 'retry') {
    errors.push('a human gate cannot retry; use escalate or reject')
  }
  if (m.record !== undefined && typeof m.record !== 'boolean')
    errors.push('record must be a boolean')
  return { ok: errors.length === 0, errors }
}

/** Data wall: a localOnly skill or graph may run only on a local model Orb. */
export function canRun(work: OrbManifest, model: OrbManifest): boolean {
  if (model.kind !== 'model' || !model.model) return false
  if (work.access.localOnly) return model.model.dataBoundary === 'local'
  return true
}
