/**
 * dsh-stop-all — pure helpers.
 *
 * Everything here is dependency-free and side-effect-free on purpose: the Host
 * half wires them to live Cordis services, and `test/smoke.mjs` exercises the
 * same functions against fakes (tree resolution, member determination, and the
 * request-idempotency cache are covered without a GUI or a Host).
 *
 * Vocabulary used below:
 *   - root      the conversation tree root (a live Agent whose Session is not a
 *               subagent session, or the delegated owner found through the
 *               subagent runtime);
 *   - member    any live Agent inside that tree, at any depth (strictly below
 *               the root);
 *   - turn id   the number the session log carries on `turn/start`, used to
 *               tell "the same turn is still running" from "someone started new
 *               work after the stop".
 */

/** The config defaults documented in README/cordis.patch.yml. */
export const DEFAULT_CONFIG = Object.freeze({
  includeJobs: true,
  catalogPass: true,
  autoReissue: true,
  settleTimeoutMs: 8000,
  killReason: 'stop-all',
  requireTeamMode: true,
})

/** Upper bound for any header-parent walk, so a corrupt chain cannot spin. */
const MAX_WALK = 256

/** A request-cache entry older than this is expired. */
const REQUEST_TTL_MS = 60_000
/** Hard cap on cached requests; the oldest entries fall out first. */
const REQUEST_LIMIT = 200
/** How many automatic re-issues one stop may perform (per the plan, max 2). */
export const MAX_REISSUES = 2

/**
 * Merge a raw patch config with {@link DEFAULT_CONFIG}.
 * Unknown keys are dropped; wrong scalar types fall back to the default so a
 * typo in a patch file degrades to documented behaviour instead of throwing.
 * @param raw - the `config` object a patch row carries, if any.
 * @returns a frozen, fully populated config.
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  const bool = (key) => (typeof source[key] === 'boolean' ? source[key] : DEFAULT_CONFIG[key])
  const num = (key, min) => {
    const value = source[key]
    return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : DEFAULT_CONFIG[key]
  }
  const reason = typeof source.killReason === 'string' && source.killReason.trim() !== ''
    ? source.killReason.trim()
    : DEFAULT_CONFIG.killReason
  return Object.freeze({
    includeJobs: bool('includeJobs'),
    catalogPass: bool('catalogPass'),
    autoReissue: bool('autoReissue'),
    settleTimeoutMs: num('settleTimeoutMs', 0),
    killReason: reason,
    requireTeamMode: bool('requireTeamMode'),
  })
}

/**
 * Whether a session was created as a subagent child (the only case in which its
 * header-parent chain belongs to a subagent tree; ordinary forks omit `origin`).
 * @param session - a live Session (or a header-bearing fake).
 * @returns true for a subagent session.
 */
export function isSubagentSession(session) {
  return session?.header?.origin === 'subagent'
}

/**
 * The direct creator a subagent Session's header records.
 * @param session - a live Session (or a fake).
 * @returns the parent session id, or undefined.
 */
export function parentIdOf(session) {
  const parent = session?.header?.parentSession
  return typeof parent === 'string' && parent !== '' ? parent : undefined
}

/**
 * Whether one live Agent hangs strictly below `rootId`, following header parents.
 * The chain is trusted only while every hop is a live subagent session; the walk
 * stops at a non-subagent session (a root) or at a missing parent.
 * @param agentOf - `(id) => Agent | undefined` over the live registry.
 * @param id - candidate member id.
 * @param rootId - tree root id.
 * @returns true when the header chain reaches the root.
 */
export function withinTree(agentOf, id, rootId) {
  if (typeof id !== 'string' || id === rootId) return false
  const seen = new Set()
  let cursor = id
  for (let hops = 0; hops < MAX_WALK; hops++) {
    if (cursor === rootId) return true
    if (seen.has(cursor)) return false
    seen.add(cursor)
    const agent = agentOf(cursor)
    if (agent === undefined || !isSubagentSession(agent.session)) return false
    const parent = parentIdOf(agent.session)
    if (parent === undefined) return false
    cursor = parent
  }
  return false
}

