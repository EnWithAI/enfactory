# Spec: Issue #2. Foundation: app shell, demo banner, HTTPS staging, CI with audit and compliance searches

Release 1 (enwallet investor demo), work item 1 in `library/engagement/release-plan.md`. P0. Target: 2026-11-25 23:59 IST.
Inputs: `memory/specs/issue-2/analysis.md`, `triage.md`, `library/engagement/{requirements-enwallet,regulatory-scope-and-controls-enwallet,release-plan,proposal-enwallet}.md`, `org/charters/product.md` §3.3 and §8.
- No parent issue.
- No `design.md`: analysis §9 routed past design.
- `memory/product/answers.md`, `ceo-directives.md` and `overview.md` do not exist today (`ls memory/product` → `repos`).

## Delta (v2, 2026-11-25, spec_lint fix)
- No AC was added, removed, or changed in meaning. There are still 17 ACs.
- Tags were rewritten to the form spec_lint parses (`factory/lib/checks.mjs:31`): `[verify: …]` and `[family: …]` on each AC's header line. The Given/When/Then lines are indented under the header so each AC is one block.
- The §4b and §4c tables now start with a row-number column. In v1, rows that began `| AC-2-…` were parsed as 7 extra ACs (24 in total).
- The rows marked `verify: e2e (§4c)` now say `[verify: e2e]`. Each AC's body says whether it is checked after deploy.
- The §9 note on having more than 12 ACs now uses the wording the lint looks for.
- §4a and §4b were re-run in full.

## 1. Customer problem
- P1. Investors may think the demo is a live product with real money (R-06). The "Demo · simulated money" banner must be on every screen and must not be dismissable (R5.1, AC-D1).
- P2. Investors use phones. Screens that scroll sideways at 360 px, or have touch targets smaller than 44 px, make the demo look broken (R5.2).
- P3. The demo site must be HTTPS only and leak no secrets. A fintech demo over HTTP, or with secrets in code, logs or the bundle, breaks the fintech baseline (R7.1, AC-A2, AC-A3).
- P4. Dependencies with known medium-or-worse vulnerabilities must not ship (R7.5, AC-A3).
- P5. The demo must never call real UPI, NPCI or UIDAI services, or any third party (R7.6, AC-D4, AC-P5).
- P6. Showing "₹10,00,000 … as per RBI PPI norms" or a real bank brand ("HDFC") misstates regulation or implies a partnership (R-01, R-02). The client replaced the manual release gate with an automated CI search that must actually fail on a hit (AC-L1, AC-B1).

**Press release.** *Bengaluru, 25 Nov 2026.* Investors who tap the enwallet demo link on their phones land on a secure HTTPS page. Every screen carries a clear "Demo · simulated money" banner that cannot be closed. Each change to enwallet passes four automated gates before it reaches them: build, dependency audit, gitleaks, and a compliance search that blocks wording which misstates RBI rules or borrows a real bank's name. The client gets the gate output instead of a manual review. Every later feature (sign-up, load, pay, home) reuses the shell, the banner and the gates without extra work.

## 2. User stories
- **US-1.** As an investor on a phone, I want every screen to say "Demo · simulated money" so that I never think real money moves.
- **US-2.** As an investor on a 360 px phone, I want screens that fit and are easy to tap so that the demo feels like a real product.
- **US-3.** As the client, I want the staging site served only over HTTPS, with no secrets and no calls to real or third-party services, so that the demo meets the fintech baseline.
- **US-4.** As the client, I want CI to fail any change that adds a medium+ vulnerability, a secret, or the banned wording, so that automated gates replace the manual release review I waived.
- **US-5.** As an engineer on #3–#8, I want a token-driven shell with a shared route list and CI already wired so that my screens inherit the banner, layout tests and compliance gates.

## 3. Acceptance criteria
`ROUTES` means the single shared route-list constant used by the Playwright suites (path chosen by the architect). In #2 it contains every shell route, plus one unknown path that renders the 404 state. #3–#8 append their routes.

