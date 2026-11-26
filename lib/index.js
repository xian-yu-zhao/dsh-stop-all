/**
 * dsh-stop-all — Host half.
 *
 * One click expands the native stop's meaning from the main conversation to the
 * whole conversation tree:
 *
 *   - the tree root's open turn — exactly the native stop call,
 *     `agent.cancel({ kind: 'user' }, { keepInbox: true })`, so queued input,
 *     resident subagents and scheduled tasks all survive;
 *   - every running subagent at any depth — `subagents.interrupt(id, { kind: 'user' })`,
 *     the official user-authorised path (no archive, no dispose, no slot release);
 *   - running/stopping background jobs owned by tree members — `jobs.kill(...)`
 *     with an accurate reason.
 *
 * The Host owns coverage: the browser only asks and renders. A second best-effort
 * pass enumerates the durable subagent catalog (external backends and members
 * whose parent already left have no local Session to scan), and a read-only
 * `workspace/session-activity` query verifies the result afterwards.
 *
 * `workspace/session-stop` is deliberately NOT used: its providers discard the
 * main queue, delete scheduled tasks, and record jobs as "session archived".
 *
 * No `@deepseek-ai/*` import on purpose. The profile's node_modules does not
 * carry those packages, so this module registers its Remote service the way the
 * Gateway actually discovers one: a Cordis service key whose instance carries a
 * `typertRemote` binding, plus the Remote method descriptor the decorator would
 * have written. Source-mode reflection reads the method signatures directly.
 *
 * @module dsh-stop-all
 */

import {
  MAX_REISSUES,
  coverageGaps,
  createRequestCache,
  createTurnTable,
  isRunning,
  jobTargets,
  membersOf,
  normalizeConfig,
  resolveRoot,
  sameTurn,
} from './logic.js'

export const name = 'stop-all'

/**
 * The Agent registry is the one service every path needs (root lookup, member
 * scan, root cancel). `subagents`, `jobs`, and `agentTeams` are read through
 * `ctx.get()` so a composition without them still loads and degrades.
 */
export const inject = ['agents']

/** Cordis service key; also the Remote namespace the browser calls. */
const SERVICE_KEY = 'stopAll'
const NAMESPACE = 'stopAll'
/** Where the Typert protocol keeps the Remote method descriptor of a prototype. */
const REMOTE_METHODS = '@deepseek-ai/dsh-typert-protocol/remote-methods'
/** Budget for the durable catalog pass (plan §5.2 S2). */
const CATALOG_TIMEOUT_MS = 2000
/** Cheap sanity check for a browser-minted request id. */
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,80}$/

/**
 * Build the structural Remote failure the Host Gateway encodes unchanged.
 * Discrimination is by code and the `isDSHRemoteError` marker (cross-realm safe),
 * so this needs no class import.
 * @param code - stable failure code.
 * @param message - human diagnostic.
 * @param details - structured payload.
 * @returns an Error the Gateway treats as a `RemoteError`.
 */
function remoteFailure(code, message, details = {}) {
  const error = new Error(message)
  error.name = 'RemoteError'
  error.isDSHRemoteError = true
  error.code = code
  error.details = details
  return error
}

/** Human-readable message of an unknown thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Whether a value is a plain object (Remote arguments arrive as JSON data). */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a `jobs.kill` failure just means "that job is gone or not ours".
 * The registry throws for an unknown or foreign job; both are benign here
 * because the earlier intent already took effect or the row was never ours.
 * @param error - the thrown value.
 * @returns true when the failure carries no new information.
 */
function isMissingJobError(error) {
  const code = error?.code
  if (code === 'JOB_NOT_FOUND' || code === 'JOB_FOREIGN_SESSION') return true
  // Older registries only carry the message; keep the same tolerance.
  return /unknown job|belongs to another session|not found/i.test(messageOf(error))
}

/**
 * One Host-side attempt at stopping a tree.
 *
 * The class keeps its methods on the prototype on purpose: source-mode Remote
 * reflection reads parameter names from `Function.prototype.toString`, so a
 * destructured or defaulted parameter would be rejected by the Gateway.
 */
