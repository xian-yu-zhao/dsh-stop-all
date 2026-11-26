/**
 * Host integration check — no GUI, no DSH runtime, no network.
 *
 * Builds a fake Cordis context carrying the four Host services the plugin reads
 * (`agents`, `subagents`, `jobs`, `agentTeams`) and calls the published
 * `stopAll` service exactly the way the Gateway would. This is the test that
 * catches contract drift in the Host half: the exact native root cancel, the
 * user-authorised subagent interrupt, job ownership filtering, the catalog
 * fallback, coverage verification, the request-idempotency cache, and the error
 * codes.
 *
 * Run with `node test/integration.mjs` (part of `npm run verify`).
 */
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const ROOT = 'session-root'
const CHILD_A = 'session-child-a'
const CHILD_B = 'session-child-b'
const GRAND = 'session-grand'
const STRANGER = 'session-stranger'

const calls = []
let lateRunning = true
let lateChildSpawned = false

function makeAgent(id, header) {
  return {
    id,
    status: 'running',
    session: { id, header },
    cancel(cause, options) {
      calls.push({ kind: 'cancel', id, cause, options })
      this.status = 'idle'
    },
  }
}

const agents = new Map([
  [ROOT, makeAgent(ROOT, { id: ROOT })],
  [CHILD_A, makeAgent(CHILD_A, { id: CHILD_A, origin: 'subagent', parentSession: ROOT })],
  [CHILD_B, makeAgent(CHILD_B, { id: CHILD_B, origin: 'subagent', parentSession: ROOT })],
  [GRAND, makeAgent(GRAND, { id: GRAND, origin: 'subagent', parentSession: CHILD_A })],
  [STRANGER, makeAgent(STRANGER, { id: STRANGER })],
])

const jobsByOwner = new Map([
  [ROOT, [{ id: 'job-root', owner: ROOT, status: 'running', label: 'root job' }]],
  [CHILD_A, [{ id: 'job-a', owner: CHILD_A, status: 'stopping', label: 'a job' }]],
  [STRANGER, [{ id: 'job-stranger', owner: STRANGER, status: 'running', label: 'stranger job' }]],
])
const unownedJobs = [{ id: 'job-unowned', owner: undefined, status: 'running', label: 'unowned' }]

const listeners = new Map()
const services = new Map()

services.set('agents', { get: id => agents.get(id), list: () => [...agents.values()] })
services.set('subagents', {
  rootOf(caller) {
    let cursor = caller
    for (let hops = 0; hops < 8; hops++) {
      const header = cursor.session.header
      if (header.origin !== 'subagent') return cursor
      const parent = agents.get(header.parentSession)
      if (parent === undefined) throw new Error('runtime owner unavailable')
      cursor = parent
    }
    throw new Error('cyclic ancestry')
  },
  interrupt(id, authority) {
    calls.push({ kind: 'interrupt', id, authority })
    const member = agents.get(id)
    if (member !== undefined) member.status = 'idle'
    if (id === 'late-child') lateRunning = false
  },
  async listDescendants() {
    return [
      { kind: 'child', id: CHILD_A, parentId: ROOT, depth: 1, hasChildren: true, mode: 'continuable' },
      { kind: 'child', id: GRAND, parentId: CHILD_A, depth: 2, hasChildren: false, mode: 'continuable' },
      { kind: 'child', id: 'external-child', parentId: CHILD_B, depth: 2, hasChildren: false, mode: 'external' },
      // A settled historical child: the catalog pass must not ask it.
      { kind: 'child', id: 'old-one-shot', parentId: ROOT, depth: 1, hasChildren: false, mode: 'one-shot' },
      { kind: 'diagnostic', id: 'broken', parentId: CHILD_B, depth: 2, reason: 'corrupt' },
    ]
  },
  namesOf: member => ({ name: `name:${member.id}` }),
})
services.set('jobs', {
  list(caller) {
    return [...(jobsByOwner.get(caller) ?? []), ...unownedJobs]
  },
  kill(id, owner, reason) {
    calls.push({ kind: 'kill', id, owner, reason })
    for (const rows of jobsByOwner.values()) {
      for (const row of rows) if (row.id === id) row.status = 'killed'
    }
    return 'requested'
  },
})
services.set('agentTeams', { isEnabled: () => true })

