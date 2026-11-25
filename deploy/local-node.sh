#!/usr/bin/env bash
# Local environment on this machine for a Node server app (enwallet, #64). Run from a checkout at the commit to deploy.
#   build → releases/<sha> → stop the old server → switch `current` → start → probe → restore the previous release on failure.
# Usage: local-node.sh <name> <env> <port> [--rollback]      (empty <port>: staging 4310, production 4311)
#   `--rollback` may also come as argument 3 (an empty <port> collapsed by the caller's shell, #60). A production deploy is
#   refused unless staging (127.0.0.1:${SF_STAGING_PORT:-4310}) reports ok, db and the same sha; a production rollback never asks staging.
# Exit codes: 0 live · 1 deploy/rollback failed (nothing left half-switched) · 2 invalid input (no build ran)
# Server contract: node <root>/current/server/index.mjs with HOST=127.0.0.1 PORT=<port>
#   ENWALLET_DB=<root>/data/enwallet.db ENWALLET_SHA=<sha>; GET /api/health → 200 {"ok":true,"db":true,"sha":"<sha>"}.
# The store under <root>/data is never copied, moved or deleted here.
set -euo pipefail
umask 077 # [S4] deploy.log, server.log, server.pid, releases/ and data/ are owner-only.

LOG="" step=args tmp="" off=0
log() { printf '%s\n' "$*"; if [[ -n $LOG ]]; then printf '%s\n' "$*" >>"$LOG"; fi; }
die() { local code=$1; shift; log "$*"; exit "$code"; }
q() { printf '%q' "$1"; } # [S1] rejected values are always shell-quoted.
ts() { date -u +%FT%TZ; }
valid_id() { [[ ${1:-} =~ ^[0-9a-f]{7,40}$ ]]; } # [S7] every release id passes here before a path, ln or rm uses it.

# 1-2. Arguments and inputs [S6]. Nothing is written until these pass.
(( $# <= 4 )) || die 2 "✗ too many arguments ($#; usage: local-node.sh <name> <env> <port> [--rollback])"
name=${1:-} env=${2:-} port=${3:-} flag=${4:-}
# The dispatcher's rollback call collapses an empty {port}, so `--rollback` can arrive as $3 (#60).
if [[ $port == --rollback && -z $flag ]]; then port="" flag=--rollback; fi
[[ -z $flag || $flag == --rollback ]] || die 2 "✗ invalid flag: $(q "$flag") (expected --rollback)"
[[ $name =~ ^[a-z0-9][a-z0-9-]{0,63}$ ]] || die 2 "✗ invalid repo name: $(q "$name") (expected ^[a-z0-9][a-z0-9-]{0,63}\$)"
[[ $env == staging || $env == production ]] || die 2 "✗ invalid environment: $(q "$env") (expected staging or production)"
if [[ -n ${SF_ENV_ROOT:-} ]] && [[ $SF_ENV_ROOT != /* || $SF_ENV_ROOT == *$'\n'* ]]; then
  die 2 "✗ invalid SF_ENV_ROOT: $(q "$SF_ENV_ROOT") (expected an absolute path)"
fi

# 3. Root layout.
R="${SF_ENV_ROOT:-$HOME/factory-envs}/$name/$env"
mkdir -p "$R/releases" "$R/data"
LOG="$R/deploy.log"
if [[ $flag == --rollback ]]; then
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
# 7. Node 26+ (node:sqlite), checked before anything is stopped or built (#60).
nv=$(node -p 'process.versions.node' 2>/dev/null || echo none)
if ! [[ ${nv%%.*} =~ ^[0-9]+$ ]] || (( ${nv%%.*} < 26 )); then die 1 "✗ node 26+ required (found $(q "$nv"))"; fi

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
stop_ours() {
  local p
  step=stop p=$(our_pid)
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

start() {
  local id=$1
  step=start off=0
  if [[ -f $R/server.log ]]; then off=$(wc -c <"$R/server.log"); off=${off//[[:space:]]/}; fi
  log "· start $name@$id on 127.0.0.1:$port"
  HOST=127.0.0.1 PORT=$port ENWALLET_DB="$R/data/enwallet.db" ENWALLET_SHA=$id \
    nohup node "$R/current/server/index.mjs" </dev/null >>"$R/server.log" 2>&1 &
  printf '%s\n' "$!" >"$R/server.pid"
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

step=copy; tmp="$R/releases/.tmp-$sha-$$"; log "· copy dist, server, src/shared → releases/$sha"
mkdir -- "$tmp"
cp -R dist server "$tmp/"
if [[ -d src/shared ]]; then mkdir -- "$tmp/src"; cp -R src/shared "$tmp/src/"; fi
touch "$tmp"

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
