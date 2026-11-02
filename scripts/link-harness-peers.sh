#!/usr/bin/env bash
# Local development only: make the DSH host packages resolvable from this
# standalone repo. An installed plugin resolves them from the DSH profile.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PEER_ROOT="${DSH_PEER_ROOT:-$HOME/.dsh/profiles/node_modules/@deepseek-ai}"

if [[ ! -d "$PEER_ROOT" ]]; then
  echo "[dsh-minemate] DSH peer packages not found at $PEER_ROOT; skipping links."
  exit 0
fi

mkdir -p "$ROOT/node_modules/@deepseek-ai"
for pkg in cordis dsh-agent dsh-llm dsh-scope dsh-session dsh-system-prompt dsh-tools dsh-util-values schemastery; do
  if [[ -e "$PEER_ROOT/$pkg" && ! -e "$ROOT/node_modules/@deepseek-ai/$pkg" ]]; then
    ln -s "$PEER_ROOT/$pkg" "$ROOT/node_modules/@deepseek-ai/$pkg"
  fi
done
echo "[dsh-minemate] linked DSH peers from $PEER_ROOT"
