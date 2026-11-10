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
- 子が `done` か `dropped` になり、同じ親の子がすべて `done` か `dropped` になったら、`todo` か `doing` の親を `review` にする（`waiting_on` は「子タスクがすべて片付いた」）。履歴には、きっかけになった操作の actor と呼び出し元で残す。親は自動では `done` にしない。
- agent が親の下に `todo` でタスクを作るとき、作るタスクから上へ agent が作ったタスクが続く数（作るタスク自身を含む）が `max_self_todo_depth` を超えると拒む。人が作ったタスクで数え直す。`backlog` で作るのは通す。
- 仕分け待ちは、agent が起票した `backlog` で `triaged_at` が空のタスク。owner が状態を変えるか、`backlog` に残すと決めると `triaged_at` が入る。
- タスク同士の関係は「`from_task` が `kind` で `to_task`」と読む。`discovered_from`（見つけたタスク → 作業していたタスク）、`follows`（続きのタスク → 区切ったタスク）、`replaced_by`（やめたタスク → 作り直したタスク）。
- 同じタスクへの更新が重なったら、後から書く側が読み直してやり直す。`tasks.revision` は更新のたびに 1 増え、読んだ時点から進んでいる書き込みは D1 の trigger が拒む。

## REST

| 入口                           | 用途                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/projects`             | プロジェクトと repo の一覧                                                                                                                                   |
| `POST /v1/projects`            | プロジェクトを作る（`name`、`description`）                                                                                                                  |
| `POST /v1/projects/:id/repos`  | repo を紐付ける（`repo` は `owner/name`）                                                                                                                    |
| `GET /v1/tasks`                | タスクを探す（`project_id`、`q`、`state`（カンマ区切り）、`assignee_id`、`parent_id`、`label`、`awaiting_triage`、`limit`）                                  |
| `POST /v1/tasks`               | 起票する（`project_id`、`title`、`body`、`parent_id`、`state`、`assignee_id`、`labels`、`discovered_from`）                                                  |
| `GET /v1/tasks/:id`            | タスクを、関係（`relations`）と一緒に読む                                                                                                                    |
| `PATCH /v1/tasks/:id`          | 更新する（`title`、`body`、`state`、`waiting_on`、`assignee_id`、`labels`、`order`）                                                                         |
| `GET /v1/tasks/:id/next`       | 親の子孫のうち、木の順（深さ優先、同じ親の中は `order_key` の順）で最初の `todo` を `task` に返す。無ければ `null`。`descendant_states` は子孫の状態ごとの数 |
| `POST /v1/tasks/:id/relations` | `:id` のタスクから関係を付ける（`kind`、`to_task`、`run_id`）                                                                                                |
| `POST /v1/tasks/:id/triage`    | 仕分け待ちのタスクを `backlog` のまま仕分け済みにする。owner だけ                                                                                            |
| `POST /v1/runs`                | 席の実行記録を始める（`task_id`、`seat`、`model`、`hishaku_no`）。repo の無いプロジェクトのタスクは拒む                                                      |
| `POST /v1/runs/:id/end`        | 実行記録を閉じる                                                                                                                                             |
| `GET /v1/settings/:scope`      | `:scope`（`global` かプロジェクトの ID）で効く設定と、その出どころ                                                                                           |
| `PUT /v1/settings/:scope`      | 設定を書く（`key`、`value`。`value` が `null` なら上の scope の値に戻す）。owner だけ                                                                        |
| `GET /health`                  | 疎通確認                                                                                                                                                     |

## MCP

`POST /mcp` で受ける。道具は `list_projects`、`create_project`、`link_repo`、`search_tasks`、`get_task`、`create_task`、`update_task`、`relate_tasks`、`next_task`、`start_run`、`end_run`。使い方（起票の手順、状態を動かす時点、途中で分けるときの扱い、探し方）は、`initialize` が返す `instructions` に書いてある。`next_task`、`start_run`、`end_run` は、席を回す側のコードが呼ぶ。仕分けと設定の変更は owner の操作なので、道具には出さない。

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

## 名簿に呼び出し元を足す

service token を使う呼び出し元を足すときは、名前、Client ID、名乗ってよい actor の一覧、既定の actor を環境変数で渡す。`CALLER_ACTORS` は `名前` か `名前:runtime` をカンマで並べる。一覧の actor が名簿に無ければ、kind `agent`・role `member` で作る。`CALLER_DEFAULT_ACTOR` を渡さなければ、既定の actor の無い（必ず `X-Actor` で名乗る）呼び出し元になる。

mizuya の Working を足す例。`yukarin` と `akarin` を名乗れて、既定の actor は無い。

```sh
cd worker
CALLER_NAME='mizuya-working' \
CALLER_CLIENT_ID="$(op read 'op://chabatake-services/mizuya-working/cf_access_chakai_client_id')" \
CALLER_ACTORS='yukarin:claude-cli,akarin:codex-cli' \
pnpm run roster:add-caller --remote
```

足した行はすべて `events` に、`owner` の操作として残す。そのため、先に `roster:init` で `owner` を入れておく。もう入っている行（同じ Client ID の呼び出し元、同じ名前の actor）は変えないので、何度流してもよい。後から actor を増やすときは、増やした一覧で流し直す。

## デプロイ

`deploy` workflow を手動（`workflow_dispatch`）で実行する。Environment `production` の承認の後に、`worker/scripts/deploy.sh` が未適用の D1 migration を当ててから `wrangler deploy` する。migration の前後で `worker/scripts/d1-guard.mjs` がテーブルの行数を比べ、行が減ったテーブルか、行が入ったまま消えたテーブルがあれば、Worker を出さずに止める。意図した削除や改名は、migration に `-- deploy: allow-row-loss <table>` と書いて宣言する。ロールバックは、main 上のコミット SHA を指定して実行する。

認証情報は Environment `production` の secret `OP_SA_DEPLOY` から 1Password の `gh-deploy/cloudflare-workers` を読む（`.github/deploy/production.env.op`）。

初めて出すときは、デプロイで migration が当たった後に、`roster:init` で名簿を入れる。