/**
 * Resolve the authoritative tree root for the session a user is looking at.
 *
 * Order (plan §5.1): the live Agent must exist; a non-subagent session is its own
 * root; otherwise the subagent runtime answers `rootOf`. When that throws — the
 * runtime owner is gone, e.g. a root that was archived mid-life — the header-
 * parent chain is walked through live parents only, and the highest reachable
 * ancestor becomes the root with `partialTree` set unless the walk proved a
 * complete non-subagent root.
 * @param deps.agentOf - `(id) => Agent | undefined`.
 * @param deps.rootOf - `(agent) => Agent`, the subagent runtime's `rootOf`.
 * @param sessionId - the session being stopped.
 * @returns `{ kind: 'not-found' }` or `{ kind: 'root', rootId, root, partialTree }`.
 */
export function resolveRoot(deps, sessionId) {
  const agent = deps.agentOf(sessionId)
  if (agent === undefined) return { kind: 'not-found' }
  if (!isSubagentSession(agent.session)) return { kind: 'root', rootId: agent.id, root: agent, partialTree: false }
  try {
    const root = deps.rootOf(agent)
    if (root !== undefined && typeof root.id === 'string') {
      // The runtime answered authoritatively, so the tree is complete even when
      // this page is a descendant of it.
      return { kind: 'root', rootId: root.id, root, partialTree: false }
    }
  } catch {
    // Fall through to the header chain: an unavailable runtime owner is exactly
    // the case the fallback exists for.
  }
  const seen = new Set([agent.id])
  let highest = agent
  let proved = false
  let cursor = agent
  for (let hops = 0; hops < MAX_WALK; hops++) {
    const parentId = parentIdOf(cursor.session)
    if (parentId === undefined) break
    const next = deps.agentOf(parentId)
    if (next === undefined || seen.has(next.id)) break
    seen.add(next.id)
    highest = next
    cursor = next
    if (!isSubagentSession(next.session)) {
      proved = true
      break
    }
  }
  return { kind: 'root', rootId: highest.id, root: highest, partialTree: !proved }
}

/**
 * Every live Agent strictly inside one tree (plan §5.2 S1).
 * @param listAgents - `() => Agent[]` over the live registry.
 * @param agentOf - `(id) => Agent | undefined`.
 * @param rootId - tree root id.
 * @returns agents in registry order; the root itself is never included.
 */
export function membersOf(listAgents, agentOf, rootId) {
  const out = []
  for (const agent of listAgents()) {
    if (agent === undefined || typeof agent.id !== 'string') continue
    if (agent.id === rootId) continue
    if (!withinTree(agentOf, agent.id, rootId)) continue
    out.push(agent)
  }
  return out
}

/**
 * Whether an Agent is currently executing (a turn or a between-turn task).
 * @param agent - a live Agent.
 * @returns true for `running`.
 */
export function isRunning(agent) {
  return agent?.status === 'running'
}

/**
 * Select the background jobs a stop should kill (plan §5.3).
 * `jobs.list(caller)` also returns unowned jobs, so an owner-less job is never a
 * target: it cannot be attributed to any conversation tree.
 * @param views - JobView rows (any mix of owners).
 * @param memberIds - ids of the tree's members, including the root.
 * @returns deduplicated `{ id, owner, label, status }` targets.
 */
export function jobTargets(views, memberIds) {
  const seen = new Set()
  const out = []
  for (const view of views ?? []) {
    if (view === null || typeof view !== 'object') continue
    const { id, owner, status, label } = view
    if (typeof id !== 'string' || id === '') continue
    if (typeof owner !== 'string' || owner === '') continue
    if (!memberIds.has(owner)) continue
    if (status !== 'running' && status !== 'stopping') continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, owner, label: typeof label === 'string' && label !== '' ? label : id, status })
  }
  return out
}

