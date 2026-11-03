#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
command -v node >/dev/null || { printf 'OpenDLE requires Node.js 22.12+ and npm.\n' >&2; exit 1; }
command -v npm >/dev/null || { printf 'OpenDLE requires npm.\n' >&2; exit 1; }
node --input-type=module -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || major === 22 && minor < 12) { console.error("OpenDLE requires Node.js 22.12 or newer."); process.exit(1); }'

if [[ ! -d node_modules || ! -d node_modules/electron ]]; then
  printf 'Installing OpenDLE dependencies from package-lock.json...\n'
  npm ci
fi

exec node --env-file-if-exists=.env scripts/launch.js "$@"
