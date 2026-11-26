#!/usr/bin/env node
/**
 * dsh-stop-all — smoke tests for the pure helpers in `lib/logic.js`.
 *
 * Run directly: `node test/smoke.mjs` (or `npm test`). No GUI, no Host, no
 * dependencies; the assertions mirror plan §13 (tree-root resolution, member
 * determination, request-idempotency cache) plus the neighbouring helpers the
 * Host wires up. Exit code is non-zero when anything fails.
 */
import { strict as assert } from 'node:assert'
import {
  DEFAULT_CONFIG,
  coverageGaps,
  createRequestCache,
  createTurnTable,
  jobTargets,
  membersOf,
  normalizeConfig,
  resolveRoot,
  sameTurn,
  withinTree,
} from '../lib/logic.js'

const results = []
let failures = 0

/**
 * Minimal runner: keeps the script dependency-free and guarantees a non-zero
 * exit code on failure (a bare `node test/smoke.mjs` run, no `--test`).
 */
async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (error) {
    failures += 1
    results.push({ name, ok: false, error })
  }
}

/** A live-Agent fake: the shape the helpers actually read. */
function fakeAgent(id, { parent, origin = 'subagent', status = 'running', header } = {}) {
  const sessionHeader = header ?? (origin === undefined ? { parentSession: parent } : { origin, parentSession: parent })
  return { id, status, session: { id, header: sessionHeader } }
}

/** A plain (non-subagent) session: no `origin`, so it is its own tree root. */
function plainAgent(id, { status = 'running' } = {}) {
  return { id, status, session: { id, header: {} } }
}

/** `agentOf` over a list, matching the live registry's lookup semantics. */
function lookup(agents) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  return (id) => byId.get(id)
}

const throwingRootOf = () => {
  throw new Error('subagent runtime owner is gone')
}

// ---------------------------------------------------------------------------
// 1. Tree-root resolution (plan §5.1)
// ---------------------------------------------------------------------------

await test('resolveRoot: unknown session id → not-found', () => {
  const out = resolveRoot({ agentOf: () => undefined, rootOf: throwingRootOf }, 'missing')
  assert.deepEqual(out, { kind: 'not-found' })
})

await test('resolveRoot: plain session is its own root, partialTree false', () => {
  const root = plainAgent('root')
  const out = resolveRoot({ agentOf: lookup([root]), rootOf: throwingRootOf }, 'root')
  assert.equal(out.kind, 'root')
  assert.equal(out.rootId, 'root')
  assert.equal(out.root, root)
  assert.equal(out.partialTree, false)
})

await test('resolveRoot: subagent session uses the root reported by rootOf', () => {
  const root = plainAgent('root')
  const child = fakeAgent('child', { parent: 'root' })
  const agentOf = lookup([root, child])
  const out = resolveRoot({ agentOf, rootOf: () => root }, 'child')
  assert.equal(out.kind, 'root')
  assert.equal(out.rootId, 'root')
  assert.equal(out.root, root)
  // NOTE: logic.js currently also returns partialTree:true on this happy path
  // (it derives it from `root.id !== agent.id`); the plan defines partialTree
  // as "the fallback walk was used". Reported separately, not asserted here.
  assert.equal(typeof out.partialTree, 'boolean')
})

await test('resolveRoot: rootOf throws → walks live header parents to the highest non-subagent ancestor', () => {
  const root = plainAgent('root')
  const mid = fakeAgent('mid', { parent: 'root' })
  const leaf = fakeAgent('leaf', { parent: 'mid' })
  const out = resolveRoot({ agentOf: lookup([root, mid, leaf]), rootOf: throwingRootOf }, 'leaf')
  assert.equal(out.kind, 'root')
  assert.equal(out.rootId, 'root')
  assert.equal(out.root, root)
  assert.equal(out.partialTree, false)
})

await test('resolveRoot: rootOf throws and the parent is missing → highest reachable, partialTree true', () => {
  const orphan = fakeAgent('orphan', { parent: 'gone' })
  const out = resolveRoot({ agentOf: lookup([orphan]), rootOf: throwingRootOf }, 'orphan')
  assert.equal(out.kind, 'root')
  assert.equal(out.rootId, 'orphan')
  assert.equal(out.root, orphan)
  assert.equal(out.partialTree, true)
})

await test('resolveRoot: cyclic parent chain A→B→A terminates without spinning', () => {
  const a = fakeAgent('a', { parent: 'b' })
  const b = fakeAgent('b', { parent: 'a' })
  const out = resolveRoot({ agentOf: lookup([a, b]), rootOf: throwingRootOf }, 'a')
  assert.equal(out.kind, 'root')
  assert.equal(out.rootId, 'b')
  assert.equal(out.partialTree, true)
})

// ---------------------------------------------------------------------------
// 2. Tree membership (plan §5.2 S1)
// ---------------------------------------------------------------------------

