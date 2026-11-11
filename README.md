# chakai

Task ledger that tells the owner and each AI agent apart.

chakai は、owner 1 人と複数の AI を区別して扱うタスク台帳。Cloudflare Worker（`chakai.chanu.co`）と D1 で動く。タスクを起票するのは AI で、どの書き込みも「誰が」「どの呼び出し元から」行ったかを履歴に残す。

## 構成

| 場所                      | 中身                                                             |
| ------------------------- | ---------------------------------------------------------------- |
| `worker/src/rest.ts`      | REST。機能の正                                                   |
| `worker/src/mcp.ts`       | MCP（Streamable HTTP）。道具を REST の入口へ写すだけの殻         |
| `worker/src/auth.ts`      | Cloudflare Access の JWT から actor と呼び出し元を決める         |
| `worker/src/ui/`          | owner の画面。サーバーで HTML を組み、書き込みは REST を呼ぶ     |
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
- agent が親の下に `todo` でタスクを作るとき、作るタスクから上へ agent が作ったタスクが続く数（作るタスク自身を含む）が `max_self_todo_depth` を超えると拒む。人が作ったタスクと、席に渡したことのあるタスク（`runs` に行がある）で数え直す。`backlog` で作るのは通すが、agent がそれを `todo` に上げるときにも同じ上限が掛かる。
- 仕分け待ちは、agent が起票した `backlog` で `triaged_at` が空のタスク。owner が状態を変えるか、`backlog` に残すと決めると `triaged_at` が入る。
- タスク同士の関係は「`from_task` が `kind` で `to_task`」と読む。`discovered_from`（見つけたタスク → 作業していたタスク）、`follows`（続きのタスク → 区切ったタスク）、`replaced_by`（やめたタスク → 作り直したタスク）。
- 同じタスクへの更新が重なったら、後から書く側が読み直してやり直す。`tasks.revision` は更新のたびに 1 増え、読んだ時点から進んでいる書き込みは D1 の trigger が拒む。`settings` も同じ仕組みで、行は消さない（上の scope に戻した行は `null` を持つ）。

## リンクと GitHub

- リンクはタスクかプロジェクトに付き、役割は `deliverable`（成果物）か `reference`（参考）。種類（`github_pr`・`github_issue`・`notion`・`x`・`url`）は URL から決める。
- 成果物にできるのは、タスクに付ける GitHub の PR だけ。それ以外は参考で、貼るだけで中身は取りに行かない。
- 成果物の PR は、状態（`open`・`closed`・`merged`）、draft か、base ブランチ、merge 先がその repo のデフォルトブランチか、レビュー状況、CI の結果を `github_links` に取り込む。取り込みは上書きで、`events` には残さない。
- PR の付け方は 2 通り。明示的に付けるか、PR の本文に `chakai:<タスクの ID>` と書いて同期に拾わせる。印を拾うのは、タスクのプロジェクトに紐付いた repo の PR だけで、開いている PR と、前回その repo を見た後に更新された PR を見る。fork からの PR と、repo の owner でも token のアカウントでもない人が作った PR の印は無視する。印は、前後に英数字やハイフンが続かない `chakai:<ID>` だけを読む。
- プロジェクトに紐付いていない repo の PR を明示的に付けると、その repo をプロジェクトに足す。
- 成果物の PR を付けたとき、GitHub の PR に `actor:<actor の ID>` ラベルを付ける。明示的に付けたときは付けた actor、印から付けたときはタスクの担当で、agent のときだけ付ける。ラベルが repo に定義されていなければ、作らずにリンクだけ付け、警告を返す。どちらで付けたかは、リンクの `source`（`explicit` か `marker`）に残る。印から付けたリンクは、同期を誰が呼んだかによらず、担当のラベルを付ける。付けるべきラベルは `github_links` に持ち、付いていない間は同期のたびに付け直す（merge 済みの PR も含め、1 回の同期で 30 本まで）。
- 同期は 1 時間ごとの Cron Trigger と、手動の `POST /v1/sync` で動く。成果物の PR から merge せずに閉じたものを除き、残りがすべてデフォルトブランチに merge されていて、少なくとも 1 つあるとき、タスクを `done` にする。当てるのは、子を持たない `todo`・`doing`・`review` のタスク。手で戻しても、条件を満たしている間は次の同期がまた `done` にする。
- Cron の同期が動かした書き込み（自動の `done`、印から付けたリンク）は、名簿の `sync`（kind `system`、無効）の操作として `events` に残る。手動の同期では、呼んだ actor と呼び出し元で残る。
- CI の結果は、PR の head の commit の `statusCheckRollup` から読み、読めなければ Actions の workflow run と commit status から決める。どちらも読めない repo では、結果を不明（`null`）として持つ。workflow run と commit status から読むのは 1 回の同期で 20 本まで（同時に 4 本まで）で、超えた PR も不明として持つ。読み始める PR は 1 時間ごとにずらす。
- PR の一覧を読めなかった repo は、次の同期で同じ起点から見直す。GitHub に繋がらない、応答が崩れているといった失敗は、警告にして同期の残りを続ける。
- 同期 1 回ごとの結果（時刻、Cron か手動か、呼んだ actor、取り込んだ PR・印から付けたリンク・done にしたタスクの数、警告）を `sync_runs` に残す。token が無くて同期しなかった回と、例外で終わった回も残す。残すのは新しい方から 50 件。
- GitHub の token（Worker の secret `GITHUB_TOKEN`）が無いときは、同期とラベル付けを止めて警告を返す。リンクを付ける操作を含め、ほかは動く。

