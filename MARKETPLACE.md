# Community listing: awesome-dsh-plugin

Status of this plugin's listing in the DSH community store
([awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin),
which serves <https://awesome-dsh-plugin.com/> and storefronts such as dsh-market).

## Where we are

| Step | State |
|---|---|
| Public repo with `dsh.bundle.patch` in `package.json` | ✅ `./cordis.patch.yml` on `main` |
| `cordis.patch.yml` present on the default branch | ✅ |
| Real code, not a placeholder | ✅ `lib/`, `client.js`, tests |
| GitHub topic `dsh-plugin` | ✅ (plus `dsh`, `deepseek-harness`, `cordis`, `subagent`, `stop`) |
| Published on npm | ✅ `dsh-stop-all@0.1.1`, `dist-tags.latest = 0.1.1` |
| Registry entry file | ✅ prepared in the fork branch `add-dsh-stop-all` |
| Pull request to the registry | ⏳ blocked by the repo-age gate (see below) |

## The one blocking rule: repository age

The registry's CI gate rejects submissions whose target repository is younger
than **1 day** (`contributing.md`, "The repo is at least 1 day old"). This
repository was created on 2026-11-26, so a PR opened today fails that check.

The gate verdict is a snapshot and is re-run automatically: a submission blocked
at "0.5 days old" passes on its own once the repository ages, without pushing an
empty commit. So the PR only needs to be *opened* after the gate can pass.

## The entry

`data/plugins/xian-yu-zhao__dsh-stop-all.yml` in the fork
(`xian-yu-zhao/awesome-dsh-plugin`, branch `add-dsh-stop-all`):

```yaml
url: https://github.com/xian-yu-zhao/dsh-stop-all
name: xian-yu-zhao/dsh-stop-all
category: session
description:
  en: 'Stops the whole conversation tree in one click: the main turn, every running subagent at any depth, and the background jobs those sessions own, while queued input and scheduled tasks stay untouched.'
  zh: '一键停止整棵会话树：主对话回合、任意层级的运行中子代理，以及这些会话拥有的后台任务，同时不动排队输入与定时任务。'
```

Notes on the fields:

- `category: session` — the plugin controls a conversation (stops its turn, its
  subagents and their jobs); it does not add tools, UI chrome or automation.
- The `description` contains `: `, so it must stay quoted in YAML.
- `icon:` points at `assets/icon-180.png`, a 180×180 PNG rasterized from
  `icon.svg` — the registry only accepts a GitHub-hosted **raster** image, not a
  vector, so the storefront tile keeps the button's look.
- No `tarball:` — the plugin installs from npm, which the registry maps
  automatically (`npm:` in an entry is rejected).

## Opening the PR

With a token that can write to the fork (a classic token with `repo` scope; the
gh CLI OAuth token used during development lacks `workflow`, which only matters
for workflow files and fork syncing, not for this data-file branch):

```powershell
# 1) open the pull request (head = fork branch, base = registry main)
$body = @{
  title = 'Add xian-yu-zhao/dsh-stop-all'
  head  = 'xian-yu-zhao:add-dsh-stop-all'
  base  = 'main'
  body  = 'Adds `dsh-stop-all`: one composer button that stops the main turn, every running subagent at any depth, and the background jobs those sessions own, with native stop semantics (queued input and scheduled tasks untouched). npm: `dsh-stop-all@0.1.1`.'
} | ConvertTo-Json
Invoke-RestMethod -Uri 'https://api.github.com/repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls' `
  -Headers @{ Authorization = "Bearer $env:GH_TOKEN"; Accept = 'application/vnd.github+json' } `
  -Method Post -Body $body -ContentType 'application/json'
```

Or use the GitHub web UI: open
`https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/compare/main...xian-yu-zhao:add-dsh-stop-all`
and click *Create pull request*.

After the PR runs, check the **Submission gate** check run: it reports the exact
requirement that failed (entry count, `dsh.bundle` manifest, repo age,
`awesome-lint` / site build). Pushing to the same branch fixes issues — no new
PR needed.

## What the repo already satisfies

- One entry per PR (this submission is one file).
- `name` is `owner/repo`, matching the `url`; filename slug matches the `url`.
- `description.en` is a single line ending with a period and states behaviour
  only (no marketing words); `description.zh` provided.
- The npm package's `repository` field points back at this repository, so the
  registry can link the two automatically.
