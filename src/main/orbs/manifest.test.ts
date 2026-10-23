import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  APPROVALS,
  DATA_BOUNDARIES,
  GATE_DECISIONS,
  GATE_ON_FAIL,
  MODEL_RUNTIMES,
  NODE_MODES,
  ORB_KINDS,
  REL_PATH_RE,
  SEMVER_RE,
  canRun,
  validateGate,
  validateOrb,
  type OrbManifest
} from './manifest'

const DOCS = join(__dirname, '..', '..', '..', 'docs', 'orbs')
const EXAMPLES = join(DOCS, 'examples')
const load = (...p: string[]): Record<string, unknown> =>
  JSON.parse(readFileSync(join(...p), 'utf-8')) as Record<string, unknown>
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

describe('Orb examples', () => {
  for (const dir of readdirSync(EXAMPLES)) {
    it(`${dir}/orb.json is valid`, () => {
      const res = validateOrb(load(EXAMPLES, dir, 'orb.json'))
      expect(res.errors).toEqual([])
    })
  }

  it('every gate a graph references exists and is valid', () => {
    const dir = join(EXAMPLES, 'doc-digest')
    const orb = load(dir, 'orb.json') as unknown as OrbManifest
    for (const g of orb.graph?.gates ?? []) {
      const gate = load(dir, g.path)
      expect(validateGate(gate).errors).toEqual([])
      expect(gate.name).toBe(g.id)
    }
  })
})

describe('validateOrb rejects', () => {
  const skill = load(EXAMPLES, 'pdf-to-markdown', 'orb.json')
  const graph = load(EXAMPLES, 'doc-digest', 'orb.json')

  it('a skill Orb with no healthcheck', () => {
    const m = clone(skill)
    delete m.healthcheck
    expect(validateOrb(m).errors).toContain('skill Orbs require a healthcheck')
  })

  it('a non-kebab name and a non-semver version', () => {
    const m = { ...clone(skill), name: 'PDF To Markdown', version: 'v1' }
    expect(validateOrb(m).errors).toEqual(
      expect.arrayContaining(['name must be kebab-case', 'version must be semver'])
    )
  })

  it('an edge that skips the gate', () => {
    const m = clone(graph) as unknown as OrbManifest
    m.graph!.edges[0].gate = 'missing'
    expect(validateOrb(m).ok).toBe(false)
  })

  it('an llm node with no output schema', () => {
    const m = clone(graph) as unknown as OrbManifest
    const node = m.graph!.nodes.find((n) => n.mode === 'llm')!
    delete node.outputSchema
    expect(validateOrb(m).errors.join(' ')).toContain('needs outputSchema')
  })

  it('a secret given as a value object instead of a name', () => {
    const m = clone(skill)
    m.requests = { secrets: [{ value: 'sk-123' }] }
    expect(validateOrb(m).errors).toContain('requests.secrets must be secret names')
  })
})

describe('validateGate rejects', () => {
  const gate = load(EXAMPLES, 'doc-digest', 'gates', 'markdown-shape.gate.json')

  it('retry with no maxRetries', () => {
    const m = clone(gate)
    delete m.maxRetries
    expect(validateGate(m).errors).toContain('onFail "retry" requires maxRetries >= 1')
  })

  it('a human gate that retries', () => {
    const m = { ...clone(gate), decision: 'human' }
    expect(validateGate(m).errors).toContain('a human gate cannot retry; use escalate or reject')
  })
})

describe('canRun data wall', () => {
  const skill = load(EXAMPLES, 'pdf-to-markdown', 'orb.json') as unknown as OrbManifest
  const local = load(EXAMPLES, 'local-model', 'orb.json') as unknown as OrbManifest
  const vendor = clone(local)
  vendor.model!.dataBoundary = 'vendor'

  it('lets localOnly work run on a local model Orb', () => {
    expect(canRun(skill, local)).toBe(true)
  })

  it('blocks localOnly work from a vendor model Orb', () => {
    expect(canRun(skill, vendor)).toBe(false)
  })

  it('refuses a non-model Orb as compute', () => {
    expect(canRun(skill, skill)).toBe(false)
  })
})

