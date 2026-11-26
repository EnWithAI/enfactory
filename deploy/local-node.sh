#!/usr/bin/env bash
# Local environment on this machine for a Node server app (enwallet, #64). Run from a checkout at the commit to deploy.
#   build → releases/<sha> → stop the old server → switch `current` → start → probe → restore the previous release on failure.
# Usage: local-node.sh <name> <env> <port> [--rollback|--stop|--status]      (empty <port>: staging 4310, production 4311)
#   A flag may also come as argument 3 (an empty <port> collapsed by the caller's shell, #60). A production deploy is
#   refused unless staging (127.0.0.1:${SF_STAGING_PORT:-4310}) reports ok, db and the same sha; a production rollback never asks staging.
#   --stop stops the service and unloads its supervisor, keeping releases and data (purge #63, scratch cleanup).
#   --status is read-only: 0 when /api/health is ok on the VERSION sha, else 1.
# Supervision (#192): node runs under a launchd LaunchAgent (label com.enwithai.sf.<name>.<env>.<root hash>) that runs
#   deploy/env-run.sh, so a signal to the deploying process group never reaches it and a killed server comes back in ~2 s.
#   KeepAlive keys on <root>/.supervise; stop deletes it first. Test mode (SF_ENV_ROOT set) alone honours SF_LAUNCHD_DOMAIN,
#   SF_LAUNCHAGENTS_DIR and SF_NOW_EPOCH [S-3].
# Exit codes: 0 live · 1 deploy/rollback failed (nothing left half-switched) · 2 invalid input (no build ran)
# Server contract: node <root>/current/server/index.mjs <port> <root>/data (#3 CLI: server/index.mjs <port> <dataDir>),
#   with env HOST=127.0.0.1 PORT=<port> ENWALLET_DB=<root>/data/enwallet.db ENWALLET_SHA=<sha> SF_RELEASE_SHA=<sha>
#   (enwallet server/health.mjs reports SF_RELEASE_SHA, #80); GET /api/health → 200 {"ok":true,"db":true,"sha":"<sha>"}.
# The store under <root>/data is never copied, moved or deleted here.
set -euo pipefail
umask 077 # [S4] deploy.log, server.log, server.pid, releases/ and data/ are owner-only.

LOG="" step=args tmp="" off=0 mode=""
here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
log() { printf '%s\n' "$*"; if [[ -n $LOG ]]; then printf '%s\n' "$*" >>"$LOG"; fi; }
die() { local code=$1; shift; log "$*"; exit "$code"; }
q() { printf '%q' "$1"; } # [S1] rejected values are always shell-quoted.
ts() { date -u +%FT%TZ; }
valid_id() { [[ ${1:-} =~ ^[0-9a-f]{7,40}$ ]]; } # [S7] every release id passes here before a path, ln or rm uses it.