const ctx = {
  get: key => services.get(key),
  provide: (key, value) => { services.set(key, value) },
  on: (event, listener) => { listeners.set(event, listener) },
  logger: { info() {}, warn() {}, debug() {} },
  // The real provider answers with the running descendants of the asked session;
  // `late-child` models a child that appears between the passes.
  async waterfall(_event, request) {
    if (request.sessionId === CHILD_B && lateRunning) {
      lateChildSpawned = true
      return [{ kind: 'subagent', items: [{ id: 'late-child', label: 'late' }] }]
    }
    return []
  },
}

apply(ctx, {})
const svc = services.get('stopAll')
const emit = (session, event) => listeners.get('session/event')(session, event)

/* ---- publication ---------------------------------------------------- */
assert.ok(svc !== undefined, 'the stopAll service is published')
assert.equal(services.get('stopAll'), svc, 'ctx.get resolves the exact instance')
const binding = Object.getOwnPropertyDescriptor(svc, 'typertRemote').value
assert.equal(binding.service, svc)
assert.equal(binding.serviceKey, 'stopAll')
assert.equal(binding.namespace, 'stopAll')
const markers = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(svc), '@deepseek-ai/dsh-typert-protocol/remote-methods',
).value
assert.equal(markers.version, 1)
assert.deepEqual(markers.methods.map(method => method.method), ['status', 'stop'])
for (const marker of markers.methods) {
  assert.equal(marker.invocation.kind, 'direct')
  assert.deepEqual(Object.keys(marker.resources), ['session'])
  assert.equal(marker.resources.session({ sessionId: 'x' }), 'x')
}

/* ---- turn table ----------------------------------------------------- */
emit({ id: ROOT }, { type: 'turn/start', data: { turn: 7 } })
emit({ id: CHILD_A }, { type: 'turn/start', data: { turn: 3 } })
emit({ id: CHILD_B }, { type: 'turn/start', data: { turn: 2 } })
emit({ id: GRAND }, { type: 'turn/start', data: { turn: 1 } })

/* ---- status --------------------------------------------------------- */
const status = svc.status({ sessionId: ROOT })
assert.equal(status.rootId, ROOT)
assert.equal(status.isRootPage, true)
assert.equal(status.active, true)
assert.equal(status.teamMode, true)
assert.equal(status.visible, true)
assert.equal(status.partialTree, false)
assert.equal(status.root.turn, 7)
assert.deepEqual(status.descendants.map(row => row.id).sort(), [CHILD_A, CHILD_B, GRAND].sort())
assert.equal(status.descendants.find(row => row.id === CHILD_A).turn, 3)
assert.ok(status.jobs.some(row => row.id === 'job-a' && row.status === 'stopping'))
assert.ok(!status.jobs.some(row => row.id === 'job-stranger'), 'foreign job excluded')
assert.ok(!status.jobs.some(row => row.id === 'job-unowned'), 'unowned job excluded')
assert.equal(status.config.settleTimeoutMs, 8000)
assert.equal(status.config.autoReissue, true)

const subagentPage = svc.status({ sessionId: CHILD_A })
assert.equal(subagentPage.rootId, ROOT)
assert.equal(subagentPage.isRootPage, false)
assert.equal(subagentPage.partialTree, false, 'an authoritative rootOf answer is not a partial tree')

services.set('agentTeams', { isEnabled: () => false })
const gateOff = svc.status({ sessionId: ROOT })
assert.equal(gateOff.teamMode, false)
assert.equal(gateOff.visible, false, 'requireTeamMode hides the button')
services.set('agentTeams', { isEnabled: () => true })

assert.throws(() => svc.status({ sessionId: 'session-missing' }), error => error.code === 'stop-all/not-found')
assert.throws(() => svc.status({}), error => error.code === 'gateway/bad-request')

/* ---- stop ----------------------------------------------------------- */
const result = await svc.stop({ sessionId: ROOT, requestId: 'req-00000001' })
assert.equal(result.ok, true)
assert.equal(result.rootId, ROOT)
assert.equal(result.killedJobs, 2)
assert.equal(result.partialTree, false)

