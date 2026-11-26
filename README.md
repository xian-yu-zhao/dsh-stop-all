# dsh-stop-all

One click stops the whole conversation tree in DeepSeek Harness — the main turn, every running subagent at any depth, and the background jobs that tree's members own — with the native stop's exact semantics.

*中文定位：把「原生停止」从主对话扩展到整棵对话树；只停工作，不动排队输入与定时任务。*

Package `dsh-stop-all` · v0.1.0 · MIT · author xian-yu-zhao · built for DSH 44.7.0 (internal packages 0.2.2-rc.5)

## Why

The native stop button stops the current turn of one conversation. Once the main conversation has delegated work, stopping it leaves its children running, and there is no single control that says "stop this whole tree". `dsh-stop-all` adds that control. It resolves the tree from the Host's authoritative live-agent registry — not from whatever the browser happens to have loaded — then issues the same primitive the native button uses for the root, the subagent runtime's user interrupt for children, and a job kill for background work.

**中文说明：** 原生停止只停当前会话的一轮；本插件把同样的语义扩展到整棵树，覆盖面由宿主权威判定，而不是浏览器已加载的列表。

## Install

| Source | Status | How |
|---|---|---|
| Local checkout (`link:`) | Recommended | Register the link dependency and add the bundle name (below) |
| npm registry | Not published | Install from the local directory instead |

Two registrations are required, both in the desktop profile manifest; the `insert` row comes only from this package's own `cordis.patch.yml`.

In `~/.dsh/profiles/desktop/package.json`:

```json
{
  "dependencies": {
    "dsh-stop-all": "link:D:/dsh-stop-all"
  },
  "dsh": {
    "profile": {
      "bundles": ["...existing entries...", "dsh-stop-all"]
    }
  }
}
```

- Do **not** add a `stop-all` row to the profile's `cordis.patch.yml`. The row already lives in this package's `cordis.patch.yml`, and a duplicate id is rejected by the loader: `entry <id> already exists in the target tree`.
- The profile reads both changes on its next load.

**中文说明：** 登记分两处、缺一不可：`dependencies` 里加 link 依赖、`dsh.profile.bundles` 里追加包名；insert 行只在本包自带的 `cordis.patch.yml`，不要再往 profile 的 patch 里加。

## Requirements

- DSH 44.7.0 desktop profile. The Host half is a Cordis feature plugin (`name = 'stop-all'`, `inject = ['agents']`).
- `subagents`, `jobs`, and `agentTeams` are optional Host services, read with `ctx.get()`; when one is missing the matching capability degrades instead of failing.
- The Host half imports no `@deepseek-ai/*` package (the profile does not expose them to plugin runtime imports). The browser half uses only seed modules: `react`, `zod`, and `@deepseek-ai/dsh-client-ui-primitives`.
- Only `engines.node` is declared. Do not add `engines.dsh`: DSH's version gate compares it with its package version (`0.2.2-rc.5`), so a range such as `>=44.7.0` makes the profile refuse to load.

**中文说明：** 宿主半只强依赖 `agents`，`subagents`/`jobs`/`agentTeams` 缺失时按能力降级；不要写 `engines.dsh`。

## Advantages

| Advantage | What it buys you |
|---|---|
| One action, whole tree | Root turn + every running subagent at any depth + tree members' jobs, requested in a single synchronous tick |
| Native stop semantics | The root gets the exact `cancel({kind:'user'}, {keepInbox:true})` call; queued input resumes as after the native button |
| Nothing extra destroyed | No queue flush, no schedule deletion, no subagent disposal, no slot release, no tree sealing, no archive |
| Truthful job termination | Jobs are killed with reason `stop-all`, not the archive path's "session archived" |
| Coverage verification | A best-effort catalog pass plus a read-only activity check re-issue anything missed, and warn on gaps |
| Idempotent remote API | `requestId` replay returns the cached result, so network retries are safe |
| Pure increment | No built-in package or other plugin is modified; disabling or uninstalling rolls back completely |

**中文说明：** 覆盖面、语义与可恢复性三件事分开保证：一次发令、原生语义、可回滚。

## Use cases