class StopAllService {
  /**
   * @param ctx - the plugin's own Context (service lookups and logging).
   * @param config - a normalised config from {@link normalizeConfig}.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    /** requestId → { sessionId, result, plan } so browser retries are safe. */
    this.cache = createRequestCache()
    /** Diagnostic counters: how many Remote calls actually reached this Host. */
    this.statusCalls = 0
    this.stopCalls = 0
    /** sessionId → open turn number, fed from `session/event`. */
    this.turns = createTurnTable()
    Object.defineProperty(this, 'typertRemote', {
      value: Object.freeze({ service: this, serviceKey: SERVICE_KEY, namespace: NAMESPACE }),
      enumerable: true,
    })
  }

  /* ------------------------------------------------------------------ */
  /* Remote: status                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Read what is still running in the caller's tree. Pure memory work: no
   * Session load, no resume, no mutation.
   * @param request - `{ sessionId }` of the Session the caller is looking at.
   * @returns the status view the button renders from.
   * @throws `stop-all/not-found` when the Session is not attachable.
   */
  status(request) {
    this.statusCalls += 1
    const sessionId = this.sessionIdOf(request)
    const root = this.resolve(sessionId)
    const members = this.membersOfTree(root.rootId)
    const memberIds = new Set([root.rootId, ...members.map(member => member.id)])
    const running = members.filter(isRunning)
    const descendants = running.map(member => ({
      id: member.id,
      label: this.labelOf(member),
      turn: this.turnOf(member.id),
    }))
    const jobs = this.config.includeJobs ? jobTargets(this.jobViews(memberIds), memberIds) : []
    const active = descendants.length > 0 || jobs.length > 0
    const teamMode = this.teamModeOf(root.root)
    return {
      sessionId,
      rootId: root.rootId,
      isRootPage: sessionId === root.rootId,
      root: { running: isRunning(root.root), turn: this.turnOf(root.rootId) },
      descendants,
      jobs,
      active,
      teamMode,
      visible: this.config.requireTeamMode ? teamMode && active : active,
      partialTree: root.partialTree,
      // The browser cannot read Host config; these two drive its watching loop.
      config: { settleTimeoutMs: this.config.settleTimeoutMs, autoReissue: this.config.autoReissue },
    }
  }

  /* ------------------------------------------------------------------ */
  /* Remote: stop                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Stop everything the tree is doing, right now.
   *
   * Team mode is intentionally not consulted: hiding the button is a UI
   * decision, and a request that reached the Host means the user asked.
   * @param request - `{ sessionId, requestId, retryOf? }`.
   * @param signal - caller cancellation; already-issued cancels are not retracted,
   *   only the remaining passes are skipped.
   * @returns `{ ok, rootId, requested, failed, killedJobs, partialTree, coverageGaps, degraded }`.
   * @throws `gateway/bad-request`, `stop-all/not-found`, or `gateway/cancelled`.
   */
  async stop(request, signal) {
    this.stopCalls += 1
    const sessionId = this.sessionIdOf(request)
    const requestId = isPlainObject(request) ? request.requestId : undefined
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
      throw remoteFailure('gateway/bad-request', 'requestId must be a browser-minted identity', { requestId })
    }
    const cached = this.cache.get(requestId)
    if (cached !== undefined) {
      if (cached.sessionId !== sessionId) {
        throw remoteFailure('gateway/bad-request', `requestId ${requestId} was already used for another session`, {
          requestId, sessionId, other: cached.sessionId,
        })
      }
      return cached.result
    }
    const started = Date.now()
    const root = this.resolve(sessionId)
    const retryOf = isPlainObject(request) && typeof request.retryOf === 'string' ? request.retryOf : undefined
    const original = retryOf === undefined ? undefined : this.cache.get(retryOf)
    const outcome = original === undefined
      ? await this.stopTree(root, signal)
      : await this.reissue(root, original, signal)
    const result = {
      ok: outcome.failed.length === 0,
      rootId: root.rootId,
      requested: outcome.requested,
      failed: outcome.failed,
      killedJobs: outcome.requested.filter(entry => entry.kind === 'job').length,
      partialTree: root.partialTree,
      coverageGaps: outcome.coverageGaps,
      reissued: outcome.reissued ?? [],
      degraded: outcome.degraded,
    }
    this.cache.put(requestId, { sessionId, result, plan: outcome.plan })
    // Rolling diagnostic of the latest stop (read by tests and support paths).
    this.lastStop = {
      requestId,
      at: Date.now(),
      ok: result.ok,
      requested: result.requested.length,
      failed: result.failed.length,
      reissued: result.reissued.length,
      unresolved: result.coverageGaps.length,
      degraded: result.degraded,
    }
    try {
      this.ctx.logger?.info?.(
        'stop-all: session %s root %s → %d requested, %d failed, %d reissued, %d unresolved in %dms',
        sessionId, root.rootId, result.requested.length, result.failed.length, result.reissued.length,
        result.coverageGaps.length, Date.now() - started,
      )
    } catch {
      // A logger without printf support must not fail the stop.
    }
    return result
  }

  /* ------------------------------------------------------------------ */
  /* The three passes                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Plan and issue one full stop (plan §6 [1]–[3]).
   * @param root - the resolved tree.
   * @param signal - caller cancellation.
   * @returns requested/failed rows, coverage gaps, degrade notes, and the plan.
   */
  async stopTree(root, signal) {
    const members = this.membersOfTree(root.rootId)
    const memberIds = new Set([root.rootId, ...members.map(member => member.id)])
    const requested = []
    const failed = []
    const plan = []
    const handled = new Set()

    // Pass 1 — one synchronous tick, root first, then subagents, then jobs.
    // An idle agent is not a target: cancelling it would be a no-op and would
    // report work that never existed (plan §9: a re-click on a quiet tree
    // returns `ok` with an empty `requested`).
    if (isRunning(root.root)) this.cancelRoot(root.root, requested, failed, plan, handled)
    for (const member of members) {
      if (!isRunning(member)) continue
      this.interruptChild(member, requested, failed, plan, handled)
    }
    const jobs = this.config.includeJobs ? jobTargets(this.jobViews(memberIds), memberIds) : []
    for (const job of jobs) this.killJob(job, requested, failed, plan, handled)

    const degraded = []
    if (this.ctx.get('subagents') === undefined) degraded.push('subagents-unavailable')
    if (this.ctx.get('jobs') === undefined && this.config.includeJobs) degraded.push('jobs-unavailable')

    // One read-only activity snapshot serves both the catalog gate and the
    // verification pass: it is the only authority on "what is still running".
    this.throwIfCancelled(signal)
    const snapshot = await this.activitySnapshot([...memberIds], signal)
    // Pass 2 — durable catalog fallback (external backends, orphaned members).
    // Only meaningful while the tree is actually doing something: on a quiet
    // tree every catalog child would be re-asked for nothing, and a re-click
    // must report an empty plan (plan §9).
    if (this.config.catalogPass && (requested.length > 0 || snapshot.activeIds.size > 0)) {
      await this.catalogPass(root.rootId, requested, failed, plan, handled, signal, degraded, snapshot)
    }

    // Pass 3 — independent read-only verification of the outcome. A gap this
    // pass re-issues is `reissued` (normal: interrupt is fire-and-return); only
    // a gap it cannot re-issue stays in `coverageGaps`.
    const coverage = await this.coveragePass(snapshot, requested, failed, plan, handled, degraded)

    return { requested, failed, plan, coverageGaps: coverage.unresolved, reissued: coverage.reissued, degraded }
  }

  /**
   * Re-issue only the targets of an earlier plan that are still the same work
   * (plan §7.5): a member that opened a new turn after the stop is left alone.
   * Jobs are judged by their own facts instead (see {@link reissueJob}): a job
   * id never appears in the turn table, so the turn check must not apply to it.
   * @param root - the resolved tree.
   * @param original - the cached record the browser retries from.
   * @param signal - caller cancellation.
   * @returns the same result shape as {@link stopTree}.
   */
  async reissue(root, original, signal) {
    const requested = []
    const failed = []
    const plan = []
    const handled = new Set()
    const planRows = Array.isArray(original?.plan) ? original.plan : []
    for (const row of planRows) {
      if (!isPlainObject(row) || typeof row.id !== 'string') continue
      if (row.kind === 'job') {
        this.reissueJob(row, requested, failed, plan, handled)
        continue
      }
      // Turn rows and subagent rows only: still the same work?
      if (!sameTurn(row.turn, this.turns.turnOf(row.id))) continue
      if (row.kind === 'turn') {
        const agent = this.agentOf(row.id)
        if (agent === undefined || !isRunning(agent)) continue
        this.cancelRoot(agent, requested, failed, plan, handled)
        continue
      }
      const member = this.agentOf(row.id)
      if (member === undefined || !isRunning(member)) continue
      this.interruptChild(member, requested, failed, plan, handled)
    }
    const degraded = []
    this.throwIfCancelled(signal)
    const snapshot = await this.activitySnapshot(this.membersOfTree(root.rootId).map(member => member.id).concat(root.rootId), signal)
    const gaps = await this.coveragePass(snapshot, requested, failed, plan, handled, degraded)
    return { requested, failed, plan, coverageGaps: gaps.unresolved, reissued: gaps.reissued, degraded }
  }

  /**
   * Re-issue one job row from an earlier plan.
   *
   * A job has no conversation turn, so it is judged by its own facts: it must
   * still exist, still belong to the plan's owner, and still be running or
   * stopping. A settled job, a vanished job, or a job that changed owner is
   * neither requested nor failed — the earlier kill already took effect (or the
   * row is no longer ours to touch) and the caller learns nothing new.
   */
  reissueJob(row, requested, failed, plan, handled) {
    const owner = typeof row.owner === 'string' ? row.owner : undefined
    if (owner === undefined) return
    const jobs = this.ctx.get('jobs')
    if (typeof jobs?.list !== 'function') return
    let live
    try {
      const rows = jobs.list(owner)
      if (Array.isArray(rows)) live = rows.find(job => isPlainObject(job) && job.id === row.id)
    } catch {
      // A foreign or unknown owner contributes no rows: nothing to re-issue.
      return
    }
    if (!isPlainObject(live)) return
    if (live.owner !== owner) return
    if (live.status !== 'running' && live.status !== 'stopping') return
    this.killJob({ id: row.id, owner, label: live.label ?? row.label ?? row.id, status: live.status }, requested, failed, plan, handled)
  }

  /** Stop the root turn with exactly the native call. */
  cancelRoot(agent, requested, failed, plan, handled) {
    const turn = this.turnOf(agent.id)
    try {
      agent.cancel({ kind: 'user' }, { keepInbox: true })
      requested.push({ id: agent.id, kind: 'turn', label: this.labelOf(agent) })
      plan.push({ id: agent.id, kind: 'turn', label: this.labelOf(agent), turn })
      handled.add(agent.id)
    } catch (error) {
      failed.push({ id: agent.id, kind: 'turn', label: this.labelOf(agent), error: messageOf(error) })
      handled.add(agent.id)
    }
  }

  /** Interrupt one subagent through the user-authorised path, with a cancel fallback. */
  interruptChild(member, requested, failed, plan, handled) {
    const turn = this.turnOf(member.id)
    const subagents = this.ctx.get('subagents')
    try {
      if (typeof subagents?.interrupt === 'function') {
        subagents.interrupt(member.id, { kind: 'user' })
      } else {
        member.cancel({ kind: 'user' }, { keepInbox: true })
      }
      requested.push({ id: member.id, kind: 'subagent', label: this.labelOf(member) })
      plan.push({ id: member.id, kind: 'subagent', label: this.labelOf(member), turn })
      handled.add(member.id)
      return
    } catch (error) {
      // The official call failed (for example the activation is already closing):
      // the plain cancel keeps the same semantics and does not touch the tree.
      try {
        member.cancel({ kind: 'user' }, { keepInbox: true })
        requested.push({ id: member.id, kind: 'subagent', label: this.labelOf(member) })
        plan.push({ id: member.id, kind: 'subagent', label: this.labelOf(member), turn })
        handled.add(member.id)
        try {
          this.ctx.logger?.warn?.('stop-all: interrupt fell back to cancel for %s (%s)', member.id, messageOf(error))
        } catch { /* logging is best effort */ }
      } catch (fallbackError) {
        failed.push({
          id: member.id,
          kind: 'subagent',
          label: this.labelOf(member),
          error: `${messageOf(error)}; fallback: ${messageOf(fallbackError)}`,
        })
        handled.add(member.id)
      }
    }
  }

  /** Kill one owned background job with an accurate reason. */
  killJob(job, requested, failed, plan, handled) {
    const jobs = this.ctx.get('jobs')
    if (typeof jobs?.kill !== 'function') {
      failed.push({ id: job.id, kind: 'job', label: job.label, error: 'jobs service unavailable' })
      handled.add(job.id)
      return
    }
    try {
      // `requested` covers both a live kill and the idempotent 'already-finished'
      // answer: either way the caller's intent is satisfied.
      jobs.kill(job.id, job.owner, this.config.killReason)
      requested.push({ id: job.id, kind: 'job', label: job.label })
      plan.push({ id: job.id, kind: 'job', label: job.label, owner: job.owner, turn: this.turnOf(job.owner) })
      handled.add(job.id)
    } catch (error) {
      if (isMissingJobError(error)) {
        // The job settled or vanished between listing and killing: the earlier
        // intent already took effect, so this is neither a request nor a failure.
        handled.add(job.id)
        return
      }
      failed.push({ id: job.id, kind: 'job', label: job.label, error: messageOf(error) })
      handled.add(job.id)
    }
  }

  /**
   * Second pass: the catalog-reachable children the first pass could not see —
   * external backend executions (no local Session) and anything the read-only
   * activity query still reports as running (plan §5.2 S2). Historical children
   * are skipped: asking a settled one would report a stop that never happened.
   */
  async catalogPass(rootId, requested, failed, plan, handled, signal, degraded, snapshot) {
    if (!this.config.catalogPass) return
    const subagents = this.ctx.get('subagents')
    if (typeof subagents?.listDescendants !== 'function') return
    let entries
    try {
      const budget = this.catalogSignal(signal)
      entries = await subagents.listDescendants(rootId, budget.signal)
      budget.dispose()
    } catch (error) {
      degraded.push('catalog-unverified')
      try {
        this.ctx.logger?.warn?.('stop-all: catalog pass skipped for %s (%s)', rootId, messageOf(error))
      } catch { /* logging is best effort */ }
      return
    }
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!isPlainObject(entry) || entry.kind !== 'child') continue
      const id = entry.id
      if (typeof id !== 'string' || handled.has(id)) continue
      const agent = this.agentOf(id)
      if (agent !== undefined) {
        // A live but idle member is not work; asking it would report a stop
        // that never happened.
        if (isRunning(agent)) this.interruptChild(agent, requested, failed, plan, handled)
        continue
      }
      // No local Session: only an external backend execution or a child the
      // activity query still reports as running is a target here.
      const external = entry.mode === 'external'
      if (!external && snapshot?.activeIds?.has(id) !== true) continue
      try {
        subagents.interrupt(id, { kind: 'user' })
        requested.push({ id, kind: 'subagent', label: this.catalogLabel(entry) })
        plan.push({ id, kind: 'subagent', label: this.catalogLabel(entry), turn: undefined })
        handled.add(id)
      } catch (error) {
        failed.push({ id, kind: 'subagent', label: this.catalogLabel(entry), error: messageOf(error) })
        handled.add(id)
      }
    }
  }

  /**
   * One read-only `workspace/session-activity` read per member (plan §5.2 S3).
   * The answer is reused twice: as the catalog gate (what is genuinely running)
   * and as the independent verification of the stop itself.
   * @param ids - member session ids, root included.
   * @param signal - caller cancellation; a partial snapshot is still useful.
   * @returns `{ byId, activeIds, attempted, verified }`.
   */
  async activitySnapshot(ids, signal) {
    const byId = new Map()
    const activeIds = new Set()
    let attempted = 0
    let verified = 0
    for (const id of ids) {
      if (signal?.aborted) break
      attempted += 1
      const answer = await this.activityOf(id)
      if (answer === undefined) continue
      verified += 1
      byId.set(id, answer)
      for (const activity of answer) {
        if (!isPlainObject(activity)) continue
        if (activity.kind !== 'subagent' && activity.kind !== 'job') continue
        for (const item of Array.isArray(activity.items) ? activity.items : []) {
          if (isPlainObject(item) && typeof item.id === 'string' && item.id !== '') activeIds.add(item.id)
        }
      }
    }
    return { byId, activeIds, attempted, verified }
  }

  /**
   * Third pass: verify the stop against the read-only activity answer and
   * re-issue once for anything the two passes missed (plan §6 principle 3).
   * A failed or absent query degrades to "unverified"; it never fails the stop.
   */
  async coveragePass(snapshot, requested, failed, plan, handled, degraded) {
    const empty = { reissued: [], unresolved: [] }
    if (snapshot.attempted === 0) return empty
    if (snapshot.verified === 0) {
      degraded.push('coverage-unverified')
      return empty
    }
    const ownerOfJob = new Map()
    const activities = []
    for (const [owner, answer] of snapshot.byId) {
      for (const activity of answer) {
        if (!isPlainObject(activity) || activity.kind !== 'job') continue
        for (const item of Array.isArray(activity.items) ? activity.items : []) {
          if (isPlainObject(item) && typeof item.id === 'string' && !ownerOfJob.has(item.id)) ownerOfJob.set(item.id, owner)
        }
      }
      activities.push(...answer)
    }
    const gaps = coverageGaps(activities, handled)
    if (gaps.length === 0) return empty
    const subagents = this.ctx.get('subagents')
    const reissued = []
    const unresolved = []
    for (const gap of gaps) {
      // A gap counts as resolved only when a cancellation was actually issued
      // for it; everything else stays visible to the caller.
      const before = requested.length
      if (gap.kind === 'job') {
        const owner = ownerOfJob.get(gap.id)
        if (owner === undefined) {
          unresolved.push(gap)
          continue
        }
        this.killJob({ id: gap.id, owner, label: gap.label, status: 'running' }, requested, failed, plan, handled)
      } else {
        const agent = this.agentOf(gap.id)
        if (agent !== undefined) {
          if (isRunning(agent)) this.interruptChild(agent, requested, failed, plan, handled)
        } else {
          try {
            if (typeof subagents?.interrupt !== 'function') {
              unresolved.push(gap)
              continue
            }
            subagents.interrupt(gap.id, { kind: 'user' })
            requested.push({ id: gap.id, kind: 'subagent', label: gap.label })
            handled.add(gap.id)
          } catch (error) {
            failed.push({ id: gap.id, kind: 'subagent', label: gap.label, error: messageOf(error) })
            handled.add(gap.id)
          }
        }
      }
      if (requested.length > before) reissued.push(gap)
      else unresolved.push(gap)
    }
    try {
      this.ctx.logger?.warn?.(
        'stop-all: coverage-gap reissued %s; unresolved %s',
        reissued.map(gap => `${gap.kind}:${gap.id}`).join(', ') || '-',
        unresolved.map(gap => `${gap.kind}:${gap.id}`).join(', ') || '-',
      )
    } catch { /* logging is best effort */ }
    return { reissued, unresolved }
  }

  /* ------------------------------------------------------------------ */
  /* Service accessors                                                   */
  /* ------------------------------------------------------------------ */

  /** The live Agent for one id, or undefined. */
  agentOf(id) {
    const agents = this.ctx.get('agents')
    return typeof agents?.get === 'function' ? agents.get(id) : undefined
  }

  /** Every live Agent, in registry order. */
  listAgents() {
    const agents = this.ctx.get('agents')
    return typeof agents?.list === 'function' ? agents.list() : []
  }

  /** Resolve the tree, mapping "no such live agent" onto the Remote error code. */
  resolve(sessionId) {
    const root = resolveRoot({
      agentOf: id => this.agentOf(id),
      rootOf: agent => {
        const subagents = this.ctx.get('subagents')
        if (typeof subagents?.rootOf !== 'function') throw new Error('subagent runtime unavailable')
        return subagents.rootOf(agent)
      },
    }, sessionId)
    if (root.kind === 'not-found') {
      throw remoteFailure('stop-all/not-found', `session ${sessionId} is not attachable`, { sessionId })
    }
    if (root.partialTree) {
      try {
        this.ctx.logger?.warn?.('stop-all: partial tree for %s (root %s)', sessionId, root.rootId)
      } catch { /* logging is best effort */ }
    }
    return root
  }

  /** Live agents strictly below `rootId` (optionally excluding one id). */
  membersOfTree(rootId, exclude) {
    const members = membersOf(() => this.listAgents(), id => this.agentOf(id), rootId)
    return exclude === undefined ? members : members.filter(member => member.id !== exclude)
  }

  /** Read `{ sessionId }` off a Remote argument, or fail with the Gateway's code. */
  sessionIdOf(request) {
    const sessionId = isPlainObject(request) ? request.sessionId : undefined
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw remoteFailure('gateway/bad-request', 'sessionId must be a non-empty string', { sessionId })
    }
    return sessionId
  }

  /** The current open turn number, `null` between turns. */
  turnOf(sessionId) {
    const turn = this.turns.turnOf(sessionId)
    return typeof turn === 'number' ? turn : null
  }

  /** Best-effort display label: the model-facing member name, else the id. */
  labelOf(agent) {
    const subagents = this.ctx.get('subagents')
    try {
      const names = subagents?.namesOf?.(agent)
      if (names !== undefined && typeof names.name === 'string' && names.name !== '') return names.name
    } catch {
      // A member outside an owned tree has no name; the id is the honest label.
    }
    return agent.id
  }

  /** Display label of one durable catalog row. */
  catalogLabel(entry) {
    if (typeof entry.label === 'string' && entry.label !== '') return entry.label
    if (typeof entry.path === 'string' && entry.path !== '') return entry.path
    return entry.id
  }

  /**
   * Running/stopping job views owned by any of `memberIds`.
   * `jobs.list(caller)` also returns unowned jobs; `jobTargets` drops them,
   * because an owner-less job cannot be attributed to a conversation tree.
   */
  jobViews(memberIds) {
    const jobs = this.ctx.get('jobs')
    if (typeof jobs?.list !== 'function') return []
    const views = []
    for (const id of memberIds) {
      try {
        const rows = jobs.list(id)
        if (Array.isArray(rows)) views.push(...rows)
      } catch {
        // A foreign or unknown owner simply contributes no rows.
      }
    }
    return views
  }

  /** Whether the tree root has team collaboration enabled (plan §7.2). */
  teamModeOf(rootAgent) {
    const agentTeams = this.ctx.get('agentTeams')
    if (agentTeams === undefined) return false
    try {
      return agentTeams.isEnabled(rootAgent) === true
    } catch (error) {
      try {
        this.ctx.logger?.debug?.('stop-all: team mode unavailable (%s)', messageOf(error))
      } catch { /* logging is best effort */ }
      return false
    }
  }

  /** One read-only activity answer, or undefined when the query is unavailable. */
  async activityOf(sessionId) {
    if (typeof this.ctx.waterfall !== 'function') return undefined
    try {
      const answer = await this.ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
      return Array.isArray(answer) ? answer : undefined
    } catch {
      return undefined
    }
  }

  /**
   * AbortSignal for the catalog pass: caller cancellation composed with a 2s
   * budget. Falls back to a hand-rolled controller when `AbortSignal.any` is
   * unavailable.
   */
  catalogSignal(signal) {
    let timer
    try {
      const budget = AbortSignal.timeout(CATALOG_TIMEOUT_MS)
      const composed = signal === undefined ? budget : AbortSignal.any([signal, budget])
      return { signal: composed, dispose: () => {} }
    } catch {
      const controller = new AbortController()
      timer = setTimeout(() => controller.abort(new Error('stop-all catalog budget')), CATALOG_TIMEOUT_MS)
      const onAbort = () => controller.abort(signal?.reason)
      signal?.addEventListener?.('abort', onAbort, { once: true })
      return {
        signal: controller.signal,
        dispose: () => {
          clearTimeout(timer)
          signal?.removeEventListener?.('abort', onAbort)
        },
      }
    }
  }

  /** Fail the call when the caller already went away (plan §7.4). */
  throwIfCancelled(signal) {
    if (signal?.aborted !== true) return
    throw remoteFailure('gateway/cancelled', 'caller cancelled the stop; issued cancels are not retracted', {})
  }
}

