#!/usr/bin/env bash
# Local "environment" on this machine for a static web app. Run from a checkout of the repo at the commit to deploy.
#   build → releases/<sha> → switch `current` → health check (page + JS bundle) → automatic rollback on failure.
# Usage: local-static.sh <name> <env> <port>
set -euo pipefail
name=${1:-} env=${2:-} port=${3:-}
# Validate inputs before touching the filesystem (governance owner request #25).
[[ "$name" =~ ^[a-z0-9-]+$ ]] || { echo "✗ invalid repo name: '$name' (expected ^[a-z0-9-]+$)"; exit 2; }
[[ "$env" == staging || "$env" == production ]] || { echo "✗ invalid environment: '$env' (expected staging or production)"; exit 2; }
[[ "$port" =~ ^[0-9]+$ ]] && (( port >= 1024 && port <= 65535 )) || { echo "✗ invalid port: '$port' (expected an integer 1024-65535)"; exit 2; }
root="${SF_ENV_ROOT:-$HOME/factory-envs}/$name/$env"
mkdir -p "$root/releases"
exec > >(tee -a "$root/deploy.log") 2>&1

# --rollback: repoint `current` to the last release that passed verify (VERIFIED), else the previous one.
if [[ "${4:-}" == "--rollback" ]]; then
  cur=$(basename "$(readlink "$root/current" 2>/dev/null)" 2>/dev/null || true)
  target=$(cat "$root/VERIFIED" 2>/dev/null || true)
  [[ -z "$target" || "$target" == "$cur" ]] && target=$(ls -1t "$root/releases" | grep -vx "$cur" | head -1 || true)
  [[ -z "$target" || ! -d "$root/releases/$target" ]] && { echo "✗ no release to roll back to"; exit 1; }
  ln -sfn "$root/releases/$target" "$root/current" && echo "$target" >"$root/VERSION"
  echo "↩ $(date -u +%FT%TZ) $name/$env rolled back from ${cur:-none} to $target"
  exit 0
fi
sha=$(git rev-parse --short HEAD)
url="http://127.0.0.1:$port/"
echo "── $(date -u +%FT%TZ) deploy $name@$sha → $env ($url)"

npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
npm run build
rm -rf "$root/releases/$sha"
cp -R dist "$root/releases/$sha"

prev=$(readlink "$root/current" 2>/dev/null || true)
ln -sfn "$root/releases/$sha" "$root/current"

# The port must be free or already ours. Never fight another service for it.
owner_pid=$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)
our_pid=$(cat "$root/server.pid" 2>/dev/null || true)
if [[ -n "$owner_pid" && "$owner_pid" != "$our_pid" ]]; then
  echo "✗ port $port is in use by another process: $(ps -o command= -p "$owner_pid" | cut -c1-120)"
  echo "  Pick a free port for $env in org.yaml (product.repos[].ports). Nothing was changed."
  ln -sfn "${prev:-$root/releases/$sha}" "$root/current"
  exit 1
fi

# One long-lived static server per environment. It serves through the `current` link, so a switch needs no restart.
if [[ -z "$owner_pid" ]]; then
  nohup python3 "$(dirname "$0")/static-server.py" "$port" "$root/current" </dev/null >"$root/server.log" 2>&1 &
  echo $! >"$root/server.pid"
fi

healthy() {
  local html asset
  html=$(curl -fsS --max-time 5 "$url") || return 1
  asset=$(grep -oE 'assets/[^"]+\.js' <<<"$html" | head -1) || return 1
  curl -fsS --max-time 5 -o /dev/null "$url$asset"
}
for _ in $(seq 1 10); do
  if healthy; then
    echo "$sha" >"$root/VERSION"
    ls -1t "$root/releases" | tail -n +6 | while read -r old; do rm -rf "$root/releases/$old"; done
    echo "✓ $name@$sha live on $env at $url"
    exit 0
  fi
  sleep 1
done

echo "✗ health check failed for $name@$sha on $env"
if [[ -n "$prev" ]]; then ln -sfn "$prev" "$root/current"; echo "↩ rolled back to $(basename "$prev")"; fi
exit 1