const rootCancel = calls.filter(call => call.kind === 'cancel' && call.id === ROOT)
assert.equal(rootCancel.length, 1, 'the root is cancelled exactly once')
assert.deepEqual(rootCancel[0].cause, { kind: 'user' })
assert.deepEqual(rootCancel[0].options, { keepInbox: true }, 'queued input is kept')
const interrupted = [...new Set(calls.filter(call => call.kind === 'interrupt').map(call => call.id))].sort()
assert.deepEqual(interrupted, [CHILD_A, CHILD_B, GRAND, 'external-child', 'late-child'].sort())
const kills = calls.filter(call => call.kind === 'kill')
assert.deepEqual(kills.map(call => call.id).sort(), ['job-a', 'job-root'])
assert.ok(kills.every(call => call.reason === 'stop-all'))
assert.ok(result.requested.some(row => row.id === 'external-child' && row.kind === 'subagent'), 'catalog-only child requested')
assert.ok(lateChildSpawned)
assert.ok(result.reissued.some(gap => gap.id === 'late-child'), 'the late child is re-issued by the coverage pass')
assert.deepEqual(result.coverageGaps, [], 'a re-issued gap is not reported as unresolved')
assert.deepEqual(result.degraded, [])

/* ---- idempotency ---------------------------------------------------- */
const before = calls.length
const replay = await svc.stop({ sessionId: ROOT, requestId: 'req-00000001' })
assert.deepEqual(replay, result, 'a replay returns the cached result')
assert.equal(calls.length, before, 'a replay issues nothing')
await assert.rejects(
  () => svc.stop({ sessionId: CHILD_A, requestId: 'req-00000001' }),
  error => error.code === 'gateway/bad-request',
)
await assert.rejects(
  () => svc.stop({ sessionId: ROOT, requestId: 'short' }),
  error => error.code === 'gateway/bad-request',
)
await assert.rejects(
  () => svc.stop({ sessionId: 'session-missing', requestId: 'req-00000002' }),
  error => error.code === 'stop-all/not-found',
)

/* ---- a quiet tree requests nothing --------------------------------- */
lateRunning = false
for (const member of agents.values()) member.status = 'idle'
for (const rows of jobsByOwner.values()) for (const row of rows) row.status = 'killed'
const quietBefore = calls.length
const idle = await svc.stop({ sessionId: ROOT, requestId: 'req-00000003' })
assert.equal(idle.ok, true)
assert.deepEqual(idle.requested, [], 'a re-click on a quiet tree requests nothing')
assert.equal(calls.length, quietBefore)

/* ---- retryOf only re-issues the same open turn ---------------------- */
const retried = []
const retryAgent = makeAgent('session-retry', { id: 'session-retry' })
retryAgent.cancel = function cancel(cause, options) { retried.push({ cause, options }); this.status = 'idle' }
agents.set('session-retry', retryAgent)
emit({ id: 'session-retry' }, { type: 'turn/start', data: { turn: 11 } })
svc.cache.put('req-retry-0001', {
  sessionId: 'session-retry',
  result: { ok: true },
  plan: [{ id: 'session-retry', kind: 'turn', label: 'session-retry', turn: 11 }],
})
const reissued = await svc.stop({ sessionId: 'session-retry', requestId: 'req-retry-0002', retryOf: 'req-retry-0001' })
assert.equal(reissued.requested.length, 1)
assert.equal(retried.length, 1)
emit({ id: 'session-retry' }, { type: 'turn/end', data: { turn: 11 } })
emit({ id: 'session-retry' }, { type: 'turn/start', data: { turn: 12 } })
retried.length = 0
const newWork = await svc.stop({ sessionId: 'session-retry', requestId: 'req-retry-0003', retryOf: 'req-retry-0001' })
assert.deepEqual(newWork.requested, [], 'a new turn after the stop is not re-issued')
assert.equal(retried.length, 0)

/* ---- disposal cleanup ---------------------------------------------- */
const sizeBefore = svc.turns.size
listeners.get('session/disposed')({ id: GRAND })
assert.equal(svc.turns.size, sizeBefore - 1)

console.log('integration: all checks passed')
