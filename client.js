/**
 * dsh-stop-all — browser half.
 *
 * One compact icon button in the composer tool row (`conversation.input.right`,
 * the same group as the native stop button) that stops the whole conversation
 * tree through the Host `stopAll` Remote namespace: the root turn, every running
 * subagent at any depth, and the background jobs tree members own. The Host is
 * authoritative for what "the tree" is; this file owns only the button state
 * machine and the watching loop around `stop`.
 *
 * The Host half lives in `lib/`, declares the `stopAll` Typert Remote service,
 * and is mounted here through `ctx.remote.$mount` — a Client namespace exists
 * only after its contribution is mounted, so the button registers inside
 * `ctx.inject(['remote.stopAll'], ...)` and simply never appears when the Host
 * half is absent.
 *
 * This file is a plain browser script (no bundler): React.createElement only,
 * seed modules only (`react`, `zod`, `@deepseek-ai/dsh-client-ui-primitives`).
 */

window.__ModuleLoader__.load({
  id: 'dsh-stop-all',
  factory(require) {
    const React = require('react')
    const { useState, useEffect, useRef, useMemo, useCallback } = React
    const h = React.createElement
    const { z } = require('zod')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'stop-all'

    /** zh + en; every other locale falls back to en (locale service chain). */
    const dictionaries = {
      zh: {
        'button.aria': '停止全部',
        'button.tooltip': '停止全部：主对话 + {subagents} 个子代理 + {jobs} 个后台任务',
        'button.tooltip.subagentPage': '将停止整个对话树。',
        'button.tooltip.queue': '停止后，排队的 {count} 条输入会按原生规则继续。',
        'button.tooltip.irreversible': '中断不可逆：已执行的工具副作用不会撤销。',
        'button.stopping': '停止中…',
        'button.partial': '未完全停止',
        'button.partialTooltip': '未完全停止：{items}',
        'button.retry': '重试',
        'shortcut.label': '停止全部',
      },
      en: {
        'button.aria': 'Stop all',
        'button.tooltip': 'Stop all: main conversation + {subagents} subagent(s) + {jobs} background job(s)',
        'button.tooltip.subagentPage': 'This stops the whole conversation tree.',
        'button.tooltip.queue': 'After stopping, {count} queued message(s) resume as the native stop does.',
        'button.tooltip.irreversible': 'Interruption is irreversible: tool side effects already performed are not undone.',
        'button.stopping': 'Stopping…',
        'button.partial': 'Not fully stopped',
        'button.partialTooltip': 'Not fully stopped: {items}',
        'button.retry': 'Retry',
        'shortcut.label': 'Stop all',
      },
    }

    /** Shortest visible duration of the stopping state (plan §8.1). */
    const MIN_STOPPING_MS = 600
    /** Repeated clicks inside this window are ignored (plan §9). */
    const CLICK_DEBOUNCE_MS = 300
    /** Fallback silence-watch upper bound when the Host reports no config. */
    const DEFAULT_SETTLE_MS = 8000
    /** Safety net so a hung transport can never leave the button spinning forever. */
    const FLOW_DEADLINE_MS = 30000
    /** Per-call ceilings; the Remote carrier has its own timeout and this caps the spill. */
    const STOP_CALL_TIMEOUT_MS = 8000
    const STATUS_CALL_TIMEOUT_MS = 5000
    /** Transport retry spacing for one stop request id (same id, so the Host cache dedupes). */
    const TRANSPORT_RETRY_DELAYS = [500, 1500]
    /** Automatic re-issues while the same turn is still running (plan §12). */
    const MAX_REISSUE = 2
    /** Watch schedule, cumulative from the stop response (plan §6). */
    const WATCH_BASE_OFFSETS = [500, 1000, 2000, 4000, 6000, 8000, 12000, 16000]
    /** Tooltip item budget; the rest becomes `+N` (plan §4.1). */
    const MAX_TOOLTIP_ITEMS = 5

    /* --------------------------------------------------------------- *
     * Remote contribution: mount the Host namespace `stopAll`.
     * --------------------------------------------------------------- */

    function stopAllContribution(z) {
      const codec = () => ({
        mode: 'strict',
        typeSymbol: 'dsh-stop-all#StopAllRequest',
        create: () => z.object({ sessionId: z.string() }),
      })
      const method = (name) => ({
        id: `dsh-stop-all#stopAll/${name}`,
        service: 'stopAll',
        namespace: 'stopAll',
        method: name,
        invocation: { kind: 'direct' },
        parameters: [{
          name: 'request',
          wire: 'request',
          source: 'json',
          acceptsUndefined: false,
          codec: codec(),
          strictCodec: codec(),
        }],
        cancellation: { parameter: 'signal' },
        result: { mode: 'src-json' },
      })
      return { package: 'dsh-stop-all', descriptors: [method('status'), method('stop')] }
    }

    /* --------------------------------------------------------------- *
     * Small utilities.
     * --------------------------------------------------------------- */

    function createRequestId() {
      try {
        if (typeof globalThis !== 'undefined' && globalThis.crypto !== undefined
          && typeof globalThis.crypto.randomUUID === 'function') {
          return globalThis.crypto.randomUUID()
        }
      } catch (error) {
        // Fall through to the random fallback.
      }
      return `stop-all-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    }

    function abortError() {
      const error = new Error('stop-all: aborted')
      error.name = 'AbortError'
      return error
    }

    function timeoutError(label) {
      const error = new Error(`stop-all: ${label} timed out`)
      error.name = 'TimeoutError'
      return error
    }

    /** Abortable sleep; the caller's AbortController owns the timer. */
    function delay(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal !== undefined && signal !== null && signal.aborted === true) {
          reject(abortError())
          return
        }
        const timer = setTimeout(() => {
          cleanup()
          resolve()
        }, Math.max(0, ms))
        const onAbort = () => {
          cleanup()
          reject(abortError())
        }
        function cleanup() {
          clearTimeout(timer)
          if (signal !== undefined && signal !== null && typeof signal.removeEventListener === 'function') {
            signal.removeEventListener('abort', onAbort)
          }
        }
        if (signal !== undefined && signal !== null && typeof signal.addEventListener === 'function') {
          signal.addEventListener('abort', onAbort, { once: true })
        }
      })
    }

    /** Race one Remote invocation against a ceiling and the caller's signal. */
    async function callWithTimeout(invoke, timeoutMs, signal) {
      let timer = null
      let onAbort = null
      try {
        return await Promise.race([
          Promise.resolve().then(invoke),
          new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(timeoutError('remote call')), Math.max(1, timeoutMs))
            if (signal !== undefined && signal !== null && typeof signal.addEventListener === 'function') {
              onAbort = () => reject(abortError())
              signal.addEventListener('abort', onAbort, { once: true })
            }
          }),
        ])
      } finally {
        if (timer !== null) clearTimeout(timer)
        if (onAbort !== null && signal !== undefined && signal !== null
          && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort)
        }
      }
    }

    /** Read a Host status view without throwing; null means "unknown". */
    async function fetchStatusSafe(stopAll, sessionId, signal, logger) {
      try {
        const response = await callWithTimeout(
          () => stopAll.status({ sessionId }, signal),
          STATUS_CALL_TIMEOUT_MS,
          signal,
        )
        if (response !== null && typeof response === 'object' && response.ok === true) {
          return response.value === undefined ? null : response.value
        }
        if (response !== null && typeof response === 'object') {
          logger?.warn?.('stop-all: status request failed', response.error)
        }
        return null
      } catch (error) {
        if (signal !== undefined && signal !== null && signal.aborted === true) throw error
        logger?.warn?.('stop-all: status request failed', error)
        return null
      }
    }

    /**
     * Issue one `stop` request, retrying transport failures with the SAME request
     * id (the Host answers cached results for a repeated id, plan §7.5).
     * @returns `{ ok: true, value }` or `{ ok: false, error }` after the retries.
     */
    async function issueStop(deps, requestId, retryOf, deadline) {
      const { stopAll, sessionId, signal, logger } = deps
      const request = { sessionId, requestId }
      if (typeof retryOf === 'string' && retryOf !== '') request.retryOf = retryOf
      let lastError = null
      for (let attempt = 0; attempt <= TRANSPORT_RETRY_DELAYS.length; attempt += 1) {
        if (attempt > 0) await delay(TRANSPORT_RETRY_DELAYS[attempt - 1], signal)
        if (Date.now() >= deadline) break
        try {
          const response = await callWithTimeout(
            () => stopAll.stop(request, signal),
            Math.min(STOP_CALL_TIMEOUT_MS, Math.max(1000, deadline - Date.now())),
            signal,
          )
          if (response !== null && typeof response === 'object' && response.ok === true) {
            return { ok: true, value: response.value === undefined ? null : response.value }
          }
          lastError = (response !== null && typeof response === 'object')
            ? response.error
            : new Error('stop-all: stop request failed')
        } catch (error) {
          if (signal !== undefined && signal !== null && signal.aborted === true) throw error
          lastError = error
        }
      }
      logger?.warn?.('stop-all: stop request failed after transport retries', lastError)
      return { ok: false, error: lastError }
    }

    /* --------------------------------------------------------------- *
     * Status / result helpers. Every field is read defensively: the Host
     * contract is "at least these fields", never "exactly these".
     * --------------------------------------------------------------- */

    function planFromStatus(status) {
      const members = new Map()
      for (const member of status?.descendants ?? []) {
        if (member === null || typeof member !== 'object') continue
        if (typeof member.id !== 'string') continue
        members.set(member.id, typeof member.turn === 'number' ? member.turn : null)
      }
      const jobs = new Set()
      for (const job of status?.jobs ?? []) {
        if (job === null || typeof job !== 'object') continue
        if (typeof job.id === 'string') jobs.add(job.id)
      }
      return {
        rootTurn: typeof status?.root?.turn === 'number' ? status.root.turn : null,
        members,
        jobs,
      }
    }

    /**
     * Whether any planned target is still doing the SAME work it was asked to
     * stop. A member that opened a new turn is new work and gets left alone
     * (plan §7.5 / §9).
     */
    function sameTurnStillRunning(status, plan) {
      if (status === null || plan === null || plan === undefined) return false
      if (plan.rootTurn !== null && status.root?.running === true && status.root?.turn === plan.rootTurn) {
        return true
      }
      for (const member of status.descendants ?? []) {
        if (member === null || typeof member !== 'object') continue
        const planned = plan.members.get(member.id)
        if (typeof planned === 'number' && planned === member.turn) return true
      }
      for (const job of status.jobs ?? []) {
        if (job === null || typeof job !== 'object') continue
        if (plan.jobs.has(job.id)) return true
      }
      return false
    }

    function labelOf(target) {
      if (target === null || typeof target !== 'object') return ''
      if (typeof target.label === 'string' && target.label !== '') return target.label
      if (typeof target.id === 'string' && target.id !== '') return target.id
      return ''
    }

    function dedupeLabels(targets) {
      const seen = new Set()
      const labels = []
      for (const target of targets ?? []) {
        const label = labelOf(target)
        if (label === '' || seen.has(label)) continue
        seen.add(label)
        labels.push(label)
      }
      return labels
    }

    /** Remaining work after a watch timeout: descendants and jobs, root as a last resort. */
    function remainingLabels(status) {
      const labels = dedupeLabels([
        ...(status?.descendants ?? []),
        ...(status?.jobs ?? []),
      ])
      if (labels.length === 0 && status?.root?.running === true) {
        const rootLabel = labelOf({ id: status.rootId })
        if (rootLabel !== '') labels.push(rootLabel)
      }
      return labels
    }

    /** Union of per-target failures and coverage gaps reported by `stop`. */
    function failedLabels(result) {
      return dedupeLabels([
        ...(Array.isArray(result?.failed) ? result.failed : []),
        ...(Array.isArray(result?.coverageGaps) ? result.coverageGaps : []),
      ])
    }

    /** Host config carried by status / stop results, with documented fallbacks. */
    function resolveConfig() {
      let settleTimeoutMs = DEFAULT_SETTLE_MS
      let autoReissue = true
      for (let index = 0; index < arguments.length; index += 1) {
        const source = arguments[index]
        const config = source?.config
        if (config === null || typeof config !== 'object') continue
        if (typeof config.settleTimeoutMs === 'number' && Number.isFinite(config.settleTimeoutMs)
          && config.settleTimeoutMs >= 0) {
          settleTimeoutMs = config.settleTimeoutMs
        }
        if (typeof config.autoReissue === 'boolean') autoReissue = config.autoReissue
      }
      return { settleTimeoutMs, autoReissue }
    }

    /** Cumulative poll offsets, always ending exactly at the settle bound. */
    function watchOffsets(settleTimeoutMs) {
      const cap = settleTimeoutMs > 0 ? settleTimeoutMs : DEFAULT_SETTLE_MS
      const offsets = WATCH_BASE_OFFSETS.filter((ms) => ms < cap)
      if (offsets[offsets.length - 1] !== cap) offsets.push(cap)
      return offsets
    }

    /** Join displayed labels: at most five, the remainder summarized as `+N`. */
    function formatItems(labels) {
      const shown = labels.slice(0, MAX_TOOLTIP_ITEMS)
      const rest = labels.length - shown.length
      const base = shown.join('、')
      if (shown.length === 0) return ''
      return rest > 0 ? `${base} +${rest}` : base
    }

    /* --------------------------------------------------------------- *
     * Stop + watch flow (shared by the button and the shortcut).
     * --------------------------------------------------------------- */

    /**
     * Stop the tree once, then watch for quiescence, auto-reissuing while the
     * same turn is still running (plan §6 / §8.3).
     * @returns `{ kind: 'quiet'|'partial', status, result, items, reason }`.
     */
    async function performStopTree(deps) {
      const { stopAll, sessionId, plan, config, signal, logger } = deps
      const deadline = Date.now() + FLOW_DEADLINE_MS
      let lastStatus = null
      let result = null

      const requestId = createRequestId()
      const first = await issueStop(deps, requestId, undefined, deadline)

      if (first.ok !== true) {
        // Transport failure: reconcile before declaring anything (plan §9).
        lastStatus = await fetchStatusSafe(stopAll, sessionId, signal, logger)
        if (lastStatus !== null && lastStatus.active === false) {
          return { kind: 'quiet', status: lastStatus, result: null, items: [], reason: 'reconciled' }
        }
        return {
          kind: 'partial',
          status: lastStatus,
          result: null,
          items: remainingLabels(lastStatus),
          reason: 'transport',
        }
      }

      result = first.value
      const firstFailed = failedLabels(result)
      if (firstFailed.length > 0) {
        lastStatus = await fetchStatusSafe(stopAll, sessionId, signal, logger)
        return { kind: 'partial', status: lastStatus, result, items: firstFailed, reason: 'result' }
      }
      if (result !== null && result !== undefined && result.ok === false) {
        lastStatus = await fetchStatusSafe(stopAll, sessionId, signal, logger)
        if (lastStatus !== null && lastStatus.active === false) {
          return { kind: 'quiet', status: lastStatus, result, items: [], reason: 'reconciled' }
        }
        return {
          kind: 'partial',
          status: lastStatus,
          result,
          items: remainingLabels(lastStatus),
          reason: 'result',
        }
      }

      // `config` arrives already extracted (`{ settleTimeoutMs, autoReissue }`),
      // while `result` / `lastStatus` are status-shaped sources; normalize the first.
      const effective = resolveConfig({ config }, result, lastStatus)
      const offsets = watchOffsets(effective.settleTimeoutMs)
      const watchStartedAt = Date.now()
      let reissues = 0

      for (const offset of offsets) {
        const targetTime = watchStartedAt + offset
        if (targetTime > deadline) break
        await delay(targetTime - Date.now(), signal)

        const current = await fetchStatusSafe(stopAll, sessionId, signal, logger)
        if (current === null) continue
        lastStatus = current
        if (current.active === false) {
          return { kind: 'quiet', status: current, result, items: [], reason: 'quiet' }
        }

        const mayReissue = effective.autoReissue !== false && reissues < MAX_REISSUE
        if (mayReissue && sameTurnStillRunning(current, plan)) {
          reissues += 1
          const retryRequestId = createRequestId()
          const retried = await issueStop(deps, retryRequestId, requestId, deadline)
          if (retried.ok === true) {
            result = retried.value
            const retryFailed = failedLabels(result)
            if (retryFailed.length > 0) {
              const fresh = await fetchStatusSafe(stopAll, sessionId, signal, logger)
              return {
                kind: 'partial',
                status: fresh === null ? lastStatus : fresh,
                result,
                items: retryFailed,
                reason: 'result',
              }
            }
          }
          if (Date.now() >= deadline) break
        }
      }

      const finalStatus = lastStatus === null
        ? await fetchStatusSafe(stopAll, sessionId, signal, logger)
        : lastStatus
      if (finalStatus !== null && finalStatus.active === false) {
        return { kind: 'quiet', status: finalStatus, result, items: [], reason: 'quiet' }
      }
      return {
        kind: 'partial',
        status: finalStatus,
        result,
        items: remainingLabels(finalStatus),
        reason: 'timeout',
      }
    }

    /* --------------------------------------------------------------- *
     * Presentation.
     * --------------------------------------------------------------- */

    /** Three stacked rounded squares — deliberately unlike the native stop square. */
    function stopAllIcon() {
      return h('svg', {
        viewBox: '0 0 16 16',
        width: 16,
        height: 16,
        'aria-hidden': true,
        focusable: 'false',
        style: { display: 'block', pointerEvents: 'none' },
      },
        h('rect', { x: 1, y: 1, width: 7, height: 7, rx: 2, fill: 'currentColor', opacity: 0.32 }),
        h('rect', { x: 4.5, y: 4.5, width: 7, height: 7, rx: 2, fill: 'currentColor', opacity: 0.6 }),
        h('rect', { x: 8, y: 8, width: 7, height: 7, rx: 2, fill: 'currentColor' }),
      )
    }

    const styles = {
      button: {
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        padding: 0,
        margin: 0,
        border: 'none',
        borderRadius: 'var(--dsw-radius-sm)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        lineHeight: 0,
        flex: 'none',
        transition: 'background-color 120ms ease, opacity 120ms ease',
      },
      buttonHover: {
        background: 'var(--dsw-alias-interactive-bg-hover)',
      },
      buttonStopping: {
        color: 'var(--dsw-alias-label-tertiary)',
        cursor: 'default',
        opacity: 0.65,
      },
      buttonPartial: {
        color: 'var(--dsw-alias-state-error-primary)',
      },
      badge: {
        position: 'absolute',
        top: -3,
        right: -3,
        minWidth: 13,
        height: 13,
        padding: '0 3px',
        boxSizing: 'border-box',
        borderRadius: 'var(--dsw-radius-md)',
        background: 'var(--dsw-alias-state-error-primary)',
        color: '#fff',
        fontSize: 9,
        lineHeight: '13px',
        fontWeight: 600,
        textAlign: 'center',
        pointerEvents: 'none',
      },
      spinnerWrap: {
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
      },
      spinner: {
        display: 'block',
        width: 20,
        height: 20,
        boxSizing: 'border-box',
        borderRadius: '50%',
        border: '1.5px solid currentColor',
        borderTopColor: 'transparent',
        opacity: 0.9,
        animation: 'stop-all-spin 0.8s linear infinite',
      },
    }

    /** Inject the spin keyframes exactly once per document. */
    function ensureSpinStyle(logger) {
      try {
        if (typeof document === 'undefined' || document === null) return
        const head = document.head
        if (head === undefined || head === null) return
        if (document.querySelector('style[data-stop-all-style]') !== null) return
        const style = document.createElement('style')
        style.setAttribute('data-stop-all-style', '')
        style.textContent = '@keyframes stop-all-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'
        head.appendChild(style)
      } catch (error) {
        logger?.warn?.('stop-all: spin keyframes injection failed', error)
      }
    }

    /** Defensive translate for the (unexpected) case a locale seat is absent. */
    function fallbackTranslate(key) {
      return typeof key === 'string' ? key : ''
    }

    /**
     * Build the memoized button component for one plugin instance.
     * @param deps.stopAll - `{ status, stop }` bound to the mounted Remote namespace.
     * @param deps.sessions - optional session-list service (`ctx.get('sessions')`).
     * @param deps.logger - client logger.
     */
    function createStopAllButton(deps) {
      const { stopAll, logger } = deps

      function StopAllButtonImpl(props) {
        const {
          sessionId,
          useSession,
          useInput,
          useProjection,
          t,
          sessions: injectedSessions,
        } = props
        const sessions = injectedSessions === undefined ? deps.sessions : injectedSessions
        const translate = typeof t === 'function' ? t : fallbackTranslate

        /* ---- standard session props (hooks are always called) ---- */
        const running = useSession((state) => state?.running === true)
        const subagent = useSession((state) => {
          const value = state?.subagent
          return value === undefined ? null : value
        })
        const queue = useInput((state) => (Array.isArray(state?.queue) ? state.queue.length : 0))
        const teamProjection = useProjection('agentTeam')
        const isRootHint = subagent === null

        const teamProjectionKey = useMemo(() => {
          if (teamProjection === undefined || teamProjection === null) return ''
          try {
            return JSON.stringify(teamProjection)
          } catch (error) {
            return ''
          }
        }, [teamProjection])

        /* ---- state machine ---- */
        const [status, setStatus] = useState(null)
        const [phase, setPhase] = useState('idle')
        const [partialItems, setPartialItems] = useState(null)
        const [hovered, setHovered] = useState(false)

        const mountedRef = useRef(true)
        const sessionIdRef = useRef(sessionId)
        const statusRef = useRef(null)
        const phaseRef = useRef('idle')
        const flowRef = useRef(null)
        const refreshRef = useRef(null)
        const refreshSeqRef = useRef(0)
        const stoppingSinceRef = useRef(0)
        const lastClickRef = useRef(0)
        const runningFirstRef = useRef(true)
        const teamFirstRef = useRef(true)

        const applyStatus = useCallback((value) => {
          statusRef.current = value
          setStatus(value)
        }, [])

        const applyPhase = useCallback((value) => {
          phaseRef.current = value
          setPhase(value)
        }, [])

        /* ---- status refresh (mount, session, running flip, focus, list, team mode) ---- */
        const refresh = useCallback(async () => {
          const target = sessionIdRef.current
          if (typeof target !== 'string' || target === '') return null
          const previous = refreshRef.current
          refreshSeqRef.current += 1
          const seq = refreshSeqRef.current
          const controller = new AbortController()
          refreshRef.current = controller
          if (previous !== null) {
            try {
              previous.abort()
            } catch (error) {
              // Ignore: aborting an already-settled fetch is a no-op.
            }
          }
          try {
            const response = await callWithTimeout(
              () => stopAll.status({ sessionId: target }, controller.signal),
              STATUS_CALL_TIMEOUT_MS,
              controller.signal,
            )
            if (seq !== refreshSeqRef.current || mountedRef.current !== true) return null
            const value = (response !== null && typeof response === 'object' && response.ok === true)
              ? (response.value === undefined ? null : response.value)
              : null
            if (value === null) {
              if (response !== null && typeof response === 'object' && response.ok !== true) {
                logger?.warn?.('stop-all: status request failed', response.error)
              }
              // "No status" hides the button, but never yanks it out of a stop.
              if (phaseRef.current !== 'stopping') applyStatus(null)
              return null
            }
            if (phaseRef.current === 'partial' && value.active === false) {
              applyStatus(value)
              setPartialItems(null)
              applyPhase('idle')
              return value
            }
            applyStatus(value)
            return value
          } catch (error) {
            if (controller.signal.aborted === true) return null
            if (seq === refreshSeqRef.current && mountedRef.current === true) {
              logger?.warn?.('stop-all: status request failed', error)
              if (phaseRef.current !== 'stopping') applyStatus(null)
            }
            return null
          } finally {
            if (refreshRef.current === controller) refreshRef.current = null
          }
        }, [applyStatus, applyPhase])

        /* ---- the stop flow behind the button ---- */
        const startFlow = useCallback(async (target) => {
          if (flowRef.current !== null) return
          const controller = new AbortController()
          flowRef.current = controller
          stoppingSinceRef.current = Date.now()
          applyPhase('stopping')

          const plan = planFromStatus(statusRef.current)
          const config = resolveConfig(statusRef.current)
          let outcome = null
          try {
            outcome = await performStopTree({
              stopAll,
              sessionId: target,
              plan,
              config,
              signal: controller.signal,
              logger,
            })
          } catch (error) {
            if (controller.signal.aborted !== true) {
              logger?.warn?.('stop-all: stop flow failed', error)
              outcome = { kind: 'partial', status: null, result: null, items: [], reason: 'error' }
            }
          } finally {
            if (flowRef.current === controller) flowRef.current = null
          }

          if (controller.signal.aborted === true || mountedRef.current !== true) return
          if (sessionIdRef.current !== target) return

          // Hold `stopping` for at least MIN_STOPPING_MS so the click is felt.
          const remaining = MIN_STOPPING_MS - (Date.now() - stoppingSinceRef.current)
          if (remaining > 0) {
            try {
              await delay(remaining, controller.signal)
            } catch (error) {
              return
            }
          }
          if (controller.signal.aborted === true || mountedRef.current !== true) return
          if (sessionIdRef.current !== target) return

          if (outcome === null) {
            outcome = { kind: 'partial', status: null, result: null, items: [], reason: 'error' }
          }

          // The watch outcome is fresher than any UI refresh still in flight;
          // discard that one so a stale snapshot cannot overwrite it.
          const inFlightRefresh = refreshRef.current
          if (inFlightRefresh !== null) {
            refreshRef.current = null
            refreshSeqRef.current += 1
            try {
              inFlightRefresh.abort()
            } catch (error) {
              // Ignore: already settled.
            }
          }

          if (outcome.kind === 'quiet') {
            applyStatus(outcome.status === undefined ? null : outcome.status)
            setPartialItems(null)
            applyPhase('idle')
            return
          }
          if (outcome.status !== null && outcome.status !== undefined) applyStatus(outcome.status)
          setPartialItems({ items: Array.isArray(outcome.items) ? outcome.items : [] })
          applyPhase('partial')
        }, [applyPhase, applyStatus])

        const handleClick = useCallback(() => {
          if (phaseRef.current === 'stopping') return
          const target = sessionIdRef.current
          if (typeof target !== 'string' || target === '') return
          const now = Date.now()
          if (now - lastClickRef.current < CLICK_DEBOUNCE_MS) return
          lastClickRef.current = now
          void startFlow(target)
        }, [startFlow])

        const handleEnter = useCallback(() => setHovered(true), [])
        const handleLeave = useCallback(() => setHovered(false), [])

        /* ---- effects ---- */
        useEffect(() => {
          mountedRef.current = true
          ensureSpinStyle(logger)
          return () => {
            mountedRef.current = false
            refreshSeqRef.current += 1
            const flow = flowRef.current
            flowRef.current = null
            if (flow !== null) {
              try {
                flow.abort()
              } catch (error) {
                // Ignore: already aborted.
              }
            }
            const pending = refreshRef.current
            refreshRef.current = null
            if (pending !== null) {
              try {
                pending.abort()
              } catch (error) {
                // Ignore: already aborted.
              }
            }
          }
        }, [])

        useEffect(() => {
          sessionIdRef.current = sessionId
          statusRef.current = null
          setStatus(null)
          applyPhase('idle')
          setPartialItems(null)
          void refresh()
          return () => {
            const flow = flowRef.current
            if (flow !== null) {
              flowRef.current = null
              try {
                flow.abort()
              } catch (error) {
                // Ignore: already aborted.
              }
            }
          }
        }, [sessionId, refresh, applyPhase])

        useEffect(() => {
          if (runningFirstRef.current === true) {
            runningFirstRef.current = false
            return
          }
          void refresh()
        }, [running, refresh])

        useEffect(() => {
          if (typeof window === 'undefined' || window === null
            || typeof window.addEventListener !== 'function') return undefined
          const onFocus = () => {
            void refresh()
          }
          window.addEventListener('focus', onFocus)
          return () => window.removeEventListener('focus', onFocus)
        }, [refresh])

        useEffect(() => {
          if (isRootHint !== true) return undefined
          if (teamFirstRef.current === true) {
            teamFirstRef.current = false
            return undefined
          }
          // Team-mode flips only trigger a re-fetch; the Host stays authoritative.
          void refresh()
          return undefined
        }, [teamProjectionKey, isRootHint, refresh])

        useEffect(() => {
          const list = sessions?.list
          if (list === undefined || list === null || typeof list.subscribe !== 'function') return undefined
          let timer = null
          const onListChange = () => {
            if (timer !== null) clearTimeout(timer)
            timer = setTimeout(() => {
              timer = null
              void refresh()
            }, 300)
          }
          let unsubscribe = null
          try {
            unsubscribe = list.subscribe(onListChange)
          } catch (error) {
            logger?.warn?.('stop-all: session list subscription failed', error)
            return undefined
          }
          return () => {
            if (timer !== null) clearTimeout(timer)
            if (typeof unsubscribe === 'function') {
              try {
                unsubscribe()
              } catch (error) {
                // Ignore: the list store is already gone.
              }
            }
          }
        }, [sessions, refresh])

        /* ---- render decisions ---- */
        const stopping = phase === 'stopping'
        const partial = phase === 'partial'

        // Composed even while hidden so every hook runs unconditionally.
        const tooltip = useMemo(() => {
          if (stopping) return translate('button.stopping')
          if (partial) {
            const items = formatItems(Array.isArray(partialItems?.items) ? partialItems.items : [])
            const base = items === ''
              ? translate('button.partial')
              : translate('button.partialTooltip', { items })
            return `${base}\n${translate('button.retry')}`
          }
          const subagents = status?.descendants?.length ?? 0
          const jobs = status?.jobs?.length ?? 0
          const lines = [translate('button.tooltip', { subagents, jobs })]
          if (status?.isRootPage !== true) lines.push(translate('button.tooltip.subagentPage'))
          if (queue > 0) lines.push(translate('button.tooltip.queue', { count: queue }))
          lines.push(translate('button.tooltip.irreversible'))
          return lines.join('\n')
        }, [stopping, partial, partialItems, status, queue, translate])

        let hidden
        if (partial) {
          hidden = status !== null && status.visible === false
        } else if (stopping) {
          hidden = false
        } else {
          hidden = !(status !== null && status.visible !== false && status.active === true)
        }
        if (hidden) return null

        const count = (status?.descendants?.length ?? 0) + (status?.jobs?.length ?? 0)
        const ariaLabel = stopping
          ? translate('button.stopping')
          : partial
            ? translate('button.partial')
            : translate('button.aria')

        const badge = partial ? '!' : (count > 0 ? String(count) : null)
        const buttonState = partial ? 'partial' : (stopping ? 'stopping' : 'armed')

        const buttonStyle = Object.assign({}, styles.button,
          partial ? styles.buttonPartial : null,
          stopping ? styles.buttonStopping : null,
          hovered && !stopping ? styles.buttonHover : null)

        const buttonProps = {
          type: 'button',
          'data-stop-all': buttonState,
          'data-stop-all-active': status?.active === true ? 'true' : 'false',
          'aria-label': ariaLabel,
          'aria-busy': stopping || undefined,
          disabled: stopping,
          onClick: handleClick,
          onMouseEnter: handleEnter,
          onMouseLeave: handleLeave,
          onFocus: handleEnter,
          onBlur: handleLeave,
          style: buttonStyle,
        }

        const Tooltip = primitives?.Tooltip
        if (Tooltip === undefined || Tooltip === null) {
          // No primitives seat: keep the button usable and expose the text natively.
          buttonProps.title = tooltip
        }

        const button = h('button', buttonProps,
          stopAllIcon(),
          stopping
            ? h('span', { style: styles.spinnerWrap, 'aria-hidden': true }, h('span', { style: styles.spinner }))
            : null,
          badge !== null
            ? h('span', { style: styles.badge, 'aria-hidden': true }, badge)
            : null,
        )

        if (Tooltip === undefined || Tooltip === null) return button
        return h(Tooltip, {
          label: tooltip,
          side: 'top',
          delayMs: 300,
          maxWidth: 320,
          portal: true,
        }, button)
      }

      const StopAllButton = React.memo(StopAllButtonImpl)
      StopAllButton.displayName = 'StopAllButton'
      return StopAllButton
    }

    /* --------------------------------------------------------------- *
     * Plugin entry.
     * --------------------------------------------------------------- */

    function optionalService(ctx, name) {
      try {
        if (typeof ctx.get !== 'function') return undefined
        return ctx.get(name)
      } catch (error) {
        return undefined
      }
    }

    return {
      name: 'dsh-stop-all',
      inject: ['slots', 'locale', 'remote'],
      async apply(ctx) {
        const disposers = []
        const logger = ctx.logger

        // Mount the Host Remote contribution first; without it there is no
        // `ctx.remote.stopAll` and every registration below stays dormant.
        try {
          disposers.push(await ctx.remote.$mount(stopAllContribution(z)))
        } catch (error) {
          logger?.warn?.('stop-all: remote contribution mount failed', error)
        }

        try {
          ctx.effect(() => ctx.locale.register(NS, dictionaries), 'stop-all: dictionaries')
        } catch (error) {
          logger?.warn?.('stop-all: locale dictionaries registration failed', error)
        }

        let translate = fallbackTranslate
        try {
          translate = ctx.locale.bind(NS)
        } catch (error) {
          logger?.warn?.('stop-all: locale binding failed', error)
        }

        // A dotted service (`remote.stopAll`) is readable only from a context that
        // injected it, so each caller binds the namespace inside its own inject
        // callback instead of reaching through the entry context.
        const sessions = optionalService(ctx, 'sessions')

        // Button: the sanctioned composer-tool-row group shared with the native stop.
        ctx.inject(['remote.stopAll'], (scope) => {
          const stopAll = {
            status: (request, signal) => scope.remote.stopAll.status(request, signal),
            stop: (request, signal) => scope.remote.stopAll.stop(request, signal),
          }
          const Button = createStopAllButton({ stopAll, sessions, logger })
          try {
            scope.effect(() => scope.slots.register(
              {
                name: 'conversation.input.right',
                id: 'stop-all',
                locale: NS,
                inject: () => ({ sessions }),
              },
              Button,
            ), 'stop-all: button slot')
          } catch (error) {
            logger?.warn?.('stop-all: button slot registration failed', error)
          }
        })

        // Shortcut: optional, never allowed to break the button (plan §4.2).
        ctx.inject(['shortcuts', 'remote.stopAll'], (scope) => {
          const stopAll = {
            status: (request, signal) => scope.remote.stopAll.status(request, signal),
            stop: (request, signal) => scope.remote.stopAll.stop(request, signal),
          }
          // Same stop entry as the button click, independent of any mounted component.
          const trigger = async (target) => {
            if (typeof target !== 'string' || target === '') return
            const controller = new AbortController()
            try {
              const current = await fetchStatusSafe(stopAll, target, controller.signal, logger)
              await performStopTree({
                stopAll,
                sessionId: target,
                plan: planFromStatus(current),
                config: resolveConfig(current),
                signal: controller.signal,
                logger,
              })
            } catch (error) {
              if (controller.signal.aborted !== true) {
                logger?.warn?.('stop-all: shortcut stop failed', error)
              }
            }
          }
          try {
            scope.effect(() => scope.shortcuts.register({
              id: 'stop-all',
              label: () => translate('shortcut.label'),
              aliases: [],
              defaults: {},
              regions: ['page', 'editable'],
              modals: [],
              resolve(context) {
                const element = context?.target?.closest?.('[data-conversation-session]')
                const id = element?.dataset?.conversationSession
                if (typeof id !== 'string' || id === '') return { status: 'pass' }
                return {
                  status: 'handled',
                  run: () => {
                    void trigger(id)
                  },
                }
              },
            }), 'stop-all: shortcut')
          } catch (error) {
            logger?.warn?.('stop-all: shortcut registration failed', error)
          }
        })

        return async () => {
          for (const dispose of disposers.reverse()) {
            try {
              await dispose()
            } catch (error) {
              logger?.warn?.('stop-all: remote contribution dispose failed', error)
            }
          }
        }
      },
    }
  },
})