/*
 * The Remote method descriptor a decorator would have written. Source-mode
 * reflection reads the method signatures, while each `resources` reader names
 * the Session the call acts on — that is the whole access-control declaration
 * (a user who can see a tree can already archive-and-stop it).
 */
Object.defineProperty(StopAllService.prototype, REMOTE_METHODS, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([
      Object.freeze({
        method: 'status',
        invocation: Object.freeze({ kind: 'direct' }),
        resources: Object.freeze({ session: request => (isPlainObject(request) ? request.sessionId : undefined) }),
      }),
      Object.freeze({
        method: 'stop',
        invocation: Object.freeze({ kind: 'direct' }),
        resources: Object.freeze({ session: request => (isPlainObject(request) ? request.sessionId : undefined) }),
      }),
    ]),
  }),
})

/**
 * Sanity-check on startup: the plugin hand-writes the Remote contract (the
 * `typertRemote` binding plus the prototype method marker) instead of importing
 * the protocol package, so a dsh upgrade could change that contract and leave
 * the button silently inert. When a builtin Remote service is reachable in the
 * same process, compare shapes and warn — never throw and never change behaviour.
 * @param ctx - the plugin Context.
 * @param own - this plugin's service instance.
 */
function verifyRemoteContract(ctx, own) {
  let builtin
  try {
    builtin = ctx.get('agentTeams')
  } catch {
    // A dotted service may be unreadable from this context; absence is not a fault.
    return
  }
  if (builtin === undefined || builtin === null) return
  let consistent = true
  try {
    const builtinMarker = markerOf(builtin)
    const builtinRemote = builtin?.typertRemote
    // Not a Remote service at all: nothing comparable, so no claim either way.
    if (!isPlainObject(builtinMarker) && !isPlainObject(builtinRemote)) return
    consistent = isPlainObject(builtinMarker) && sameRemoteShape(own, builtin)
  } catch {
    consistent = false
  }
  if (consistent) return
  try {
    ctx.logger?.warn?.(
      'stop-all: 当前 dsh 版本的远程服务契约与插件预期不一致，按钮可能无法工作 '
      + '(the dsh remote-service contract differs from this plugin\'s expectation; '
      + 'the stop-all button may not work). This plugin targets dsh 44.7.0 — re-check '
      + '`typertRemote` and the prototype `%s` marker after an upgrade.',
      REMOTE_METHODS,
    )
  } catch {
    // A logger without printf support must not break startup.
  }
}

