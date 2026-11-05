#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node -e "if (Number(process.versions.node.split('.')[0]) !== 24) { console.error('Node.js 24가 필요합니다.'); process.exit(1); }"
npm ci
npm run build
npm test