/**
 * Read the coverage gaps a `workspace/session-activity` answer reports.
 * Only `subagent` and `job` carry per-item identity; `turn` and `schedule` are
 * ignored (`schedule` is explicitly out of scope, and the root turn is the first
 * thing the stop already asked for).
 * @param activities - the waterfall's SessionActivity rows.
 * @param handled - ids already asked to stop.
 * @returns deduplicated `{ id, kind, label }` gaps.
 */
export function coverageGaps(activities, handled) {
  const seen = new Set()
  const out = []
  for (const activity of activities ?? []) {
    if (activity === null || typeof activity !== 'object') continue
    const kind = activity.kind
    if (kind !== 'subagent' && kind !== 'job') continue
    for (const item of activity.items ?? []) {
      if (item === null || typeof item !== 'object') continue
      const id = item.id
      if (typeof id !== 'string' || id === '') continue
      if (handled.has(id) || seen.has(id)) continue
      seen.add(id)
      out.push({ id, kind, label: typeof item.label === 'string' && item.label !== '' ? item.label : id })
    }
  }
  return out
}

/**
 * In-memory `requestId → result` cache that makes browser retries safe.
 * Bounded by {@link REQUEST_LIMIT} and expired after {@link REQUEST_TTL_MS}; the
 * oldest insertion falls out first (a request id is used once, so LRU order is
 * plain insertion order refreshed on write).
 * @param options.now - clock override for tests.
 * @param options.limit - entry cap override.
 * @param options.ttlMs - expiry override.
 * @returns `{ get(id), put(id, record), size, clear() }`.
 */
export function createRequestCache(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : REQUEST_LIMIT
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs >= 0 ? options.ttlMs : REQUEST_TTL_MS
  const entries = new Map()
  const prune = () => {
    const at = now()
    for (const [key, entry] of entries) {
      if (at - entry.at >= ttlMs) entries.delete(key)
    }
    while (entries.size > limit) {
      const oldest = entries.keys().next()
      if (oldest.done === true) break
      entries.delete(oldest.value)
    }
  }
  return {
    get(id) {
      prune()
      const entry = entries.get(id)
      return entry === undefined ? undefined : entry.record
    },
    put(id, record) {
      prune()
      entries.delete(id)
      entries.set(id, { at: now(), record })
      prune()
    },
    get size() {
      prune()
      return entries.size
    },
    clear() {
      entries.clear()
    },
  }
}

/**
 * Per-session "which turn is open" table fed from `session/event` (plan §16.5:
 * this replaces the deprecated `sessionProjections.stateOf(..., 'turnBoundary')`
 * read).
 * @returns `{ onEvent(session, event), turnOf(id), forget(id), size }`.
 */
export function createTurnTable() {
  /** sessionId → { open: number | null } */
  const open = new Map()
  return {
    onEvent(session, event) {
      const id = session?.id
      if (typeof id !== 'string') return
      if (event?.type === 'turn/start') {
        const turn = event.data?.turn
        if (typeof turn === 'number') open.set(id, { open: turn })
        return
      }
      if (event.type === 'turn/end') {
        const turn = event.data?.turn
        const current = open.get(id)
        if (current !== undefined && current.open !== null && current.open !== turn) return
        open.set(id, { open: null })
      }
    },
    /**
     * The open turn number, `null` between turns, `undefined` when nothing has
     * been observed for this session yet (target unknown — first ask only).
     */
    turnOf(id) {
      const entry = open.get(id)
      return entry === undefined ? undefined : entry.open
    },
    forget(id) {
      open.delete(id)
    },
    get size() {
      return open.size
    },
  }
}

/**
 * Whether a re-issue still applies to one planned target: the plan recorded a
 * concrete turn, and the session still reports that same open turn. A member
 * that opened a new turn after the stop is new work and is left alone.
 * @param planned - `{ turn }` as recorded by the first pass (`number | null | undefined`).
 * @param current - the session's current open turn (`turnOf` result).
 * @returns true when the target is the same, still-open turn.
 */
export function sameTurn(planned, current) {
  return typeof planned === 'number' && current === planned
}
