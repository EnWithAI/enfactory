# Software Factory

An organisation of Claude Code agents. You file GitHub issues, and the org triages, analyses, designs, specs,
architects, builds, reviews, secures, merges, releases, verifies, and watches production. Every decision is recorded in
one shared memory, and the org audits and improves its own process.

```
 issue (label: factory)
   │
   ▼
 triage ─▶ analysis ─▶ [design] ─▶ feature-grooming ─▶ tech-grooming ─▶ build ─▶ review ─▶ security ─▶ merge ─▶ release ─▶ verify ─▶ done
 prioritizer analyst   designer    product-manager 🙋   architect     engineer reviewer  security    CI+gate   release-mgr  sre
                ▲          ▲              ▲                  ▲            ▲  🔁 loops back to whichever stage owns the defect
                └──────────┴──────────────┴──────────────────┴────────────┘
 observability (sre, every 15 min) ─▶ [incident] council (architect, sre, engineer, security, PM) ─▶ routes into the pipeline
 audit (auditor, weekly) ─▶ metrics + proposals ─▶ you approve ─▶ org.yaml / charters change
```

## Install and set up (any user, any product)

One install runs one company working on one product at a time. The agents run on your Claude account and work in your GitHub.

**You need:** macOS or Linux, Node.js 22+, git, the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`, scopes
`repo` and `workflow`), and [Claude Code](https://claude.com/claude-code) logged in. python3 is optional; it's used only to run
staging and production on your own computer.

```bash
git clone https://github.com/EnWithAI/enfactory.git my-factory
cd my-factory
npm install
bin/sf dashboard            # open http://127.0.0.1:4340
```

**Dashboard port.** The default is 4340. If 4340 is taken, the dashboard uses the next free port and prints which one.
To choose the port yourself:

| How | Lasts | If the port is taken |
|---|---|---|
| `sf dashboard --port 5050` | this start | refuses and says so |
| `SF_DASHBOARD_PORT=5050 sf dashboard` | this shell | refuses and says so |
| `dashboard.port: 5050` in `org/org.yaml` | every start | uses the next free port |

Setup saves the port the dashboard was on, so it comes back on the same one.

The dashboard walks you through the rest. You don't need any other commands:

1. **Set up.** It checks this computer, then asks for your company name, your GitHub login (you are the owner and the client)
   and a daily budget. `sf setup --company "Acme" --owner <login> --budget 50` does the same in a terminal.
2. **Start the org.** Setup starts the dispatcher, the process that hands work to agents. The header button shows its state:
   **Pause** (working), **Paused · Resume**, or **Org stopped · Start**. Pausing stops new work. Agents already running finish their stage.
3. **Start an engagement** in the **Client room.** Sales takes your brief, timeline and budget. The analyst clarifies the
   requirements with you, and you approve a proposal. The team then sets up your GitHub repo, studies it, recruits and plans.
   You approve the roadmap and release plan, and the team builds planned releases, one demoable piece at a time.

**What is yours and what is the factory's.** The code (this repo) is shared. Everything your org creates lives in `org/`,
`memory/` and `library/`. That covers your config, agents' memory, decisions, documents and hires. Git ignores those folders here;
the factory versions them in a separate local repo (`.memory.git`), so a `git pull` for factory updates never touches your data.
New installs start from `templates/org/`.

**Memory history is local only.** `.memory.git` commits every change to memory, config and documents, but it has no remote, so
it lives and dies with this computer. For an audit trail that survives the machine (fintech clients will ask), give it a
**private** remote that only you can read, and push it regularly:

```bash
git --git-dir=.memory.git --work-tree=. remote add origin git@github.com:<you>/<install>-memory.git   # a PRIVATE repo
git --git-dir=.memory.git --work-tree=. push -u origin HEAD
```

Memory holds client requirements, decisions and the ledger. Never point it at a public repo or at the factory's code repo.

**CI for the factory itself.** `.github/workflows/ci.yml` runs on every PR to the factory: the tests, `npm audit`, `bash -n`,
shellcheck and a gitleaks history scan, on macOS, with a read-only token and actions pinned to commits. Factory changes from the
pipeline merge only with the owner's approval; CI gives that approval evidence instead of pasted output.

Scoped tool permissions in `org/org.yaml` use `{FACTORY}` for the install folder (for example `Write(/{FACTORY}/memory/specs/*/verify.md)`),
so the same config works on any machine.

## Cost: how the factory keeps token use down

Each agent run is a separate Claude Code session, so there is no shared context to bloat; shared memory is files on disk.
What costs money is **steps**: every step an agent takes re-reads its whole conversation so far. The factory keeps steps and
reruns down, and `economy` in `org/org.yaml` controls it:

| Lever | What it does |
|---|---|
| Packed briefs | The brief already holds the team digest, product brief, current answers, people's comments, the issue history and earlier artifacts (up to `brief_kb`). Agents start working instead of reading. |
| Digests | `org/digests/<team>.md` and `memory/product/brief.md` are short versions of the operating model, charters and product overview. They're rewritten only when a source changes. `answers.current.md` drops superseded answers. |
| Per-task model, effort and cap | `economy.tasks`: the first rule whose `task` prefixes the run label picks the model (e.g. Haiku for triage, Sonnet for approvals and councils), `--effort` and the budget cap. |
| Finish-now | A run that hits its cap gets one short "hand in what you have" turn in the same session instead of being thrown away. |
| Check retries | A spec that fails `spec_lint` is fixed in the same session (`check_retries`), not in a fresh run next tick. |
| Session resume | When work comes back to the same role and stage within `resume_minutes`, the agent continues its earlier session and gets only what changed. |
| Councils | `council_rounds`, and another round only while members disagree on the route. |

The dashboard's **Spend** panel shows cost, steps and tokens by role and by task, the share spent on rework, and each task's
average cost before and after the economy rules started.

## Working from the terminal

```bash
export PATH="$PWD/bin:$PATH"
sf run | sf pause | sf resume  # the dispatcher (the dashboard can start, pause and resume it too)
sf engage --start              # the Client room from the terminal

# Or point the factory at an existing product yourself, skipping the engagement:
# 1. Link the product: one tracker for issues, and every repo that makes up the product (in dependency order)
sf init --name "Acme" --tracker acme/issues --repo api=acme/api --repo web=acme/web --repo infra=acme/infra
#    then set each repo's about / deploy_workflow / health URLs in org/org.yaml

# 2. The org learns the product: studies every repo, writes memory/product/, then asks YOU what the code can't answer
sf discover                 # the owning roles decide the open questions; vendor-only ones become [vendor] issues

# 3. The product owner designs the team for THIS product; the CFO approves hires within the budget
sf recruit

# 4. The agents found the org (charters + operating model)
sf genesis
sf run          # start the factory; leave it running (tmux / launchd / a VM)

sf new "Add dark mode toggle to settings"   # or just label any issue "factory"
sf dashboard    # live floor at http://127.0.0.1:4340: avatars, thought bubbles, flow, hover cards
sf status       # the board
sf report       # metrics
```

## Staffing: recruiting, the CFO, and right-sizing

- **Recruiting** (`sf recruit`): the product owner analyses the product and domain, decides which expertise a top company would
  put on it, and designs specialist roles. Each role gets a mission, skills, a team, the stages it can be assigned to, a model,
  one of the owner's **tool profiles** (`read` / `verify` / `build`), and a product-specific agent prompt. The **CFO** approves,
  trims, or declines each hire against real cost data from the ledger. Hires become agents immediately
  (`.claude/agents/<role>.md` + `org.yaml`).
- **Routing to specialists**: hires join a stage's `pool`. The previous stage picks `next_assignee`; for example, the architect sends a
  storage-heavy build to the durability engineer.
- **Onboarding more agents**: if work waits more than `staffing.wait_minutes` because a role's seats are full, the team lead
  asks the CFO, who adds seats or declines based on the queue, priority, cost, and budget.
- **Releasing agents**: each day the CFO and the product owner discuss the roster (2-round council, CFO decides). Idle seats are
  released, and a specialist role can be let go entirely (0 seats, its work falls back to the stage owner). Stage owners keep at least one seat.
- The owner sets the envelope (`capacity.*`, `staffing.max_headcount_per_role`, `tool_profiles`). The org allocates within it.

## Discovery: the org learns the product

`sf discover` sends the architect into every repo in parallel (read-only). Each writes `memory/product/repos/<name>.md`
covering purpose, stack, architecture, interfaces and contracts with the other repos, data, build and test commands, CI/CD, IaC
and AWS usage, conventions, and risks, citing file paths throughout. The product manager then merges these with recent issues into
`memory/product/overview.md` (users, a mermaid system map, environments, glossary, risks), and consolidates the open questions, each with *why it matters*, a *proposed default*, and the **role that owns it**.
Each owning agent decides its questions (an ADR each). Questions for a role a person holds wait for that person (`sf answer`).
Anything that exists only outside the org becomes a `[vendor]` issue. The overview is rewritten to match. `sf run` re-studies changed repos weekly (`discovery.refresh_days`).

**After setup, agents decide rather than ask.** The only questions that reach people are vendor requests and work for roles
people hold. Anything a person writes on an issue is still saved to `memory/product/answers.md` and handed to the next agent.

## Multiple repos

Issues live in one tracker repo, and code lives in `product.repos`. At tech-grooming, the architect names which repos a change touches.
The engineer gets `workspaces/wt/issue-<n>/<repo>/`, one worktree per repo on the same branch. The dispatcher opens one PR per repo,
cross-linked, and merges them **in config order** (put producers before consumers) only when every PR's CI is green. Then it deploys each
touched repo that has a `deploy_workflow`.

## Environments on your machine

A repo can deploy with a local command instead of a workflow (`deploy_command` in `product.repos`). `deploy/local-static.sh`
builds the default branch, copies it to `~/factory-envs/<repo>/<env>/releases/<sha>`, switches a `current` link, and serves it
on the configured port. It health-checks the page and its JS bundle, and rolls back to the previous release on failure. A failed deploy
sends the issue back to `build` with the log.

`deploy/local-node.sh` does the same for an app with a Node server (enwallet, #64). Usage:
`local-node.sh <name> <env> <port> [--rollback]`. `<env>` is `staging` or `production`, and an empty `<port>` means 4310 for staging and 4311
for production.
- **Root** `${SF_ENV_ROOT:-~/factory-envs}/<name>/<env>`: `releases/<sha>` (dist, server, src/shared), `current` link, `data/` (the store,
  never touched), `deploy.log`, `server.log`, `server.pid`, `VERSION` (last passing deploy) and `VERIFIED` (written by the dispatcher after SRE
  verify). Everything is owner-only. The 5 newest releases are kept, plus VERIFIED and current.
- **Server contract:** `node <root>/current/server/index.mjs` with `HOST=127.0.0.1`, `PORT`, `ENWALLET_DB=<root>/data/enwallet.db`,
  `ENWALLET_SHA=<sha>`; `GET /api/health` returns 200 `{"ok":true,"db":true,"sha":"<sha>"}` (`db` is the boolean `true`). A `HOST` other
  than 127.0.0.1 is refused.
- **Production gate (#60):** a production deploy runs only if staging at `127.0.0.1:${SF_STAGING_PORT:-4310}` reports `ok`, `db` and the
  same sha; otherwise it exits 1 before npm. A production `--rollback` never asks staging. `--rollback` may also be argument 3 (empty
  `<port>`), and Node 26+ is checked before anything runs.
- **Probe:** `/api/health` (ok and sha), `/` and its first `assets/*.js`, on `http://127.0.0.1:<port>` only, 10 tries. A failed probe
  restores the previous release. `--rollback` goes to VERIFIED only, with no build and no fallback.
- **Exit codes:** 0 live, 1 failed (previous release restored, or nothing changed), 2 invalid input (nothing built).

## AWS: deploy and validate

`release` → staging → `verify` → `release` → production → `verify` → done. The release-manager applies `release.policy` to pick
the environment and time, and the dispatcher runs each repo's `deploy.yml` with `-f environment=<env>`. The workflow assumes an AWS role through
**GitHub OIDC**, deploys, smoke-tests `HEALTH_URL`, and **rolls back on failure**. The SRE then validates with a **read-only** AWS
profile: deploy-run status, health URLs, CloudWatch alarms, and ERROR logs (`observability.signals`). It promotes, finishes, or sends a
regression back to `build`. The factory never holds deploy credentials. Setup steps are in `templates/aws/README.md`.

## Genesis: the agents set up the org

`sf genesis` runs four rounds. All output is versioned in git.

1. **Charter.** Each team lead (product, design, engineering, quality, security, SRE) writes `org/charters/<team>.md`:
   mission, ownership, Definition of Ready and Definition of Done per stage, standards (design docs, PR/FAQ, STRIDE, SRE), SLAs, and escalation.
2. **Cross-review.** Every lead reviews every other charter for handoff mismatches and ownership gaps (`memory/threads/genesis/`).
3. **Revise.** Each lead accepts or rejects the feedback, and every acceptance or rejection becomes an ADR.
4. **Operating model.** The chief of staff writes `org/operating-model.md`, covering RACI, handoff contracts,
   the loop-back protocol, decision rights, SLAs, DORA targets, and how the org changes itself. Suggested
   `org.yaml` changes go to `org/proposals/` for you.

Every agent reads its charter and the operating model before each run, so genesis literally shapes how work is done.
Re-run a team with `sf genesis --teams security`.

## How you control it: `org/org.yaml`

| You want | Edit |
|---|---|
| More throughput | `capacity.scale` (×2 doubles every role), or a role's `headcount` |
| Cost ceiling | `budget_usd_per_run`, `daily_budget_usd` |
| Where you approve | `pipeline.<stage>.gate: human`, `gates.merge_by_risk` |
| Go-live rules | `release.policy` (plain English, which the release-manager applies) |
| What prod signals to watch | `observability.signals` (any shell command: Sentry CLI, curl health, Datadog API…) |
| New stage or role | add to `pipeline`, `roles`, and `.claude/agents/<role>.md` |

## People, agents, and vendors

Every role is held by an **agent** unless a person is assigned to it under `people` in `org.yaml`.

| Situation | Who handles it |
|---|---|
| A decision inside a role (scope, design, risk, priority) | The agent holding that role decides and records an ADR |
| Spec approval | `product-owner` (an agent, unless a person holds the role) |
| High-risk merge (second-person approval) | `architect` (configurable per risk tier in `gates.merge_by_risk`) |
| An agent is blocked, or the issue keeps looping | Council of agents chaired by the `chief-of-staff` |
| Something only exists outside the org (credentials, accounts, integrations, purchases) | **Vendor request**: a separate `[vendor]` issue assigned to `vendor: true` people. The original issue pauses (`sf-waiting-vendor`) and resumes when you close the request. Secrets are never put in comments, only *where* they were stored. |
| Runaway (`loops.owner_after`), or a council can't decide | The `owner: true` person, last resort only |

To take a role yourself (or give one to a colleague), add it to their `roles`. That stage or approval then gets assigned to
them on GitHub. They post their work as comments and add `sf-approved`, and their comments become the stage artifact.

## Loops and discussion

- Any agent can send work **upstream**. A code defect goes to `build`, a design flaw to `tech-grooming`, and a requirement change to
  `feature-grooming` or `design`. The `handoff` says exactly what the receiving agent must change.
- From the 2nd loop-back on an issue, the agents involved **hold a council** (2 rounds of positions, then a chair decision)
  instead of one agent deciding alone. After `max_loops`, you're pulled in.
- CI failing at merge requeues the issue to `build`.
- Ad-hoc: `sf council "Should we adopt trunk-based dev?" --members architect,sre,reviewer --chair chief-of-staff`.

## One memory, everything recorded

See `memory/README.md`. The dispatcher is the only writer and commits every tick, so `git log -p memory/` is a full audit
trail. It contains every run (cost, duration, outcome), transition, loop, ADR, learning, deploy, incident, and escalation.
Agents query it with `sf recall "<query>"` and `sf memory issue <n>`.

**Analysed → reviewed → changed:** `sf report` gives throughput, cycle time, loop-backs by stage, cost by role and issue,
and change-fail ratio. The weekly **auditor** reads it plus sampled ADRs and artifacts, writes `memory/reports/audit-*.md`, and
proposes changes in `org/proposals/`. You apply what you agree with, and next week's audit checks if it worked.

## Mapping to the CrewPE pipeline map

| Map station | Here |
|---|---|
| Jira · Linear · GitHub Issues | GitHub Issues via `gh` (`factory/lib/tracker.mjs`; implement the same exports for Jira) |
| Feedback digest · Stale work reviewer | not built yet; add as scheduled jobs like `observe` |
| Thread agent · Story drafter · Req & AC registry | `analyst`, `product-manager` (AC in `memory/specs/issue-n/feature-grooming.md`) |
| Impact & blast radius · Spec refiner · Risk tier scorer | `analyst`, `architect` (`risk_tier` drives the merge gate) |
| CrewPE builder · Requeue on failure | `engineer` in a per-issue git worktree, plus the CI-fail requeue |
| AC validator · Evidence pack · Spec drift detector | `reviewer` (evidence pack per AC, drift check) |
| Review depth by risk tier | `gates.merge_by_risk` |
| Change record writer · Deploy/flags/canary · Second-person approval | `release-manager` + `release.policy` + merge gate |
| Post-merge verifier | `verify` stage (`sre`) |
| Sentry/PagerDuty/Datadog · Alert clustering · Incident triage | `observe` + fingerprint dedupe + `incident` council |
| Factory auditor · Weekly factory report | `sf audit` / `sf report` |
| Knowledge rail | `memory/` + `sf recall` (plug in the CrewPE MCP via `--mcp-config` for the product graph) |

## Safety

- Only `sre` / `release-manager` get AWS (read-only), and every other agent has `AWS_*` stripped. That is not a boundary against an
  agent with a shell reading `~/.aws`, so **use a dedicated host**. See `templates/aws/README.md`.
- Engineers, reviewers, and security get `Bash` inside their worktree, and everything else is read-only. Every unlisted tool
  is denied (`--permission-mode dontAsk`). For unattended use, run `sf run` on a dedicated VM or container with a
  scoped GitHub token (repo + workflow on the product repo only).
- The factory never pushes to the default branch. It merges through PRs with CI and gates.
- Your global rule (latest stable, 0 critical/high/medium vulns) is in the constitution (`CLAUDE.md`), and `security` enforces it.