- Two subagents are still writing while the root is thinking — one click stops all three; the message queued behind them resumes as usual.
- The native stop already ended the root but the children keep going — the badge shows the remaining count, and one click finishes them.
- A tree member left a long background job running — it is killed with reason `stop-all`; an unrelated session's job is untouched.
- You are on a subagent's own page and want the whole tree down — the same button, with a tooltip saying it stops the whole tree.
- Scheduled tasks and queued input must survive — they do; only turns and jobs are stopped.

**中文说明：** 典型动作是「根还在想、子代理还在写」「原生停止后子树仍在跑」；按钮出现本身就表示原生停止不够用。

## Tools & Commands

There is no model-facing tool and no slash command: stopping is the user's decision. The surfaces are the toolbar button in `conversation.input.right` (same group as the native stop, icon + count badge, 600 ms click lock, no confirmation dialog, tooltip portalled to `document.body`) and one optional shortcut command.

| Command | Meaning |
|---|---|
| `stop-all` | Shortcut command registered with **no default key binding**; bind it yourself in the shortcut settings. Registration failure is only logged and never blocks the button. |

Remote namespace `stopAll` (browser side `ctx.remote.stopAll`):

| Method | Result |
|---|---|
| `status({ sessionId })` | Read-only: `{ sessionId, rootId, isRootPage, root, descendants, jobs, active, teamMode, visible, partialTree, config }` (`config` carries `settleTimeoutMs` and `autoReissue` for the browser's watching loop) |
| `stop({ sessionId, requestId, retryOf? })` | `{ ok, rootId, requested, failed, killedJobs, partialTree, coverageGaps, reissued, degraded }`; partial failure is a normal return value, not an exception. `reissued` lists targets the read-only verification caught and re-issued (normal — an interrupt is fire-and-return); only a gap the Host could not re-issue stays in `coverageGaps`. |

`requestId` is cached in memory (200 entries, 60 s). Replaying the same id returns the cached result; `retryOf` re-issues only planned targets whose turn id is unchanged. Errors: `stop-all/not-found`, `gateway/bad-request` (empty/invalid `requestId`, or the same id paired with a different `sessionId`), `gateway/cancelled`. A missing Host capability skips its category and is named in `degraded`.

**中文说明：** 唯一入口是按钮与可自行绑定键位的 `stop-all` 命令；`stop` 不受团队模式限制，只要请求到达宿主且有活动就执行。

## Boundaries & limitations

| Does | Deliberately does not |
|---|---|
| Stop the root turn with `cancel({kind:'user'}, {keepInbox:true})` | Discard queued input |
| Interrupt every running subagent, any depth | Dispose subagents or release their slots |
| Kill running/stopping jobs owned by tree members | Touch unowned jobs, other trees, or OS processes |
| Leave exactly one `turn/end → aborted/user` per stopped member | Write any plugin-specific session event |
| Keep schedules, queued input, resident subagents, team-janitor state untouched | Delete schedules, archive sessions, seal the tree, dispatch `workspace/session-stop`, call `drainDescendants` |

- **Irreversible:** interruption cannot be undone. Tool side effects already performed (files written, commands run) are not rolled back — the same as the native stop.
- **Team-mode gate (known tradeoff):** with the default `requireTeamMode: true`, the button renders only when the tree's team mode is on (`agentTeams.isEnabled(root)`, stored per root session, off by default). With team mode off it does not render at all — no placeholder — and the native stop behaves exactly as before install. A plain `subagent` call does not require team mode, so in two cases the button stays hidden while children run: (a) team mode was never enabled but subagents were spawned, (b) team mode was switched off mid-run. Then native stop stops only the main turn. This is intentional per the requirement, not a defect; set `requireTeamMode: false` to widen it, no code change needed.
- **Second condition:** the tree must also have activity besides the root (a running subagent, or a running/stopping job). A root running alone shows no button — native stop is enough.
- No button on archived or removed sessions, and none for sessions outside the tree.
- **The root conversation may speak again right after a stop — by design of DSH, not this plugin.** When a stopped subagent settles, the subagent runtime delivers a `subagent-settled` notice into the parent session as an inbox message (`role: "user"`, `source.kind: "subagent-settled"`, `form: "notice"`, `stopReason: "aborted"`). If the parent is idle at that moment, that non-empty inbox starts a new turn in the parent, so the main conversation appears to resume on its own. Observed log evidence from a real click: `turn/end turn=7 completed` → `agent/inbox/spliced {target: "next-turn", source.kind: "subagent-settled"}` → `turn/start turn=8`. The plugin only cancels, interrupts and kills; it posts no message and cannot intercept runtime notices, so this wake-up is not caused by (and cannot be suppressed from) the plugin. It also does not violate the "no auto-start on an empty queue" rule: the inbox was genuinely non-empty. Keep it in mind when reading transcripts: the extra turn is the runtime reporting that a stopped child settled.

**中文说明：** 中断不可逆是首要限制；团队模式开关是显示前提而非执行前提，`requireTeamMode: false` 可放宽显示。停止后根对话可能自己开口：那是 DSH 子代理运行时把「子代理已结算」通知投递进父会话收件箱触发的正常唤醒，插件只做取消/中断/终止、不发消息，也没有拦截通知的通道。

## Deep mechanics

The Host resolves the root as `ctx.agents.get(sessionId)`; a miss is `stop-all/not-found` and is **never** resumed. A non-subagent session is its own root; otherwise `subagents.rootOf` answers. If that throws, the header's `parentSession` chain is walked through live parents only, the highest reachable ancestor becomes the root, and `partialTree` is set (the resuming `resolveAgent` is deliberately not used).

Execution runs in three passes: ① in one synchronous tick, root → subagents → jobs, each target in its own `try/catch` — only targets that are actually running are requested, so a re-click on a quiet tree returns `ok` with an empty `requested`; ② the best-effort catalog pass (`subagents.listDescendants(rootId)`, ≤2 s) covers what the live registry cannot see: external backend executions (`mode: 'external'`, no local Session) plus any child the read-only activity query still reports as running — settled historical children are skipped, and the pass only runs while the tree has activity, so an idle tree never fabricates targets; ③ the same activity query then verifies the outcome, re-issuing anything still unhandled as `reissued` and keeping only unrecoverable leftovers in `coverageGaps` (`stop-all: coverage-gap` warning); `schedule` items are always ignored.

Job ownership follows `jobs.list(member)`, which returns both owned and owner-less jobs; owner-less jobs are never touched, targets are deduplicated by job id, and `includeJobs: false` turns the whole category off.

The `workspace/session-stop` bus is **not** the mechanism: it discards the root's queued input, deletes scheduled tasks, and records job termination as "session archived", all of which conflict with stop semantics. Only its read-only activity query is borrowed. Acceptance: every stopped member gets exactly one `turn/end aborted/user`; the root does not auto-start a new turn when its queue is empty; disabling or uninstalling the plugin restores the native stop and double-Esc untouched.

Browser side, the namespace is a Cordis service named `remote.stopAll`, and a dotted service is readable only from a Context that injected it: the browser half mounts the contribution in `apply` and then binds `scope.remote.stopAll` inside `ctx.inject(['remote.stopAll'], scope => …)`. Reaching through the entry context instead throws `cannot get property "remote.stopAll" without inject`, which silently hides the button — the trap worth remembering when extending this plugin.

### Configuration

Set in the patch row's `config`; applied when the plugin reloads (no DSH restart).

| Key | Default | Meaning |
|---|---|---|
| `includeJobs` | `true` | Also kill running/stopping jobs owned by tree members |
| `catalogPass` | `true` | Run the best-effort catalog pass |
| `autoReissue` | `true` | Re-issue while the same turn still runs, at most twice |
| `settleTimeoutMs` | `8000` | How long the button keeps watching for quiescence |
| `killReason` | `'stop-all'` | Reason text merged into a killed job's terminal detail |
| `requireTeamMode` | `true` | Render only in team-enabled trees; `false` widens it |

**中文说明：** 树根解析、三遍发令、幂等缓存、与总线的取舍都在这一节；配置改完重载插件即生效。

## Changelog

- **0.1.0** — First release: tree-wide stop button, `stopAll` remote API, coverage verification, configurable team-mode gate. Details in [`CHANGELOG.md`](CHANGELOG.md).

**中文说明：** 只列版本与一行摘要。

## License

MIT © 2026 xian-yu-zhao. See [`LICENSE`](LICENSE).