## REST

| 入口                           | 用途                                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/projects`             | プロジェクトと repo、参考リンク（`links`）の一覧                                                                                                                        |
| `POST /v1/projects`            | プロジェクトを作る（`name`、`description`）                                                                                                                             |
| `POST /v1/projects/:id/repos`  | repo を紐付ける（`repo` は `owner/name`）                                                                                                                               |
| `GET /v1/tasks`                | タスクを探す（`project_id`、`q`、`state`（カンマ区切り）、`assignee_id`、`parent_id`、`label`、`awaiting_triage`、`limit`、`cursor`）                                             |
| `POST /v1/tasks`               | 起票する（`project_id`、`title`、`body`、`parent_id`、`state`、`assignee_id`、`labels`、`discovered_from`）                                                             |
| `GET /v1/tasks/:id`            | タスクを、関係（`relations`）とリンク（`links`。成果物の PR は `github` に取り込んだ状態を持つ）と一緒に読む                                                            |
| `PATCH /v1/tasks/:id`          | 更新する（`title`、`body`、`state`、`waiting_on`、`assignee_id`、`labels`、`order`）                                                                                    |
| `GET /v1/tasks/:id/next`       | 親の子孫のうち、木の順（深さ優先、同じ親の中は `order_key` の順）で最初の `todo` を `task` に返す。無ければ `null`。`descendant_states` は子孫の状態ごとの数            |
| `POST /v1/tasks/:id/relations` | `:id` のタスクから関係を付ける（`kind`、`to_task`、`run_id`）。`run_id` は `discovered_from` にだけ付けられ、`to_task` かその祖先を回した run に限る                    |
| `POST /v1/tasks/:id/triage`    | 仕分け待ちのタスクを `backlog` のまま仕分け済みにする。owner だけ                                                                                                       |
| `POST /v1/tasks/:id/links`     | タスクにリンクを付ける（`url`、`role`、`title`、`note`）。取り込みやラベル付けができなかった理由は `warnings` に入る                                                    |
| `POST /v1/projects/:id/links`  | プロジェクトに参考リンクを付ける（`url`、`role` は `reference`、`title`、`note`）                                                                                       |
| `DELETE /v1/links/:id`         | リンクを消す。前の値を履歴に残す                                                                                                                                        |
| `POST /v1/sync`                | GitHub と同期する。`synced`（取り込んだ PR の数）、`linked`（印から付けたリンク）、`done`（done にしたタスク）、`warnings` を返す。token が無ければ `skipped` が `true` |
| `GET /v1/sync-runs`            | 同期の結果を新しい順に読む（50 件まで）                                                                                                                                 |
| `POST /v1/runs`                | 席の実行記録を始める（`task_id`、`seat`、`model`、`hishaku_no`）。repo の無いプロジェクトのタスクは拒む                                                                 |
| `POST /v1/runs/:id/end`        | 実行記録を閉じる                                                                                                                                                        |
| `GET /v1/tasks/:id/runs`       | タスクを回した実行記録を、始めた順に読む                                                                                                                                |
| `GET /v1/settings/:scope`      | `:scope`（`global` かプロジェクトの ID）で効く設定と、その出どころ                                                                                                      |
| `PUT /v1/settings/:scope`      | 設定を書く（`key`、`value`。`value` が `null` なら上の scope の値に戻す）。owner だけ                                                                                   |
| `GET /v1/tasks/:id/events`     | タスクの履歴を古い順に読む（誰が、どの呼び出し元から、何を、前の値と後の値）                                                                                            |
| `GET /v1/actors`               | 名簿を読む（email は返さない）                                                                                                                                          |
| `GET /v1/labels`               | ラベルの一覧                                                                                                                                                            |
| `GET /health`                  | 疎通確認                                                                                                                                                                |

書き込み（`POST`・`PATCH`・`PUT`・`DELETE`）は、`Content-Type` が `application/json` のものだけを受ける（それ以外は 415）。Access のログインで来た書き込みは、`Origin` がこのホストと同じものだけを通す（無いか違えば 403）。service token の書き込みには `Origin` を求めない。

検索は `{ "tasks": [...], "next_cursor": "..." }` を返す。`limit` は既定 50、最大 90。`next_cursor` が `null` なら終端で、それ以外なら同じ検索条件と `cursor=<next_cursor>`（URL エンコードする）で続きを読む。MCP の `search_tasks` も同じ引数・返り値を使う。カーソルは不透明な値として扱い、内容を組み立てない。壊れた値・未知の版は 400 になる。

並びはプロジェクト ID、次に `order_key` のバイト順。カーソルは最後に返した行の位置を保持するので、既読の範囲への挿入で既存の結果がずれず、境界の後ろへの挿入は次のページに含まれる。検索全体のスナップショットではなく、既読の範囲に増えた行は再検索で読める。読み取り中に既存タスクの並びや状態を変えた場合、ページ間で重複・未取得になることはある。

## MCP

`POST /mcp` で受ける。道具は `list_projects`、`create_project`、`link_repo`、`search_tasks`、`get_task`、`create_task`、`update_task`、`relate_tasks`、`add_link`、`remove_link`、`sync`、`next_task`、`start_run`、`end_run`。使い方（起票の手順、状態を動かす時点、途中で分けるときの扱い、PR と資料の付け方、探し方）は、`initialize` が返す `instructions` に書いてある。`next_task`、`start_run`、`end_run` は、席を回す側のコードが呼ぶ。仕分けと設定の変更は owner の操作なので、道具には出さない。

## Web UI

owner が Access にログインして `https://chakai.chanu.co/` を開く。service token の呼び出しと、owner 以外の人には 403 を返す。