Banner copy is contract-fixed by AC-D1 and quoted verbatim. Design (#1) assigns its string ID. The PM does not reword it.

- **AC-2-01 Banner on every screen, not dismissable.** [verify: e2e] [family: ux] · control: AC-D1
  - Given each path in `ROUTES` (including the 404 path) at 360×640,
  - When it renders, and again after a reload, a client-side navigation to the next route, and scrolling to the bottom,
  - Then:
    - the element `[data-testid="demo-banner"]` is visible, and its trimmed `textContent` equals exactly `Demo · simulated money`;
    - it contains 0 descendants matching `button, a, [role=button], [aria-label*=close i]`;
    - the `localStorage.length` and `sessionStorage.length` values are the same before and after any interaction with the banner;
    - the banner has `role="status"` or is in a landmark, so screen readers announce it.

- **AC-2-02 Banner never hides focus or content.** [verify: e2e] [family: a11y] · control: AC-D1
  - Given each route in `ROUTES` at 360×640,
  - When each focusable element (`a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])`) is focused via `Tab`,
  - Then its bounding box has 0 px² intersection with the banner's bounding box (WCAG 2.2 SC 2.4.11 Focus Not Obscured).

- **AC-2-03 No horizontal scroll at 360 px.** [verify: e2e] [family: browser]
  - Given viewport 360×640,
  - When each route in `ROUTES` renders,
  - Then `document.documentElement.scrollWidth <= 360`.

- **AC-2-04 Touch targets at least 44×44.** [verify: e2e] [family: a11y]
  - Given viewport 360×640,
  - When each route in `ROUTES` renders,
  - Then every visible element matching `a, button, input, select, textarea, [role=button]` has a `boundingBox()` with `width >= 44` and `height >= 44`.

- **AC-2-05 Shell is token-driven.** [verify: unit] [family: ux]
  - Given the shell and banner styles,
  - When the CI style check runs over `src/`, excluding only the single tokens file the architect names,
  - Then it finds 0 colour literals matching `#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(`, and the banner colours resolve from CSS custom properties (`var(--…)`), so #1 and #6 restyle by changing tokens only.

- **AC-2-06 HTTP redirects to HTTPS.** [verify: e2e] [family: browser] · control: AC-A2 · post-deploy (§4c)
  - Given the staging host,
  - When `curl -sI http://<staging-host>/` runs,
  - Then the status is `301` or `308`, and the `location:` header begins with `https://<staging-host>/`.

- **AC-2-07 HSTS and cookie flags.** [verify: e2e] [family: browser] · control: AC-A2 · post-deploy (§4c)
  - Given the staging host,
  - When `curl -sI https://<staging-host>/` runs,
  - Then:
    - a `strict-transport-security:` header is present, with `max-age` ≥ `31536000`;
    - every `set-cookie:` header (if any) contains `Secure`, `HttpOnly` and `SameSite=Lax` or `SameSite=Strict`.

- **AC-2-08 Same-origin egress, no mixed content.** [verify: e2e] [family: privacy] · control: AC-P5, AC-D4 · in CI and post-deploy (§4c)
  - Given Playwright with `page.on('request')` recording,
  - When each route in `ROUTES` is loaded over HTTPS,
  - Then:
    - the number of requests whose `new URL(url).origin !== appOrigin` is 0 (data: and blob: URLs exempt);
    - the number of requests with the `http:` scheme is 0;
    - the number of console messages containing `Mixed Content` is 0.

- **AC-2-09 No live UPI, NPCI or UIDAI endpoints in the build.** [verify: unit] [family: privacy] · control: AC-D4
  - Given source and `dist/` after `npm run build`,
  - When the compliance-search script runs its live-endpoint pattern `(npci\.org\.in|uidai\.gov\.in)`, case-insensitive,
  - Then it reports 0 hits, and the CI job exits non-zero on any hit.

- **AC-2-10 Compliance text search (AC-L1, AC-B1).** [verify: unit] [family: ux] · control: AC-L1, AC-B1 (family is interim, see §9)
  - Given the CI compliance job, with these settings:
    - **Patterns** (one script, case-insensitive, multiline): `HDFC`; `as\s+per\s+RBI\s+PPI\s+norms`; `10[,\s.  ]?00[,\s.  ]?000`.
    - **Scope:** `src/`, `public/`, `index.html`, fixtures and seed data, `package.json`; plus all of `dist/` after a production build in the same job (JS, CSS, HTML, `.map`, JSON).
    - **Excluded by explicit path:** the search script itself, the CI workflow file and the positive fixture (AC-2-11); `node_modules/`, `.git/`, `docs/`, `*.md`.
  - When the job runs,
  - Then:
    - it reports 0 hits and exits 0;
    - any hit prints `file:line:match` and exits 1, which fails the PR;
    - the literals `1000000` and `100000000` are printed as a warning that does not gate.

- **AC-2-11 The compliance search can go red (negative control).** [verify: unit] [family: ux] · control: AC-L1, AC-B1
  - Given a positive fixture that contains, one per line: `HDFC`; `hdfc`; `as per RBI PPI norms`; `as per` followed by a line break and then `RBI PPI norms`; `₹10,00,000`; `10 00 000`,
  - When the same script runs with only that fixture in scope,
  - Then it reports ≥ 6 hits and exits 1. The CI job asserts exit code 1 and fails if the control exits 0.

- **AC-2-12 Rendered-text check.** [verify: e2e] [family: ux] · control: AC-L1, AC-B1
  - Given each route in `ROUTES`,
  - When rendered in Playwright,
  - Then `document.body.innerText` matches none of the three AC-2-10 patterns. This catches runtime strings such as `Intl.NumberFormat('en-IN')` output and minifier-split literals.

- **AC-2-13 Dependency audit and latest stable.** [verify: unit] [family: durability] · control: AC-A3
  - Given the CI audit job,
  - When `npm audit --audit-level=moderate` runs after `npm ci`,
  - Then:
    - it exits 0, and the summary reports 0 moderate, 0 high and 0 critical;
    - no version in `package.json` or the lockfile's direct dependencies matches `-(alpha|beta|rc|canary|next|pre)`;
    - `npm outdated --json` lists 0 direct dependencies where `current !== latest`, or each one is listed in the PR with a reason;
    - a medium+ finding with no fix fails the job until a mitigation note is recorded in the PR.

- **AC-2-14 No secrets in code, history, bundle or logs.** [verify: unit] [family: durability] · control: AC-A3 · the logs check runs post-deploy (§4c)
  - Given the CI gitleaks job,
  - When `gitleaks detect --source . --log-opts=--all` and `gitleaks detect --no-git --source dist` run,
  - Then both report `no leaks found` and exit 0, and the job fails on any leak.
  - After deploy, `gitleaks detect --no-git --source <staging deploy-log dir>` reports 0 leaks (R7.1, "no secrets in logs").

- **AC-2-15 CI wiring.** [verify: unit] [family: durability]
  - Given a pull request to the default branch,
  - When CI runs,
  - Then:
    - the four jobs `build`, `audit`, `compliance-search` (AC-2-09/10/11) and `gitleaks` run, plus the Playwright suite (AC-2-01…04, 08, 12);
    - `build` produces `dist/index.html` and ≥ 1 `dist/assets/*.js`. This is the output `deploy/local-static.sh` health-checks today, unless the architect's ADR changes it;
    - a failure in any job marks the PR check red;
    - each gate has one recorded red run (seeded hit, seeded vulnerable dependency, canary secret) linked in the PR.

- **AC-2-16 Staging reachable from a phone.** [verify: e2e] [family: browser] · post-deploy (§4c)
  - Given the staging URL,
  - When `curl -s -o /dev/null -w '%{http_code}' https://<staging-host>/` runs from a machine other than the host,
  - Then:
    - it prints `200`;
    - the hostname resolves to a non-loopback address;
    - the response body contains `Demo · simulated money`, or the served bundle does when the banner is client-rendered.

- **AC-2-17 Post-deploy evidence recorded.** [verify: doc] [family: durability] · control: AC-A2
  - Given SRE verify for #2 has run and written `memory/specs/issue-2/verify.md`,
  - When the two §4b commands run,
  - Then:
    - (a) `grep -c -E '^AC-2-(06|07|08|15|16) PASS$' /opt/factory/memory/specs/issue-2/verify.md` prints `5`;
    - (b) `grep -c -i -E '^strict-transport-security: max-age=[0-9]+' /opt/factory/memory/specs/issue-2/verify.md` prints ≥ `1`.

## 4a. Trace
| Group | Item | AC ids |
|---|---|---|
| Problem | P1 banner, demo mistaken for live | AC-2-01, AC-2-02, AC-2-16 |
| Problem | P2 360 px, touch targets | AC-2-03, AC-2-04 |
| Problem | P3 HTTPS, no secrets | AC-2-06, AC-2-07, AC-2-14, AC-2-17 |
| Problem | P4 vulnerable dependencies | AC-2-13 |
| Problem | P5 no real or third-party services | AC-2-08, AC-2-09 |
| Problem | P6 banned wording, CI gate must fail on hit | AC-2-10, AC-2-11, AC-2-12 |
| Issue body | R5.1 banner cannot be dismissed | AC-2-01, AC-2-02 |
| Issue body | R5.2 360 px, 44 px targets | AC-2-03, AC-2-04 |
| Issue body | R7.1 HTTPS only, no secrets (code and logs) | AC-2-06, AC-2-07, AC-2-14, AC-2-16 |
| Issue body | R7.5 `npm audit --audit-level=moderate` 0 in CI | AC-2-13, AC-2-15 |
| Issue body | R7.6 no real services (real personal data → #3, see §5) | AC-2-08, AC-2-09 |
| Issue body | AC-L1 CI search '10,00,000', 'as per RBI PPI norms', 'HDFC' in source and build → 0 | AC-2-10, AC-2-11, AC-2-12 |
| Story | US-1 | AC-2-01, AC-2-02 |
| Story | US-2 | AC-2-03, AC-2-04 |
| Story | US-3 | AC-2-06, AC-2-07, AC-2-08, AC-2-09, AC-2-14, AC-2-16 |
| Story | US-4 | AC-2-10, AC-2-11, AC-2-13, AC-2-14, AC-2-15 |
| Story | US-5 | AC-2-05, AC-2-15 (shared `ROUTES` in AC-2-01…04) |
| Control (never-cut) | AC-D1 banner, including never hiding focus | AC-2-01, AC-2-02 |
| Control | AC-A2 HTTPS, HSTS, cookies | AC-2-06, AC-2-07, AC-2-17 |
| Control | AC-A3 gitleaks and audit | AC-2-13, AC-2-14 |
| Control | AC-B1 (release-plan CI search part) | AC-2-10, AC-2-11, AC-2-12 |
| Control | AC-D4, AC-P5 egress | AC-2-08, AC-2-09 |

There are 22 rows, none empty.
- No parent issue, so there is no parent-AC group.
- No `design.md`, so there is no states-matrix group. The 404 state is covered through `ROUTES` in AC-2-01, 03 and 04.
- Analysis has no abuse-case section.

## 4b. Verify dry-run (`verify: doc` ACs)
Both commands were re-run on 2026-11-25 (v2) against today's factory tree.

| # | AC clause | Command | Output today | Expected after |
|---|---|---|---|---|
| 1 | AC-2-17 (a) | block 1 | `grep: …/issue-2/verify.md: No such file or directory`, exit 2 | `5`, exit 0 |
| 2 | AC-2-17 (b) | block 2 | `grep: …/issue-2/verify.md: No such file or directory`, exit 2 | ≥ `1`, exit 0 |

Block 1:
```
grep -c -E '^AC-2-(06|07|08|15|16) PASS$' /opt/factory/memory/specs/issue-2/verify.md
```
Block 2:
```
grep -c -i -E '^strict-transport-security: max-age=[0-9]+' /opt/factory/memory/specs/issue-2/verify.md
```
Result: today ≠ expected for 2/2.
- **Red for the right reason:** today's check fails because the evidence does not exist.
- **Partial evidence also fails:** a verify.md with 4 PASS lines and 1 FAIL line prints `4`, not `5`. This case is reasoned, not run, because the PM cannot write a seed file.

## 4c. Post-deploy checks (for SRE verify; architect copies them into the test plan)
| # | Check | Command against staging | Pass |
|---|---|---|---|
| 1 | AC-2-06 | `curl -sI http://<staging-host>/` | `301`/`308`, and `location: https://<staging-host>/` |
| 2 | AC-2-07 | `curl -sI https://<staging-host>/` | HSTS `max-age>=31536000`; cookie flags as stated |
| 3 | AC-2-08 | Playwright egress suite with `BASE_URL=https://<staging-host>` | 0 cross-origin, 0 `http:`, 0 mixed-content |
| 4 | AC-2-16 | `curl -s -o /dev/null -w '%{http_code}' https://<staging-host>/` from a non-host machine | `200` |
| 5 | AC-2-14 (logs) | `gitleaks detect --no-git --source <deploy-log dir>` | no leaks found |

SRE records `AC-2-NN PASS` lines and the raw header block in `memory/specs/issue-2/verify.md` (AC-2-17).

## 5. Non-goals
- Design system, tokens, final visual style → #1. Polish and designer review at 360 px, plus the 320 px reflow check → #6.
- Sign-up, KYC, sessions, server-side authz (AC-K1, R7.3), and the no-real-personal-data part of R7.6 (AC-P1…P5 data handling) → #3.
- Ledger and money → #4. Pay and QR (AC-Q1/Q2) → #5. Camera QR → #7. Handover → #8.
- Choosing the hosting provider and TLS mechanism: architect, at tech-grooming (ADR). The domain or account is vendor request #9.
- AC-B2/B3 brand marks, beyond the 'HDFC' search → #1 (design) per the release plan.

## 6. Edge cases, errors, analytics, metrics
- **Edge cases:**
  - Unknown route → 404 shows the banner (AC-2-01).
  - Rotation or 640 px height with the soft keyboard open → the banner must not cover the focused input (AC-2-02).
  - Strings split across lines or built at runtime → AC-2-10 (multiline) and AC-2-12.
  - `₹` prefix, NBSP or narrow-NBSP digit grouping → AC-2-10 pattern.
  - A source map containing a banned string → in scope (dist `.map`).
  - A cookie-less shell → AC-2-07's cookie clause holds trivially; #3 adds the session cookie and must keep it.
- **Error states:**
  - CI job failure prints the offending `file:line:match` or advisory id.
  - Staging down → AC-2-16 fails, and SRE files an incident.
- **Analytics:** none. AC-P5 forbids third-party scripts, so no tracker is added.
- **Success metrics (measurable):**
  - 4/4 CI gates green on the #2 PR, each with 1 recorded red run.
  - Staging `200` over HTTPS from a phone network before 15:00 IST on 2026-11-25.
  - 0 compliance-search hits on every #3–#8 PR through 23:59 IST.
  - 5/5 §4c lines PASS in verify.md.

## 7. Rollout (product decisions)
- **Dark launch:** no. The staging URL goes to the 10 investors only at the release demo; before then it is shared internally.
- **Wallet data preserved:** yes (there is no wallet data in #2).
- **Comms:**
  - Release-note line: "Secure HTTPS demo site with a permanent 'Demo · simulated money' banner; automated audit, secret and compliance gates on every change."
  - Demo script: open the staging URL on the phone, and point out the banner.

## 8. Path provenance
- `deploy/local-static.sh` exists today (`ls` → `/opt/factory/deploy/local-static.sh`).
- `memory/specs/issue-2/` exists today (`ls` → `analysis.md feature-grooming.md triage.md`).
- `memory/specs/issue-2/verify.md` is SRE output. Convention: `org/charters/sre.md:76` ("artifact `verify.md` in `memory/specs/issue-<n>/`"), `org/charters/product.md:121`, and `org/org.yaml:191`.
- The in-repo enwallet paths (search script, fixture, `ROUTES`, tokens file, workflow) are deliberately left for the architect to name. Analysis proposes `.github/workflows/ci.yml`. No other filename is invented here.

## 9. Notes
- **Exception: 17 ACs, more than 12.** Each issue-body item and each never-cut control (AC-D1, AC-A2, AC-A3, AC-L1/B1, AC-D4/P5) needs its own AC that can be checked mechanically. Each gate also needs a separate negative-control AC to prove it can go red. Merging ACs would hide failures, and splitting the slice would delay the P0 foundation that #3–#8 depend on.
- **Interim families.** `spec_lint.families` has no `compliance` or `security`. I used `ux` for the copy controls (AC-L1/B1), `durability` for CI or process gates, `privacy` only for the egress ACs, and `browser` for the transport ACs. See the process proposal.
- **Repo not inspected.** `gh api` was denied in the v1 run. The repo is assumed greenfield, per analysis.
- **Wording.** Wording follows AC-B1/AC-L1, not R2.1/R4.3 (ADR 20261125-053558-requirements-r2-1-r4-3…).
