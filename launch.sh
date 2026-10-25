#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
command -v node >/dev/null || { printf 'OpenDLE requires Node.js 22+ and npm.\n' >&2; exit 1; }
command -v npm >/dev/null || { printf 'OpenDLE requires npm.\n' >&2; exit 1; }
node --input-type=module -e 'if (Number(process.versions.node.split(".")[0]) < 22) { console.error("OpenDLE requires Node.js 22 or newer."); process.exit(1); }'

if [[ ! -d node_modules ]]; then
  printf 'Installing OpenDLE dependencies from package-lock.json...\n'
  npm ci
fi

exec node --env-file-if-exists=.env scripts/launch.js "$@"