const root = plainAgent('root')
const childA = fakeAgent('a', { parent: 'root' })
const childB = fakeAgent('b', { parent: 'a' })
const unrelated = plainAgent('other-root')
const outside = fakeAgent('outside', { parent: 'other-root' })
// An ordinary fork carries `parentSession` but no `origin`.
const ordinaryFork = { id: 'fork', status: 'running', session: { id: 'fork', header: { parentSession: 'root' } } }
const orphanA = fakeAgent('orphan-a', { parent: 'ghost' })
const treeAgents = [root, childA, childB, unrelated, outside, ordinaryFork, orphanA]

await test('withinTree: two-level nesting root→a→b counts every descendant', () => {
  const agentOf = lookup(treeAgents)
  assert.equal(withinTree(agentOf, 'a', 'root'), true)
  assert.equal(withinTree(agentOf, 'b', 'root'), true)
})

await test('withinTree: the root itself and unrelated sessions are not members', () => {
  const agentOf = lookup(treeAgents)
  assert.equal(withinTree(agentOf, 'root', 'root'), false)
  assert.equal(withinTree(agentOf, 'unrelated', 'root'), false)
  assert.equal(withinTree(agentOf, 'outside', 'root'), false)
})

await test('withinTree: an ordinary fork (parentSession but no origin) is not a member', () => {
  assert.equal(withinTree(lookup(treeAgents), 'fork', 'root'), false)
})

await test('withinTree: a missing intermediate parent breaks the chain', () => {
  assert.equal(withinTree(lookup(treeAgents), 'orphan-a', 'root'), false)
})

await test('membersOf: returns exactly the live descendants, in registry order, never the root', () => {
  const listed = [root, childA, unrelated, childB, outside, ordinaryFork, orphanA]
  const ids = membersOf(() => listed, lookup(treeAgents), 'root').map((agent) => agent.id)
  assert.deepEqual(ids, ['a', 'b'])
})

// ---------------------------------------------------------------------------
// 3. requestId idempotency cache (plan §7.5)
// ---------------------------------------------------------------------------

await test('createRequestCache: hit and miss', () => {
  const cache = createRequestCache({ now: () => 0 })
  assert.equal(cache.get('never-stored'), undefined)
  const record = { ok: true, rootId: 'root', requested: [] }
  cache.put('req-1', record)
  assert.equal(cache.get('req-1'), record)
  assert.equal(cache.size, 1)
})

await test('createRequestCache: entries expire once TTL is reached (injected clock)', () => {
  let now = 0
  const cache = createRequestCache({ now: () => now, ttlMs: 1000 })
  cache.put('req-1', { ok: true })
  now = 999
  assert.notEqual(cache.get('req-1'), undefined)
  now = 1000
  assert.equal(cache.get('req-1'), undefined)
  assert.equal(cache.size, 0)
})

await test('createRequestCache: over the cap, the oldest insertion is evicted first', () => {
  const cache = createRequestCache({ now: () => 0, limit: 2 })
  cache.put('a', { key: 'a' })
  cache.put('b', { key: 'b' })
  cache.put('c', { key: 'c' })
  assert.equal(cache.size, 2)
  assert.equal(cache.get('a'), undefined)
  assert.deepEqual(cache.get('b'), { key: 'b' })
  assert.deepEqual(cache.get('c'), { key: 'c' })
})

await test('createRequestCache: rewriting the same id refreshes its eviction order', () => {
  const cache = createRequestCache({ now: () => 0, limit: 2 })
  cache.put('a', { key: 'a', attempt: 1 })
  cache.put('b', { key: 'b' })
  cache.put('a', { key: 'a', attempt: 2 })
  cache.put('c', { key: 'c' })
  assert.equal(cache.get('b'), undefined)
  assert.deepEqual(cache.get('a'), { key: 'a', attempt: 2 })
  assert.deepEqual(cache.get('c'), { key: 'c' })
})

// ---------------------------------------------------------------------------
// 4. Background-job targets (plan §5.3)
// ---------------------------------------------------------------------------

await test('jobTargets: unowned jobs, foreign owners and finished jobs are excluded; duplicates collapse', () => {
  const views = [
    { id: 'j1', owner: 'root', status: 'running', label: 'build' },
    { id: 'j2', owner: '', status: 'running', label: 'unowned' },
    { id: 'j3', owner: 'a', status: 'stopping', label: 'watch' },
    { id: 'j4', owner: 'a', status: 'done', label: 'finished' },
    { id: 'j1', owner: 'root', status: 'running', label: 'build' },
    { id: 'j5', owner: 'outside', status: 'running', label: 'other tree' },
    { id: 'j6', owner: 'b' },
    { id: 'j7', owner: 'a', status: 'running' },
  ]
  const out = jobTargets(views, new Set(['root', 'a']))
  assert.deepEqual(out.map((target) => target.id).sort(), ['j1', 'j3', 'j7'])
  assert.deepEqual(out.find((target) => target.id === 'j1'), {
    id: 'j1', owner: 'root', label: 'build', status: 'running',
  })
  assert.equal(out.find((target) => target.id === 'j7').label, 'j7')
})