| 画面            | 中身                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `/`             | owner の番（`review` のタスクを、プロジェクトをまたいで待たせている順に）と、プロジェクトの一覧                                   |
| `/projects/:id` | プロジェクトの参考リンクと、タスクの親子ツリー。`?state=` で絞る（無ければ `done` と `dropped` を除き、`all` ですべて）           |
| `/tasks/:id`    | 本文、子タスク、成果物の PR（状態・レビュー・CI・最後に同期した時刻）、参考リンク、関係、実行記録、状態・担当・ラベルの変更、履歴 |
| `/triage`       | 仕分け待ち（プロジェクトをまたいで、起票の古い順に）。`todo` に上げる、`dropped` にする、`backlog` に残す、のどれかを選ぶ         |
| `/sync`         | 同期の結果を新しい順に。警告はその回の下に出す                                                                                    |
| `/settings`     | `max_self_todo_depth` の、全体の値とプロジェクトごとの上書き。効いている値と出どころ（既定・全体・プロジェクト）を出す            |

状態は一覧の各行でも変えられ、並びは行の ↑ と ↓ で、同じ親の隣のタスクと入れ替える。仕分け待ちの件数は、どの画面のナビゲーションにも出る。直近の同期に警告があれば、その数もナビゲーションの「同期」に出る。起票と、件名・本文の編集、リンクの追加と削除は画面に無い。

## 開発

```sh
pnpm install
pnpm run typecheck && pnpm run lint && pnpm test && pnpm run build
```

画面を手元で開くときは、手元の D1 に架空の名簿を入れてから `dev:ui` を使う。`dev:ui` の入口（`worker/scripts/dev-ui.ts`）は、Access の代わりに `owner@example.com` の JWT を署名して付ける。deploy する Worker には入らない。

```sh
cd worker
pnpm run db:migrate:local
OWNER_EMAIL=owner@example.com MAC_AGENT_CLIENT_ID=00000000000000000000000000000001.access pnpm run roster:init --local
pnpm run dev:ui
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

GitHub の token は、chakai 専用の fine-grained PAT（Pull requests と Issues が Read and write、Commit statuses と Actions が Read-only）を 1Password の `gh-deploy/chakai-worker` の `github_token` に置く。デプロイのたびに Worker の secret `GITHUB_TOKEN` に反映する。Pull requests の write は、PR にラベルを付けるために要る（Issues の write だけでは PR に付けられず 403 になる）。`actor:*` ラベルの定義は `ochanuco/chabatake` が持つ。

初めて出すときは、デプロイで migration が当たった後に、`roster:init` で名簿を入れる。