describe('JSON Schemas match the TypeScript enums', () => {
  const orbSchema = load(DOCS, 'schema', 'orb.schema.json') as any
  const gateSchema = load(DOCS, 'schema', 'gate.schema.json') as any

  it('orb.schema.json', () => {
    expect(orbSchema.properties.kind.enum).toEqual([...ORB_KINDS])
    expect(orbSchema.properties.access.properties.approval.enum).toEqual([...APPROVALS])
    expect(orbSchema.properties.model.properties.runtime.enum).toEqual([...MODEL_RUNTIMES])
    expect(orbSchema.properties.model.properties.dataBoundary.enum).toEqual([...DATA_BOUNDARIES])
    expect(orbSchema.properties.graph.properties.nodes.items.properties.mode.enum).toEqual([
      ...NODE_MODES
    ])
  })

  it('gate.schema.json', () => {
    expect(gateSchema.properties.decision.enum).toEqual([...GATE_DECISIONS])
    expect(gateSchema.properties.onFail.enum).toEqual([...GATE_ON_FAIL])
  })
})

describe('review fixes (PR #68)', () => {
  const skill = load(EXAMPLES, 'pdf-to-markdown', 'orb.json')
  const graph = load(EXAMPLES, 'doc-digest', 'orb.json')
  const model = load(EXAMPLES, 'local-model', 'orb.json')
  const gate = load(EXAMPLES, 'doc-digest', 'gates', 'markdown-shape.gate.json')

  it('rejects a graph whose edges or gates are not arrays', () => {
    const m = clone(graph) as any
    m.graph.edges = 'invalid'
    m.graph.gates = {}
    expect(validateOrb(m).errors).toEqual(
      expect.arrayContaining(['graph.edges must be an array', 'graph.gates must be an array'])
    )
  })

  it('rejects malformed optional fields', () => {
    expect(validateOrb({ ...clone(model), healthcheck: 'broken' }).ok).toBe(false)
    expect(validateOrb({ ...clone(skill), ui: { globe: 'yes' } }).errors).toContain(
      'ui.globe must be a boolean'
    )
    const g = clone(graph) as any
    g.graph.nodes[0].uses = 42
    expect(validateOrb(g).errors.join(' ')).toContain('uses must be a string')
    const gt = { ...clone(gate), onFail: 'reject', maxRetries: 'forever' }
    expect(validateGate(gt).errors).toContain('maxRetries must be an integer >= 1')
  })

  it('follows semver.org exactly', () => {
    for (const ok of ['1.0.0', '1.0.0+build.1', '1.0.0-alpha.1', '0.1.0']) {
      expect(SEMVER_RE.test(ok)).toBe(true)
    }
    for (const bad of ['01.0.0', '1.0.0-01', '1.0.0-a..b', 'v1.0.0', '1.0']) {
      expect(SEMVER_RE.test(bad)).toBe(false)
    }
  })

  it('keeps models and skills apart', () => {
    const m = { ...clone(skill), model: clone(model).model }
    expect(validateOrb(m).errors).toContain('skill Orbs must not declare "model"')
  })

  it('requires Orb-relative paths', () => {
    for (const bad of [
      '/tmp/cases.jsonl',
      '~/cases.jsonl',
      '../cases.jsonl',
      'a/../../b',
      'C:/x'
    ]) {
      expect(REL_PATH_RE.test(bad)).toBe(false)
      const m = clone(skill) as any
      m.healthcheck.evalSet = bad
      expect(validateOrb(m).ok).toBe(false)
    }
    for (const ok of ['evals/cases.jsonl', 'SKILL.md', 'a/..b/c']) {
      expect(REL_PATH_RE.test(ok)).toBe(true)
    }
    const g = clone(graph) as any
    g.graph.gates[0].path = ''
    expect(validateOrb(g).ok).toBe(false)
  })

  it('JSON Schemas use the same semver and path patterns', () => {
    const orbSchema = load(DOCS, 'schema', 'orb.schema.json') as any
    const gateSchema = load(DOCS, 'schema', 'gate.schema.json') as any
    expect(orbSchema.properties.version.pattern).toBe(SEMVER_RE.source)
    expect(gateSchema.properties.version.pattern).toBe(SEMVER_RE.source)
    expect(orbSchema.properties.healthcheck.properties.evalSet.pattern).toBe(REL_PATH_RE.source)
    expect(gateSchema.properties.enforces.properties.schema.pattern).toBe(REL_PATH_RE.source)
  })
})
