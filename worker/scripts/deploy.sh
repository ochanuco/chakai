#!/usr/bin/env bash
# 使い方: worker/scripts/deploy.sh production
# CLOUDFLARE_API_TOKEN は呼び出し側（deploy workflow の op run）が環境変数で渡す。Worker に secret は無い。
# 未適用の D1 migration を当ててから deploy する。適用済みかは d1_migrations で判定するので、
# ロールバック（古い ref）では当てるものがなく何もしない。
# migration があるときは scripts/d1-guard.mjs が適用前の Time Travel bookmark を取り、適用後に行が減っていたら Worker を出さずに止める。
set -euo pipefail

if [ "${1:-}" != "production" ]; then
  echo "usage: worker/scripts/deploy.sh production" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "error: 未設定: CLOUDFLARE_API_TOKEN（.github/deploy/production.env.op の参照先を確かめる）" >&2
  exit 1
fi

state=$(mktemp)
trap 'rm -f "$state"' EXIT

node scripts/d1-guard.mjs before --driver wrangler --db chakai --dir migrations --state "$state"
pnpm exec wrangler d1 migrations apply chakai --remote
node scripts/d1-guard.mjs after --state "$state"
pnpm exec wrangler deploy