# 1-2. Arguments and inputs [S6]. Nothing is written until these pass.
(( $# <= 4 )) || die 2 "✗ too many arguments ($#; usage: local-node.sh <name> <env> <port> [--rollback|--stop|--status])"
name=${1:-} env=${2:-} port=${3:-} flag=${4:-}
# The dispatcher's calls collapse an empty {port}, so a flag can arrive as $3 (#60).
case $port in --rollback | --stop | --status) if [[ -z $flag ]]; then flag=$port port=""; fi ;; esac
case $flag in '' | --rollback | --stop | --status) ;; *) die 2 "✗ invalid flag: $(q "$flag") (expected --rollback, --stop or --status)" ;; esac
[[ $name =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || die 2 "✗ invalid repo name: $(q "$name") (expected ^[a-z0-9][a-z0-9-]{0,63}\$)"
[[ $env == staging || $env == production ]] || die 2 "✗ invalid environment: $(q "$env") (expected staging or production)"
if [[ -n ${SF_ENV_ROOT:-} ]] && [[ $SF_ENV_ROOT != /* || $SF_ENV_ROOT == *$'\n'* ]]; then
  die 2 "✗ invalid SF_ENV_ROOT: $(q "$SF_ENV_ROOT") (expected an absolute path)"
fi

# 3. Root layout.
R="${SF_ENV_ROOT:-$HOME/factory-envs}/$name/$env"
if [[ $flag == --status ]]; then
  mode=status # read-only: no directory, no log file
elif [[ $flag == --stop ]]; then
  mode=stop
  if [[ -d $R ]]; then LOG="$R/deploy.log"; fi # a deleted root is still stopped (its job unloaded), but never re-created
else
  mkdir -p "$R/releases" "$R/data"
  LOG="$R/deploy.log"
fi
if [[ $mode == status || $mode == stop ]]; then
  label=service
elif [[ $flag == --rollback ]]; then
  mode=rollback cur=$(readlink "$R/current" 2>/dev/null || true); cur=${cur##*/}
  valid_id "$cur" || cur="" # a non-matching current is treated as "no current"
  label=${cur:-none}
else
  mode=deploy sha=$(git rev-parse --short HEAD 2>/dev/null || true); label=$(q "${sha:-unknown}")
fi
log "── $(ts) $mode $name@$label → $env"

# 4. Port [S6]: no leading zero (bash would read it as octal), 1024-65535.
[[ -n $port ]] || { [[ $env == staging ]] && port=4310 || port=4311; }
if ! [[ $port =~ ^[1-9][0-9]{3,4}$ ]] || (( port < 1024 || port > 65535 )); then
  die 2 "✗ invalid port: $(q "$port") (expected an integer 1024-65535)"
fi
log "· port $port"
# 5. Loopback only (ADR 20261125-061043). A HOST that is set to anything but 127.0.0.1, even empty, is refused.
if [[ -n ${HOST+set} && $HOST != 127.0.0.1 ]]; then
  die 2 "✗ refusing bind: HOST=$(q "$HOST") (only 127.0.0.1 allowed)"
fi
# 6. Staging port the production gate asks (#60) [S6]: same rule as <port>. Only a production deploy reads it.
sport=${SF_STAGING_PORT:-4310}
if [[ $env == production && $mode == deploy ]] && { ! [[ $sport =~ ^[1-9][0-9]{3,4}$ ]] || (( sport < 1024 || sport > 65535 )); }; then
  die 2 "✗ invalid SF_STAGING_PORT: $(q "$sport") (expected an integer 1024-65535)"
fi

# Supervisor identity (#192). The root hash keeps scratch roots apart from the real environment.
uid=$(id -u)
job="com.enwithai.sf.$name.$env.$(printf %s "$R" | shasum -a 256 | cut -c1-8)"
domain="gui/$uid" agents="$HOME/Library/LaunchAgents" now_override=""
# owner_only <path>: owned by root or this user, and not writable by group or others.
owner_only() {
  local u m
  u=$(stat -f %u -- "$1" 2>/dev/null) && m=$(stat -f %Lp -- "$1" 2>/dev/null) || return 1
  [[ $u == 0 || $u == "$uid" ]] && (( (8#$m & 8#022) == 0 ))
}
# [S-3] The overrides are test-only, so a real deploy can never put its plist where stop and purge don't look.
if [[ -n ${SF_ENV_ROOT:-} ]]; then
  if [[ -n ${SF_LAUNCHD_DOMAIN:-} ]]; then
    [[ $SF_LAUNCHD_DOMAIN =~ ^(gui|user)/$uid$ ]] || die 2 "✗ invalid SF_LAUNCHD_DOMAIN: $(q "$SF_LAUNCHD_DOMAIN") (expected gui/$uid or user/$uid)"
    domain=$SF_LAUNCHD_DOMAIN
  fi
  if [[ -n ${SF_LAUNCHAGENTS_DIR:-} ]]; then
    a=$SF_LAUNCHAGENTS_DIR
    if [[ $a != /* || $a == *$'\n'* || ! -d $a || -L $a ]] || [[ $(stat -f %u -- "$a") != "$uid" ]] || ! owner_only "$a"; then
      die 2 "✗ invalid SF_LAUNCHAGENTS_DIR: $(q "$a") (expected an existing owner-only directory, not a symlink)"
    fi
    agents=$a
  fi
  if [[ -n ${SF_NOW_EPOCH:-} ]]; then
    [[ $SF_NOW_EPOCH =~ ^[0-9]{1,12}$ ]] || die 2 "✗ invalid SF_NOW_EPOCH: $(q "$SF_NOW_EPOCH")"
    now_override=$SF_NOW_EPOCH
  fi
else
  for v in SF_LAUNCHD_DOMAIN SF_LAUNCHAGENTS_DIR SF_NOW_EPOCH; do
    [[ -z ${!v:-} ]] || log "· ignoring $v (test-only; SF_ENV_ROOT unset)"
  done
fi
plist="$agents/$job.plist"

# [S-2] The Release 1 waiver ends at WAIVER_END (one constant, in env-run.sh). Nothing starts after it.
waiver_end=$(sed -n 's/^WAIVER_END=//p' "$here/env-run.sh" 2>/dev/null || true)
waiver_ok() { local n=${now_override:-$(date +%s)}; (( n < waiver_end )); }
waiver_msg="✗ waiver expired (ADR 20261125-061043): no start after 2026-12-03 00:00 IST; run purge #63"

if [[ $mode == deploy || $mode == rollback ]]; then
  [[ $waiver_end =~ ^[0-9]+$ ]] || die 1 "✗ cannot read WAIVER_END from $(q "$here/env-run.sh")"
  waiver_ok || die 1 "$waiver_msg"
  # 7. [S-4] pin_node: Node 26+ (node:sqlite) from a trusted place, checked before anything is stopped or built (#60).
  untrusted_node() { die 1 "✗ untrusted node binary: $(q "$1") ($2)"; }
  node_path=$(command -v node || true)
  [[ -n $node_path ]] || die 1 "✗ node 26+ required (found none)"
  nv=$("$node_path" -p 'process.versions.node' 2>/dev/null || echo none) # version first: its message is the #60 contract
  if ! [[ ${nv%%.*} =~ ^[0-9]+$ ]] || (( ${nv%%.*} < 26 )); then die 1 "✗ node 26+ required (found $(q "$nv"))"; fi
  node_bin=$(realpath -- "$node_path" 2>/dev/null || true)
  [[ $node_bin == /* ]] || untrusted_node "$node_path" "path does not resolve"
  deny=("$(realpath -- "$R")/" "/tmp/" "/private/tmp/" "$(realpath -- "${TMPDIR:-/tmp}")/")
  [[ -z ${TMPDIR:-} ]] || deny+=("${TMPDIR%/}/")
  [[ -z ${SF_HOME:-} ]] || deny+=("${SF_HOME%/}/worktrees/")
  [[ ! -d $HOME/factory-worktrees ]] || deny+=("$HOME/factory-worktrees/")
  for p in "$node_path" "$node_bin"; do
    [[ $p != */releases/* && $p != */node_modules/* ]] || untrusted_node "$p" "inside releases/ or node_modules/"
    for d in "${deny[@]}"; do [[ $p != "$d"* ]] || untrusted_node "$p" "under $d"; done
  done
  if ! owner_only "$node_bin" || ! owner_only "$(dirname -- "$node_bin")"; then untrusted_node "$node_bin" "owner or mode"; fi
  # [S-5] pin_program: launchd only ever runs the installed factory's env-run.sh (never a worktree or PR checkout).
  prog=$(realpath -- "$here/env-run.sh" 2>/dev/null || true)
  if [[ -z ${SF_ENV_ROOT:-} ]]; then
    inst=$(realpath -- "${SF_HOME:-$HOME/software-factory}" 2>/dev/null || true)
    [[ -n $inst && $prog == "$inst/deploy/env-run.sh" ]] || die 1 "✗ supervisor program must be the installed factory's deploy/env-run.sh (got $(q "$prog"))"
  fi
  if ! [[ -n $prog && -x $prog && $(stat -f %u -- "$prog") == "$uid" ]] || ! owner_only "$prog"; then
    die 1 "✗ untrusted supervisor program: $(q "$prog")"
  fi
fi

# shellcheck disable=SC2329 # invoked by the ERR trap below
on_err() {
  local rc=$?
  [[ -n $tmp ]] && rm -rf -- "$tmp" # only this run's exact staging path
  log "✗ $step failed (exit $rc)"
  exit 1
}
trap on_err ERR
trap '[[ -n $tmp ]] && rm -rf -- "$tmp"; log "✗ $step interrupted"; exit 130' INT TERM

listeners() { lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true; }
alive() { local s; s=$(ps -o stat= -p "$1" 2>/dev/null) || return 1; [[ -n $s && $s != Z* ]]; }

# [S2] The pid in server.pid counts as ours only if it is a live node process running <root>/.../server/index.mjs.
our_pid() {
  local p cmd
  p=$(cat "$R/server.pid" 2>/dev/null || true)
  [[ $p =~ ^[0-9]+$ ]] && alive "$p" || return 0
  cmd=$(ps -o command= -p "$p" 2>/dev/null || true)
  [[ $cmd == *node* && $cmd == *"$R/"*"/server/index.mjs"* ]] || return 0
  printf '%s\n' "$p"
}

# [S2] Every listener on the port must be ours. Never fight another service for it.
guard_port() {
  local p ours
  ours=$(our_pid)
  for p in $(listeners); do
    [[ $p == "$ours" ]] || die 1 "✗ port $port is in use by another process (pid $p). Nothing was changed."
  done
}

# [S3] Signal only our verified pid. No pkill, killall, process groups or pids taken from lsof.
loaded() { launchctl print "$domain/$job" >/dev/null 2>&1; }
# [S-1] The sentinel goes first, so a relaunch race finds none; then bootout (ExitTimeOut 5 bounds it) and the plist.
# The verified-pid path below still stops a legacy nohup server from before #192.
stop_ours() {
  local p
  step=stop
  rm -f -- "$R/.supervise"
  if loaded; then
    log "· supervisor bootout $job"
    launchctl bootout "$domain/$job" >/dev/null 2>&1 || true
    for _ in {1..50}; do loaded || break; sleep 0.1; done
    for _ in {1..50}; do [[ -z $(listeners) ]] && break; sleep 0.1; done
  fi
  rm -f -- "$plist"
  p=$(our_pid)
  if [[ -n $p ]]; then
    log "· stop pid $p"
    kill -TERM "$p" 2>/dev/null || true
    for _ in {1..50}; do alive "$p" || break; sleep 0.1; done
    if alive "$p" && [[ $(our_pid) == "$p" ]]; then kill -KILL "$p" 2>/dev/null || true; fi
    for _ in {1..50}; do [[ -z $(listeners) ]] && break; sleep 0.1; done
  fi
  rm -f "$R/server.pid"
}

switch_to() { ln -sfn -- "$R/releases/$1" "$R/current"; }

# write_plist <sha>: the sentinel, then a 0600 plist serialised from argv by JSON.stringify and converted by plutil
# (no string concatenation, and paths may contain dots that plutil keypaths would split on).
write_plist() {
  local id=$1 t
  printf '%s\n' "$id" >"$R/.supervise"
  [[ -d $agents ]] || mkdir -p -- "$agents" # umask 077, so 0700
  t=$(mktemp "$agents/.$job.XXXXXX")
  # shellcheck disable=SC2016 # JavaScript template literals, not shell expansions
  "$node_bin" -e '
    const [label, prog, root, sha, port, node, testNow] = process.argv.slice(1);
    const args = [prog, root, sha, port, node, ...(testNow ? [`--test-now=${testNow}`] : [])];
    process.stdout.write(JSON.stringify({ Label: label, ProgramArguments: args, RunAtLoad: true,
      KeepAlive: { PathState: { [`${root}/.supervise`]: true } }, ExitTimeOut: 5, ThrottleInterval: 2,
      StandardOutPath: `${root}/server.log`, StandardErrorPath: `${root}/server.log`, Umask: 63,
      ProcessType: "Background", WorkingDirectory: root }));' \
    "$job" "$prog" "$R" "$id" "$port" "$node_bin" "$now_override" >"$t"
  plutil -convert xml1 -- "$t" >/dev/null
  plutil -lint -- "$t" >/dev/null
  chmod 600 "$t"
  mv -f -- "$t" "$plist"
}

# [S-6] Fail closed: if launchd won't take the job, the deploy fails. There is never an unsupervised nohup fallback.
start() {
  local id=$1 err
  step=start off=0
  waiver_ok || die 1 "$waiver_msg"
  if [[ -f $R/server.log ]]; then off=$(wc -c <"$R/server.log"); off=${off//[[:space:]]/}; fi
  write_plist "$id"
  if loaded; then launchctl bootout "$domain/$job" >/dev/null 2>&1 || true; fi
  log "· supervisor bootstrap $job"
  if ! err=$(launchctl bootstrap "$domain" "$plist" 2>&1); then
    log "$err"
    rm -f -- "$R/.supervise" "$plist"
    die 1 "✗ supervisor bootstrap failed ($domain/$job)"
  fi
  log "· start $name@$id on 127.0.0.1:$port"
  for _ in {1..50}; do [[ -n $(our_pid) ]] && break; sleep 0.1; done
}

# [S8] Loopback only, no proxy, http only. The health body and the sha go to node as stdin and argv, never as source.
curl=(curl -fsS --max-time 2 --noproxy '*' --proto '=http')
# health_ok <url> <sha>: 0 only for 200 {"ok":true,"db":true,"sha":<sha>} (strict booleans, #60). Non-200 or non-JSON fails.
health_ok() {
  "${curl[@]}" "$1" 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try { const j = JSON.parse(s); process.exit(j.ok === true && j.db === true && j.sha === process.argv[1] ? 0 : 1); } catch { process.exit(1); }
    });' "$2"
}
healthy() {
  local id=$1 base="http://127.0.0.1:$port" html asset
  health_ok "$base/api/health" "$id" || return 1
  html=$("${curl[@]}" "$base/" 2>/dev/null) || return 1
  asset=$(grep -oE 'assets/[^"]+\.js' <<<"$html" | head -1) || return 1
  [[ -n $asset ]] && "${curl[@]}" -o /dev/null "$base/$asset" 2>/dev/null
}

# 10 tries, 1 s apart; each try is at most 3 × 2 s, so the worst case is about 70 s.
probe() {
  local id=$1 rc=1 out
  step=probe; log "· probe $name@$id (/api/health, /, assets/*.js)"
  for _ in {1..10}; do
    if healthy "$id"; then rc=0; break; fi
    sleep 1
  done
  # [S5] Append what the server printed during this start, capped at 64 KiB.
  out=$(tail -c +$((off + 1)) "$R/server.log" 2>/dev/null | head -c 65536 || true)
  [[ -z $out ]] || printf '%s\n' "$out" >>"$LOG"
  return $rc
}

# --stop: the service only; releases, data, current and VERSION stay. --status: read-only health of the VERSION sha.
if [[ $mode == stop ]]; then
  stop_ours
  log "■ $(ts) $name/$env stopped; supervisor $job unloaded"
  exit 0
fi
if [[ $mode == status ]]; then
  v=$(cat "$R/VERSION" 2>/dev/null || true)
  if loaded; then log "· supervisor $job loaded ($domain)"; else log "· supervisor $job not loaded ($domain)"; fi
  if valid_id "$v" && health_ok "http://127.0.0.1:$port/api/health" "$v"; then log "✓ $name@$v healthy on $env (127.0.0.1:$port)"; exit 0; fi
  die 1 "✗ $name/$env not healthy on 127.0.0.1:$port (VERSION $(q "${v:-none}"))"
fi

# 8. --rollback: back to the release SRE verified. No git, no npm, no fallback to an unverified release.
if [[ $mode == rollback ]]; then
  tgt=$(cat "$R/VERIFIED" 2>/dev/null || true)
  valid_id "$tgt" || { [[ -z $tgt ]] || die 1 "✗ no VERIFIED release to roll back to (invalid release id: $(q "$tgt"))"; }
  [[ -n $tgt && -d $R/releases/$tgt && $tgt != "$cur" ]] || die 1 "✗ no VERIFIED release to roll back to"
  step=preflight; guard_port
  stop_ours
  switch_to "$tgt"; start "$tgt"
  if probe "$tgt"; then
    printf '%s\n' "$tgt" >"$R/VERSION"
    log "↩ $(ts) $name/$env rolled back from ${cur:-none} to $tgt"
    exit 0
  fi
  stop_ours
  if [[ -n $cur && -d $R/releases/$cur ]]; then
    switch_to "$cur"; start "$cur"; probe "$cur" || true
  else
    rm -f "$R/current"
  fi
  die 1 "✗ rollback probe failed for $name@$tgt; ↩ restored ${cur:-none}"
fi

# 9. Deploy.
valid_id "$sha" || die 1 "✗ invalid release id: $(q "$sha")"
step=preflight; guard_port
[[ -f server/index.mjs ]] || die 1 "✗ missing precondition: server/index.mjs"
node -e 'const p = JSON.parse(require("fs").readFileSync("package.json", "utf8")); process.exit(typeof p?.scripts?.build === "string" ? 0 : 1)' 2>/dev/null \
  || die 1 "✗ missing precondition: package.json scripts.build"
# Production only takes a build that staging already serves healthy on the same sha (#60). Before npm, so a refusal changes nothing.
if [[ $env == production ]]; then
  step=gate; log "· gate: staging 127.0.0.1:$sport reports $sha"
  health_ok "http://127.0.0.1:$sport/api/health" "$sha" || die 1 "✗ staging is not healthy on $sha"
fi

step=build; log "· build: npm ci --ignore-scripts && npm run build"
npm ci --ignore-scripts --no-audit --no-fund --loglevel=error 2>&1 | tee -a "$LOG"
npm run build --loglevel=error 2>&1 | tee -a "$LOG"
[[ -f dist/index.html ]] || die 1 "✗ missing precondition: dist/index.html"

step=copy; tmp="$R/releases/.tmp-$sha-$$"; log "· copy dist, server, src/shared, src/brand → releases/$sha"
mkdir -- "$tmp"
cp -R dist server "$tmp/"
for d in shared brand; do
  if [[ -d src/$d ]]; then mkdir -p -- "$tmp/src"; cp -R "src/$d" "$tmp/src/"; fi
done
# [#177] The server reads its CSP from <release>/deploy/csp.txt at start-up.
if [[ -f deploy/csp.txt ]]; then
  log "· copy deploy/csp.txt"; mkdir -p -- "$tmp/deploy"; cp -- deploy/csp.txt "$tmp/deploy/csp.txt"
fi
touch "$tmp"
# [#53] Every relative import in server/, src/shared/ and src/brand/ must resolve inside the staged release.
# Runs before guard_port/stop_ours/rm/mv, so a failure leaves the live release untouched.
step=closure
if ! out=$(node "$here/check-import-closure.mjs" "$tmp"); then
  if [[ -n $out ]]; then while IFS= read -r l; do log "$l"; done <<<"$out"; fi
  rm -rf -- "$tmp"; tmp=""
  die 1 "✗ import closure check failed for $name@$sha; nothing switched"
fi
# [#177] A server that reads deploy/csp.txt fails closed without it: abort before touching the live release.
if grep -rqF -- deploy/csp.txt "$tmp/server" && [[ ! -f $tmp/deploy/csp.txt ]]; then
  rm -rf -- "$tmp"; tmp=""
  die 1 "✗ server reads deploy/csp.txt but the release has none for $name@$sha; nothing switched"
fi

prev=$(readlink "$R/current" 2>/dev/null || true); prev=${prev##*/}
valid_id "$prev" && [[ -d $R/releases/$prev && $prev != "$sha" ]] || prev=""
step=preflight; guard_port
stop_ours
step=switch
rm -rf -- "${R:?}/releases/${sha:?}"
mv -- "$tmp" "$R/releases/$sha"; tmp=""
switch_to "$sha"
start "$sha"

if probe "$sha"; then
  printf '%s\n' "$sha" >"$R/VERSION"
  # [S7] Keep the 5 newest valid releases plus VERIFIED and current. Anything not a valid id is never touched.
  step=prune verified=$(cat "$R/VERIFIED" 2>/dev/null || true) kept=0
  while IFS= read -r e; do
    valid_id "$e" || continue
    if (( kept < 5 )); then kept=$((kept + 1)); continue; fi
    [[ $e == "$verified" || $e == "$sha" ]] && continue
    log "· prune $e"; rm -rf -- "${R:?}/releases/${e:?}"
  done < <(ls -1t "$R/releases")
  log "✓ $name@$sha live on $env at http://127.0.0.1:$port/"
  exit 0
fi

stop_ours
if [[ -n $prev ]]; then
  switch_to "$prev"; start "$prev"; probe "$prev" || true
  die 1 "✗ health check failed for $name@$sha on $env; ↩ restored $prev"
fi
rm -f "$R/current"
die 1 "✗ health check failed for $name@$sha on $env; no previous release to restore"
