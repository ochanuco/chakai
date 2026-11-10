# chakai

Task ledger that tells the owner and each AI agent apart.

chakai は、owner 1 人と複数の AI を区別して扱うタスク台帳。Cloudflare Worker（`chakai.chanu.co`）と D1 で動く。タスクを起票するのは AI で、どの書き込みも「誰が」「どの呼び出し元から」行ったかを履歴に残す。

## 構成

| 場所                      | 中身                                                             |
| ------------------------- | ---------------------------------------------------------------- |
| `worker/src/rest.ts`      | REST。機能の正                                                   |
| `worker/src/mcp.ts`       | MCP（Streamable HTTP）。道具を REST の入口へ写すだけの殻         |
| `worker/src/auth.ts`      | Cloudflare Access の JWT から actor と呼び出し元を決める         |
| `worker/src/db/schema.ts` | D1 の schema（Drizzle）。`worker/migrations/` はここから生成する |

Access のアプリと service token は `ochanuco/chabatake` が持ち、Worker・独自ドメイン・D1 はこの repo の `worker/wrangler.jsonc` が持つ。

## 誰のリクエストかを決める

Access がホスト全体を守り、Worker は Access の JWT（`Cf-Access-Jwt-Assertion`）を検証して、名簿（D1）から actor を決める。

- 人: JWT の `email` で `actors` を引く。名簿に無ければ 403。
- service token: JWT の `common_name`（Client ID）で `callers` を引く。`X-Actor` ヘッダーがあれば、その actor が `caller_actors` の許可リストにあるかを確かめる。無ければ `callers.default_actor_id` を使う。許可されない名乗りは 403、既定の actor が無い呼び出し元が名乗らなければ 400。

actor の ID は名簿の名前（`owner`、`yukarin` など）で、それ以外の ID は UUID v7。

## タスク

- 状態は `backlog`・`todo`・`doing`・`review`・`done`・`dropped`。起票の既定は `backlog` で、起票のときに選べるのは `backlog` と `todo` だけ。
- `review` は owner の番を表す。`review` にするときは `waiting_on` が要り、`review` を出ると `waiting_on` は空になる。
- タスクは消さない。やめたものは `dropped` にする。
- `order_key` はプロジェクト内の並びを表す fractional index。起票すると末尾に入り、更新の `order` で他のタスクの直前・直後に動かす。
- 書き込みはすべて `events` に追記する（`actor_id`、`caller_id`、`field`、`before`、`after`）。`events` は更新も削除もできない。
- 同じタスクへの更新が重なったら、後から書く側が読み直してやり直す。`tasks.revision` は更新のたびに 1 増え、読んだ時点から進んでいる書き込みは D1 の trigger が拒む。

## REST

| 入口                          | 用途                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GET /v1/projects`            | プロジェクトと repo の一覧                                                                               |
| `POST /v1/projects`           | プロジェクトを作る（`name`、`description`）                                                              |
| `POST /v1/projects/:id/repos` | repo を紐付ける（`repo` は `owner/name`）                                                                |
| `GET /v1/tasks`               | タスクを探す（`project_id`、`q`、`state`（カンマ区切り）、`assignee_id`、`parent_id`、`label`、`limit`） |
| `POST /v1/tasks`              | 起票する（`project_id`、`title`、`body`、`parent_id`、`state`、`assignee_id`、`labels`）                 |
| `GET /v1/tasks/:id`           | タスクを読む                                                                                             |
| `PATCH /v1/tasks/:id`         | 更新する（`title`、`body`、`state`、`waiting_on`、`assignee_id`、`labels`、`order`）                     |
| `GET /health`                 | 疎通確認                                                                                                 |

## MCP

`POST /mcp` で受ける。道具は `list_projects`、`create_project`、`link_repo`、`search_tasks`、`get_task`、`create_task`、`update_task`。起票の前に `search_tasks` で似たタスクを探す。

## 開発

```sh
pnpm install
pnpm run typecheck && pnpm run lint && pnpm test && pnpm run build
```

schema を変えたら migration を生成する。

```sh
cd worker
pnpm run db:generate
```

## 名簿に最初の owner と呼び出し元を入れる

名簿は D1 のデータで、実際のメールアドレスと Client ID は repo に置かない。最初の owner と、Mac の Claude Code・Codex の呼び出し元（既定の actor は `owner`）は、値を環境変数で渡して入れる。もう入っている行は変えないので、何度流してもよい。

```sh
cd worker
OWNER_EMAIL='<Access にログインするメールアドレス>' \
MAC_AGENT_CLIENT_ID="$(op read 'op://Personal/mac-agent/cf_access_chakai_client_id')" \
pnpm run roster:init --remote
```

`--remote` は本番の D1 に書くので、`wrangler login` か `CLOUDFLARE_API_TOKEN` が要る。手元の D1 で試すときは、`pnpm run db:migrate:local` の後に `--local` で流す。

## デプロイ

`deploy` workflow を手動（`workflow_dispatch`）で実行する。Environment `production` の承認の後に、`worker/scripts/deploy.sh` が未適用の D1 migration を当ててから `wrangler deploy` する。migration の前後で `worker/scripts/d1-guard.mjs` がテーブルの行数を比べ、行が減ったテーブルか、行が入ったまま消えたテーブルがあれば、Worker を出さずに止める。意図した削除や改名は、migration に `-- deploy: allow-row-loss <table>` と書いて宣言する。ロールバックは、main 上のコミット SHA を指定して実行する。

認証情報は Environment `production` の secret `OP_SA_DEPLOY` から 1Password の `gh-deploy/cloudflare-workers` を読む（`.github/deploy/production.env.op`）。

初めて出すときは、デプロイで migration が当たった後に、上の手順で名簿を入れる。
