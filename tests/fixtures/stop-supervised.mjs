// #192: local-node.sh now starts servers under launchd, so killing server.pid only gets it relaunched. Suites call this in
// after() to run `local-node.sh <name> <env> --stop` for a root <SF_ENV_ROOT>/<name>/<env>, which unloads the job and its plist.
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', 'local-node.sh');

export function stopSupervised(R, extraEnv = {}) {
  const env = { ...process.env, SF_ENV_ROOT: dirname(dirname(R)), ...extraEnv };
  delete env.HOST;
  return spawnSync('bash', [SCRIPT, basename(dirname(R)), basename(R), '--stop'], { env, encoding: 'utf8', timeout: 60_000 });
}