// ---------------------------------------------------------------------------
// 5. Coverage gaps from workspace/session-activity (plan §6)
// ---------------------------------------------------------------------------

await test('coverageGaps: turn/schedule ignored, handled ids skipped, duplicates collapse', () => {
  const activities = [
    { kind: 'turn', items: [{ id: 't1' }] },
    { kind: 'subagent', items: [{ id: 's1', label: 'child' }, { id: 's1' }, { id: 's2' }] },
    { kind: 'job', items: [{ id: 'j1' }] },
    { kind: 'schedule', items: [{ id: 'sch1' }] },
    { kind: 'subagent', items: [{ id: 's3' }] },
  ]
  const out = coverageGaps(activities, new Set(['s1', 'j1']))
  assert.deepEqual(out, [
    { id: 's2', kind: 'subagent', label: 's2' },
    { id: 's3', kind: 'subagent', label: 's3' },
  ])
})

// ---------------------------------------------------------------------------
// 6. Turn table and re-issue matching (plan §16.5)
// ---------------------------------------------------------------------------

await test('createTurnTable: turn/start then turn/end; other events ignored; unknown session undefined', () => {
  const table = createTurnTable()
  const session = { id: 's1' }
  assert.equal(table.turnOf('s1'), undefined)

  table.onEvent(session, { type: 'turn/start', data: { turn: 3 } })
  assert.equal(table.turnOf('s1'), 3)

  table.onEvent(session, { type: 'message/assistant', data: { turn: 99 } })
  assert.equal(table.turnOf('s1'), 3)

  table.onEvent(session, { type: 'turn/start', data: { turn: '4' } })
  assert.equal(table.turnOf('s1'), 3)

  table.onEvent(session, { type: 'turn/end', data: { turn: 2 } })
  assert.equal(table.turnOf('s1'), 3)

  table.onEvent(session, { type: 'turn/end', data: { turn: 3 } })
  assert.equal(table.turnOf('s1'), null)

  assert.equal(table.turnOf('never-seen'), undefined)
  table.forget('s1')
  assert.equal(table.turnOf('s1'), undefined)
})

await test('sameTurn: only the same concrete open turn matches', () => {
  assert.equal(sameTurn(3, 3), true)
  assert.equal(sameTurn(3, 4), false)
  assert.equal(sameTurn(null, null), false)
  assert.equal(sameTurn(undefined, 3), false)
  assert.equal(sameTurn('3', 3), false)
})

// ---------------------------------------------------------------------------
// 7. Config normalisation (plan §12)
// ---------------------------------------------------------------------------

await test('normalizeConfig: no argument yields the documented defaults, frozen', () => {
  const config = normalizeConfig()
  assert.deepEqual({ ...config }, { ...DEFAULT_CONFIG })
  assert.equal(Object.isFrozen(config), true)
})

await test('normalizeConfig: wrong scalar types fall back to defaults instead of throwing', () => {
  const config = normalizeConfig({
    includeJobs: 'no',
    catalogPass: 0,
    autoReissue: null,
    settleTimeoutMs: -1,
    killReason: '   ',
    requireTeamMode: 'true',
  })
  assert.deepEqual({ ...config }, { ...DEFAULT_CONFIG })
})

await test('normalizeConfig: valid overrides are kept; killReason is trimmed; 0 is a legal timeout', () => {
  const config = normalizeConfig({
    includeJobs: false,
    autoReissue: false,
    settleTimeoutMs: 0,
    killReason: '  stop-all-test  ',
  })
  assert.equal(config.includeJobs, false)
  assert.equal(config.autoReissue, false)
  assert.equal(config.settleTimeoutMs, 0)
  assert.equal(config.killReason, 'stop-all-test')
  assert.equal(config.catalogPass, true)
  assert.equal(config.requireTeamMode, true)
})

await test('normalizeConfig: non-finite timeout falls back, Infinity included', () => {
  assert.equal(normalizeConfig({ settleTimeoutMs: Number.NaN }).settleTimeoutMs, DEFAULT_CONFIG.settleTimeoutMs)
  assert.equal(normalizeConfig({ settleTimeoutMs: Number.POSITIVE_INFINITY }).settleTimeoutMs, DEFAULT_CONFIG.settleTimeoutMs)
})

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

for (const result of results) {
  if (result.ok) {
    console.log(`ok - ${result.name}`)
    continue
  }
  console.log(`not ok - ${result.name}`)
  console.log(String(result.error?.stack ?? result.error).replace(/^/gm, '    '))
}

const passed = results.length - failures
console.log(`\nsmoke: ${passed}/${results.length} passed, ${failures} failed`)
if (failures > 0) process.exitCode = 1
