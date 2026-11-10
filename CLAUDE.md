# chakai リポジトリ規約

chakai は owner と複数の AI を区別するタスク台帳。`worker/` が Cloudflare Worker（pnpm workspace）で、REST が機能の正、MCP はその殻。構成と API の概要は README にある。Access のアプリと service token は `ochanuco/chabatake` が持ち、D1・独自ドメインはこの repo の `worker/wrangler.jsonc` が持つ。

## コマンド

- `pnpm install`（`worker` の postinstall で `wrangler types`）
- `pnpm run typecheck && pnpm run lint && pnpm test && pnpm run build`: PR 前に必ず通す
- `pnpm format`: Biome で整形（lint も Biome）
- `pnpm --filter @chakai/worker run db:generate`: schema から migration を作る

## 規約

- public repo なので、メールアドレス・Client ID・アカウント ID などの実値をコード・テスト・docs に書かない。名簿は D1 のデータで、テストは example.com と架空の ID を使う
- 機能は REST に足し、MCP の道具は REST の入口へ写すだけにする
- 書き込みは、同じ `db.batch` で `events` にも追記する。`events` は更新も削除もしない。タスクは消さない
- Valibot は境界（リクエストの入力）でのみ使う。内部の型は TypeScript の型で表す
- 想定内の失敗は例外を投げず `{ ok: false, error }` で返す
- ID は UUID v7（`newId()`）。actor の ID だけは名簿の名前
- D1 は Drizzle。テーブルの migration は `drizzle-kit generate` で作り、手書きしない（trigger は `--custom`）
- `order_key` はバイト順で比べる。SQL の `ORDER BY` と JS の `<` を使い、`localeCompare` は使わない
- Worker のデプロイは `deploy` workflow の手動実行で行う。`wrangler deploy` の手打ちはしない
- コメントは日本語で、コードから読み取れない理由だけを書く
