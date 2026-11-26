#!/usr/bin/env bash
# Supervised start of one local-node environment (#192). launchd runs this from the plist that deploy/local-node.sh writes,
# and nothing else does. It checks every argument again (the plist is never trusted blindly), writes server.pid atomically,
# then execs node with the server contract, so server.pid names node's own pid and local-node.sh's [S2] check still holds.
# Usage: env-run.sh <root> <sha> <port> <node> [--test-now=<epoch>]   (the 5th argument only appears in test-mode plists)
# [S-1] Every refusal deletes <root>/.supervise, the sentinel the plist's KeepAlive PathState keys on, and exits 0, so launchd
# stops relaunching. Written for macOS /bin/bash 3.2, which is what launchd's PATH finds.
set -euo pipefail
umask 077

# 2026-12-03T00:00:00+05:30, ADR 20261125-061043 (TLS/loopback waiver). local-node.sh reads this line, so it is the only source.
WAIVER_END=1796236200

root=${1:-} sha=${2:-} port=${3:-} node=${4:-} opt=${5:-}
say() { printf '%s\n' "env-run: $*" >&2; }

# [S-1] A malformed root names no sentinel we can trust: sleep, so launchd starts this at most once an hour. bootout still stops it.
if [[ $root != /* || $root == *$'\n'* || -L $root ]]; then
  say "invalid root $(printf '%q' "$root"); sleeping 3600 s"
  sleep 3600
  exit 0
fi
refuse() { say "$1"; rm -f -- "$root/.supervise"; exit 0; }

(( $# == 4 || $# == 5 )) || refuse "expected 4 or 5 arguments, got $#"
[[ $sha =~ ^[0-9a-f]{7,40}$ ]] || refuse "invalid sha $(printf '%q' "$sha")"
if ! [[ $port =~ ^[1-9][0-9]{3,4}$ ]] || (( port < 1024 || port > 65535 )); then refuse "invalid port $(printf '%q' "$port")"; fi

# [S-4] node: absolute, executable, and neither it nor its folder writable by group or others; owner root or this user.
trusted() {
  local u m
  u=$(stat -f %u -- "$1" 2>/dev/null) && m=$(stat -f %Lp -- "$1" 2>/dev/null) || return 1
  [[ $u == 0 || $u == "$(id -u)" ]] && (( (8#$m & 8#022) == 0 ))
}
[[ $node == /* && -f $node && -x $node ]] || refuse "node is not an absolute executable: $(printf '%q' "$node")"
if ! trusted "$node" || ! trusted "$(dirname -- "$node")"; then refuse "untrusted node binary: $(printf '%q' "$node")"; fi
nv=$("$node" --version 2>/dev/null || true); nv=${nv#v}
if ! [[ ${nv%%.*} =~ ^[0-9]+$ ]] || (( ${nv%%.*} < 26 )); then refuse "node 26+ required (found $(printf '%q' "$nv"))"; fi

# [S-2] The waiver ends at WAIVER_END; after it nothing starts. Purge (#63) removes the job.
now=$(date +%s)
if [[ -n $opt ]]; then
  [[ $opt =~ ^--test-now=([0-9]{1,12})$ ]] || refuse "invalid option $(printf '%q' "$opt")"
  now=${BASH_REMATCH[1]}
fi
(( now < WAIVER_END )) || refuse "waiver expired (ADR 20261125-061043); run purge #63"

# The release must still exist (purge or scratch cleanup may have deleted it) and `current` must point at it.
rel="$root/releases/$sha"
[[ -f $rel/server/index.mjs ]] || refuse "release missing: $sha"
[[ $(readlink "$root/current" 2>/dev/null || true) == "$rel" ]] || refuse "current does not point at releases/$sha"

# AC-c: atomic pid file. exec keeps this pid, so it is node's pid.
printf '%s\n' "$$" >"$root/server.pid.tmp.$$"
mv -f -- "$root/server.pid.tmp.$$" "$root/server.pid"

unset NODE_OPTIONS
export HOST=127.0.0.1 PORT="$port" ENWALLET_DB="$root/data/enwallet.db" ENWALLET_SHA="$sha" SF_RELEASE_SHA="$sha"
exec "$node" "$root/current/server/index.mjs" "$port" "$root/data"
