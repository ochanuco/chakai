#!/usr/bin/env bash
# 使い方: worker/scripts/deploy.sh production
# CLOUDFLARE_API_TOKEN と Worker の secret（GITHUB_TOKEN）は呼び出し側（deploy workflow の op run）が環境変数で渡す。
# secret は argv に載せないよう --secrets-file で渡す。
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
secrets_file=$(mktemp)
trap 'rm -f "$state" "$secrets_file"' EXIT
chmod 600 "$secrets_file"

# GitHub の token は無くても出せる。無ければ Worker は同期とラベル付けを止め、ほかは動く
deploy_args=()
if [ -n "${GITHUB_TOKEN:-}" ]; then
  printf 'GITHUB_TOKEN=%s\n' "$GITHUB_TOKEN" >> "$secrets_file"
  deploy_args+=(--secrets-file "$secrets_file")
else
  echo "warning: GITHUB_TOKEN が未設定。Worker に前の値が無ければ、GitHub との同期とラベル付けは止まったまま" >&2
fi

node scripts/d1-guard.mjs before --driver wrangler --db chakai --dir migrations --state "$state"
pnpm exec wrangler d1 migrations apply chakai --remote
node scripts/d1-guard.mjs after --state "$state"
pnpm exec wrangler deploy "${deploy_args[@]+"${deploy_args[@]}"}"