/** The prototype-level Remote method marker of one service instance, if any. */
function markerOf(value) {
  try {
    return Object.getPrototypeOf(value)?.[REMOTE_METHODS]
  } catch {
    return undefined
  }
}

/**
 * Whether two service instances expose the same hand-written Remote shape:
 * a version-matched method list of direct invocations plus a `typertRemote`
 * binding carrying `service`/`serviceKey`/`namespace`.
 * @param own - this plugin's service instance.
 * @param builtin - a builtin Remote service instance.
 * @returns true when both look like the contract this plugin relies on.
 */
function sameRemoteShape(own, builtin) {
  const ownMarker = markerOf(own)
  const builtinMarker = markerOf(builtin)
  if (!isPlainObject(ownMarker) || !isPlainObject(builtinMarker)) return false
  if (ownMarker.version !== builtinMarker.version) return false
  if (!Array.isArray(ownMarker.methods) || !Array.isArray(builtinMarker.methods)) return false
  if (!ownMarker.methods.every(isDirectMethod) || !builtinMarker.methods.every(isDirectMethod)) return false
  const ownRemote = own?.typertRemote
  const builtinRemote = builtin?.typertRemote
  if (!isPlainObject(ownRemote) || !isPlainObject(builtinRemote)) return false
  return ['service', 'serviceKey', 'namespace'].every(key => key in ownRemote && key in builtinRemote)
}

/** One Remote method row: named method, direct invocation. */
function isDirectMethod(entry) {
  return isPlainObject(entry)
    && typeof entry.method === 'string'
    && isPlainObject(entry.invocation)
    && entry.invocation.kind === 'direct'
}

/**
 * Host plugin body: publish the `stopAll` Remote service and keep the per-session
 * open-turn table current.
 * @param ctx - the plugin Context.
 * @param rawConfig - the patch row's `config` object.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const service = new StopAllService(ctx, config)
  ctx.provide(SERVICE_KEY, service)
  verifyRemoteContract(ctx, service)
  ctx.on('session/event', (session, event) => {
    service.turns.onEvent(session, event)
  })
  ctx.on('session/disposed', (session) => {
    if (typeof session?.id === 'string') service.turns.forget(session.id)
  })
  try {
    ctx.logger?.info?.('stop-all: ready (includeJobs=%s, requireTeamMode=%s)', config.includeJobs, config.requireTeamMode)
  } catch {
    // Logging must never prevent the service from being published.
  }
}

/** Exported for tests and the startup contract self-check. */
export { verifyRemoteContract, sameRemoteShape, markerOf }
