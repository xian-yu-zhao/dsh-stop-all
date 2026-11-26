# Changelog

All notable changes to `dsh-stop-all` are documented here. This project follows
[Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-11-26

First release.

### Added

- Toolbar button in `conversation.input.right` (the native stop's group) that
  stops the whole conversation tree in one click, with a count badge and a
  tooltip portalled to `document.body`. No confirmation dialog; a 600 ms click
  lock guards against double taps.
- Host plugin `stop-all` (`lib/index.js`, Cordis feature plugin, `inject =
  ['agents']`) and browser half `client.js` (`window.__ModuleLoader__.load`).
  Pure increment: no built-in package and no other plugin is modified.
- Remote namespace `stopAll`:
  - `status({ sessionId })` — read-only tree snapshot (root, running
    descendants, tree members' running/stopping jobs, `active`, `teamMode`,
    `visible`, `partialTree`, plus the `config` slice the browser's watching
    loop needs: `settleTimeoutMs`, `autoReissue`).
  - `stop({ sessionId, requestId, retryOf? })` — stops the root turn, every
    running subagent at any depth, and tree members' running/stopping jobs.
    Partial failure is returned as data (`requested` / `failed` /
    `coverageGaps` / `reissued` / `degraded`), never thrown. A target the
    verification pass catches and re-issues is reported as `reissued` (normal,
    because an interrupt is fire-and-return); only unrecoverable leftovers stay
    in `coverageGaps`.
- Optional shortcut command `stop-all`, registered with no default key binding;
  registration failure is only logged.
- Stop pipeline: one synchronous tick for root → subagents → jobs (per-target
  `try/catch`, running targets only, so a quiet re-click requests nothing), a
  best-effort catalog pass over `subagents.listDescendants` (≤2 s, gated on the
  tree actually having activity), and a read-only `workspace/session-activity`
  verification that re-issues missed `subagent`/`job` targets and warns
  `stop-all: coverage-gap`. `schedule` items are always ignored.
- `requestId` idempotency cache (in memory, 200 entries, 60 s): replay returns
  the cached result; `retryOf` re-issues only planned targets whose turn id is
  unchanged.
- Root resolution with a header-chain fallback: `ctx.agents.get()` miss →
  `stop-all/not-found` (never resumed); a live parent walk produces the highest
  reachable ancestor and sets `partialTree`.
- Tests: `test/smoke.mjs` covers root resolution, tree membership, the request
  cache, job target selection, coverage gaps, the turn table, and config
  normalisation without a GUI or Host; `test/integration.mjs` loads the Host
  half against a fake Cordis context and asserts the published service, the
  exact native root cancel, the user interrupt, job ownership filtering, the
  catalog fallback, coverage re-issue, the idempotency cache, the error codes,
  and the quiet-tree "request nothing" rule. `npm run verify` runs both.

### Behavior

- The root turn uses the native stop's exact call,
  `cancel({kind:'user'}, {keepInbox:true})`; queued input is kept and resumes by
  the native rules.
- Subagents are interrupted via `subagents.interrupt(id, {kind:'user'})`;
  resident subagents are not disposed and their slots are not released.
- Jobs are killed with `jobs.kill(id, owner, 'stop-all')`; owner-less jobs are
  never touched, targets are deduplicated by id.
- Scheduled tasks, queued input, resident subagents, and team-janitor state are
  unchanged. No `workspace/session-stop` event is dispatched, no
  `drainDescendants` call is made, and no plugin-specific session events are
  written. Each stopped member records exactly one `turn/end` with
  `aborted/user`.
- Interruption is irreversible: tool side effects already performed are not
  undone (same as the native stop).
- The root conversation can speak again right after a stop, and that is DSH's
  behaviour rather than this plugin's: when a stopped subagent settles, the
  subagent runtime splices a `subagent-settled` notice into the parent session
  as an inbox message (`role: "user"`, `form: "notice"`,
  `stopReason: "aborted"`), and a non-empty inbox starts a new turn in the idle
  parent. Observed in a real click as `turn/end completed` →
  `agent/inbox/spliced {target: "next-turn", source.kind: "subagent-settled"}`
  → `turn/start`. The plugin cancels, interrupts and kills only: it posts no
  message and has no channel to withhold runtime notices, so this wake-up is
  neither caused nor suppressible here. It also does not break the "no
  auto-start on an empty queue" rule — the inbox genuinely had that notice.

### Notes

- Display precondition: with the default `requireTeamMode: true`, the button
  appears only in trees whose team mode is on (per root session, off by
  default). Known tradeoff: a plain `subagent` does not need team mode, so
  "never enabled but children spawned" and "team mode switched off mid-run"
  leave the button hidden and fall back to the native stop (main turn only).
  This is intentional; set `requireTeamMode: false` to widen the display
  without changing code.
- `stop` is not gated by team mode: a request that reaches the Host (e.g. via a
  user-bound shortcut) executes whenever the tree has activity.
- Configuration (patch row `config`, applied on plugin reload):
  `includeJobs` (`true`), `catalogPass` (`true`), `autoReissue` (`true`),
  `settleTimeoutMs` (`8000`), `killReason` (`'stop-all'`),
  `requireTeamMode` (`true`).
- Installation is two registrations in `~/.dsh/profiles/desktop/package.json`:
  a `link:` dependency and the package name in `dsh.profile.bundles`. The
  `insert` row stays in this package's own `cordis.patch.yml`; a duplicate id
  in the profile patch is rejected. Do not add `engines.dsh`.
