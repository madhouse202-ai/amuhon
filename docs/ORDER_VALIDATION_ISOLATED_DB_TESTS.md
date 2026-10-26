# 注文検証RPCの隔離DBテスト準備（STEP 4-B）

この文書は、注文検証SQLを実PostgreSQLで検証するための準備手順です。作成時点では、ソフトウェアのインストール、Supabaseへの接続、SQL実行、プロジェクト作成は行っていません。共有 `amuhon-staging` と本番 `amuhon` はテスト先にしません。

## 結論と推奨方式

第一候補は、**Supabase CLIのローカルスタックを、リポジトリ外の使い捨て作業ディレクトリで起動する方法**です。Supabaseが管理するPostgreSQLロール、Storageスキーマ、RLS、`SECURITY DEFINER` を最も近い形で再現でき、ローカル利用はプロジェクトのクラウド使用量を消費しません。公式手順ではWindows上の標準実行にSupabase CLIとDocker互換コンテナランタイム（Docker Desktop推奨）が必要です。[Supabase Local Development](https://supabase.com/docs/guides/local-development), [CLI Quickstart](https://supabase.com/docs/guides/local-development/cli/getting-started?platform=npm&queryGroups=platform)

ただし、現時点のPCでは `supabase`、`docker`、`psql`、`postgres`、`initdb`、`pg_ctl` コマンドが見つからず、PostgreSQLプロセスも確認されませんでした。WSLは未導入と表示されました。サービス一覧の確認は権限エラーでできていません。リポジトリには `supabase/config.toml` がありません。このため、**現時点で実SQLテストを実行できる準備状態ではありません**。この作業では不足ソフトをインストールしていません。

また既存テストは手動確認用センチネルが `amuhon-staging` 固定です。ローカルDBではこのまま実行するとガードで停止します。共有環境の安全ガードを外してstaging値に合わせるのではなく、将来、ローカル専用の識別値を明示的に許すテストハーネスを別途レビューしてから使ってください。今回SQLやテストは変更していません。

## 方式の比較

| 方式 | 再現性 | 導入難易度 | 費用・安全性 | このプロジェクトでの評価 |
|---|---|---|---|---|
| Supabase CLIローカルスタック | 高い。Postgresに加えてAuth/Storage等のローカルサービスを同じスタックで起動 | 中〜高。CLI、Docker互換ランタイム、ローカル設定が必要。現在はいずれも未導入（WSLも未導入） | ローカル開発自体はSupabaseのプロジェクト枠・クラウドクォータを消費しない。DockerのPC負荷・利用条件は別途確認 | **推奨**。Storageスキーマ、Supabaseロール、RLSポリシーも含むmigration適用に最も適する |
| WindowsネイティブPostgreSQL | PostgreSQL構文、トランザクション、ロック、関数、通常のロール権限を再現 | 中。PostgreSQLサーバー/クライアント、テストDB、Supabase固有のロールとStorage互換スキーマを準備する必要 | ローカルで完結しクラウド課金なし。Supabase Storage実装・JWT/RLS統合は再現できない | SQLの基礎構文や競合試験の補助に有用。ただし本件の全migrationをそのまま検証するには不足スキーマの保守が必要 |
| 独立Supabaseプロジェクト | 高い。実際のマネージドPostgres・Storage・ロール構成を確認できる | 低〜中。ただし新規プロジェクト作成、設定、適用前レビューが必要 | Free枠が利用可能か、プロジェクト枠、停止条件、ストレージ/転送量、請求設定はアカウントごとに未確認。現在の公式料金ページではFreeに2 active projects、500MB DB、1GB file storage等の表示があるが、本アカウントへの適用可否や将来の料金は未確認。[公式料金](https://supabase.com/pricing) | 最終的なSupabase固有動作確認の候補。今回は作成禁止であり、ローカル検証後の別段階にする |

Supabase CLIのローカルスタックはDocker Desktop、Rancher Desktop、Podman等のDocker API互換ランタイムが前提です。現行公式ガイドの実験的なDockerなしランタイムはLinuxおよび一部macOS向けであり、このWindows環境の代替として前提にしません。[Docker and native runtimes](https://supabase.com/docs/guides/local-development/docker-and-native-runtimes)

## リポジトリで確認した依存関係

空DBへ適用する場合のファイル順は、ファイル名の時系列順です。

1. `supabase/migrations/20261017000100_order_drafts.sql` — 注文・レート制限、注文更新ガード、非公開の `amuhon-order-files` バケットと `storage.objects` ポリシーを設定。
2. `supabase/migrations/20261020000100_order_asset_uploads.sql` — 注文アップロード情報、レート制限、アップロードRPC。
3. `supabase/migrations/20261020000200_order_asset_size_limit.sql` — 既存の `storage.buckets` 行とバケット条件を検査・更新。
4. `supabase/migrations/20261020000300_order_temp_uploads.sql` — 一時バケット、`storage.objects` ポリシー、一時試行テーブルとRPC。
5. `supabase/migrations/20261021000100_order_validation_jobs.sql` — 検証ジョブ表、enqueue/claim/fail/retry/cleanup RPC。
6. `supabase/migrations/20261022000100_order_validation_asset_commit.sql` — 検証済みアセット列、原子的commit/status RPC、試行清掃適格性の更新。
7. `supabase/migrations/20261025000100_order_validation_targeted_claim.sql` — 全体claimのJSON契約更新と指定注文・attempt専用claim RPC。

最初のmigrationから `storage.buckets` と `storage.objects` が参照され、後続migrationもバケット行の存在やStorageポリシーを前提にします。したがって通常のPostgreSQLだけを用いる場合、単に `public` のテーブルを作るだけでは全migrationを適用できません。Supabase CLIローカルスタックにはStorageスキーマが含まれます。ネイティブPostgreSQL方式ではStorage互換スキーマ/ロール/ポリシーのテスト用基盤を別途用意する必要があり、それはSupabase Storageの実装テストにはなりません。

テストの役割と安全範囲：

- `supabase/tests/order_validation_targeted_claim.test.sql` は合成UUIDの注文・試行・ジョブだけを使い、指定claimのみを呼び、Storageや全体claim/清掃RPCを使わず、最後に `ROLLBACK` します。順次実行の二重claim/no-fallback等を確認しますが、複数セッションの本当の同時実行は検証しません。
- `supabase/tests/order_validation_asset_commit.test.sql` は合成データでcommit/status/不正条件と、試行IDを指定した清掃claim/finishのDB状態を検査します。Storage I/Oや実オブジェクト削除は行わず、最後に `ROLLBACK` します。
- `supabase/tests/order_validation_jobs.test.sql` は**全体claim RPC**を呼びます。合成行以外をclaimする競合窓があるため、共有staging・本番では実行禁止です。
- `supabase/tests/order_validation_jobs_cleanup.isolated.sql` は全体清掃RPCを呼ぶ隔離DB専用テストです。共有staging・本番では実行禁止です。
- `supabase/tests/order_drafts.test.sql`、`order_asset_uploads.test.sql`、`order_temp_uploads.test.sql` も清掃/レート制限/アップロード系RPCを含むため、初回ローカル検証では個別に内容をレビューしてから実行します。特に全体claimや期限切れデータを拾うRPCを呼ぶテストを共有DBで使いません。
- `npm run test:order-validation-sql` はNode.jsによるSQLソース静的テストであり、PostgreSQLに接続・実行する統合テストではありません。

既存のSQLテストには `confirmed_project` のstaging用センチネルと、`current_user = 'postgres'` の確認があります。ローカル実行ではセンチネルのままなら意図的に停止します。**センチネルを書き換えたSQLをstagingで実行してはいけません。** 将来ローカルで実DBテストする前に、環境を一意に識別するローカル専用ガードを追加する設計・レビューが必要です。この文書作成ではその変更をしていません。

## ローカルSupabase方式の準備手順

以下は今後の作業手順であり、今回は実行していません。

1. **導入前確認**：ディスク空き容量、RAM、CPU、Docker Desktopの利用資格/ライセンス、Windowsの仮想化要件を確認する。Docker Desktopの費用・ライセンス適用条件はこの調査では判定していません。
2. **隔離ディレクトリ**：このリポジトリや `.env.local` を使わない、明確にローカル専用の一時作業ディレクトリを決める。DashboardのURL、`SUPABASE_URL`、service-role keyを貼らない。既存 `.env.local` を読み込む手順を作らない。
3. **必要ツールの導入（別途許可後）**：Docker互換ランタイムとSupabase CLIを公式手順で用意する。今回インストールはしていない。実行前に `docker version` と `supabase --version` がローカルに応答することを確認する。
4. **ローカル設定**：隔離ディレクトリ内だけでSupabaseローカル設定を準備する。リポジトリには `supabase/config.toml` がないため、既存のローカル設定を前提にしない。CLIの初期化がmigrationファイルを自動実行/上書きしないことを確認し、migrationとtestsのコピーは原本を変更しない方法で行う。
5. **スタック起動と接続先検証**：CLIが出すDB接続先が `127.0.0.1`/`localhost` であることを確認する。`amuhon-staging` や本番のProject URL/refを設定しない。CLIのlocal statusで接続情報を確認し、SQL接続後も `current_database()`、`current_user`、サーバーアドレス/ポートを表示してローカルであることを検証する。接続先を証明できなければ停止する。
6. **migration適用**：空のローカルDBに、上記1〜7の順で適用する。まずCLIがローカル専用として生成するmigration実行方法を確認する。手動の場合はファイルを1つずつ順番に適用し、各成功を確認する。`--linked`、`--project-ref`、Dashboard SQL Editor、`.env.local` は使用しない。失敗したら次のmigrationへ進まず、DBを追加操作せずエラーを記録する。ローカル専用DB全体を捨てて再作成する場合も、接続先をローカルと再確認してから行う。
7. **テスト準備**：センチネルを含む既存SQLテストをそのまま実行しない。まず後述のローカル専用センチネル仕様を別途実装・レビューし、ローカル以外を拒否することを静的に確認する。共有staging用の確認値を使い回さない。
8. **合成データテスト**：指定claimテスト、次にasset commitテストをローカルの `postgres` で各々実行し、結果表示と最終ROLLBACKを確認する。テスト失敗やSQL Editor/psqlの切断時は、そのDBセッションの状態を確認する。隔離ローカルDB全体がテスト専用であることが最終的な保護になる。
9. **グローバル処理テスト**：global claim/cleanupテストは必要性・ソースを別レビューしたうえで、空の使い捨てDBだけに限定する。既存の2つの安全寄りテストを通すだけなら、グローバルclaim/cleanupテストは実行しない。

Supabase公式はローカル開発をクラウドのクォータを消費しない方法と説明し、`supabase db reset` はローカルDBを破棄して全migrationを再適用すると説明しています。[Local Development](https://supabase.com/docs/guides/local-development), [Local workflow](https://supabase.com/docs/guides/local-development/cli-workflows) 本プロジェクトにはCLI設定が未整備なので、`db reset`等のCLIコマンドを使う前には対象がローカルであることを確認し、`--linked`を付けないことが必須です。

## ネイティブPostgreSQL方式の準備

ネイティブPostgreSQLを選ぶ場合も、既存の注文DBとは別の専用DBを使い、ローカルループバックに限定します。必要な準備はPostgreSQL Serverと `psql`、専用DB、Supabase相当の `anon`/`authenticated`/`service_role` ロール、Supabaseが通常提供する `postgres` 所有者と権限構造です。ロール属性をSUPERUSERへ変更する必要がある設計は避けます。

加えて、migrationが参照する `storage` スキーマ、`storage.buckets`/`storage.objects` の最小互換定義、ポリシー関連のカタログ条件、private bucketの合成行が必要です。これらをテスト用に作ることはSupabase Storageそのものの再現ではなく、独立したテスト基盤の保守が必要です。migrationが要求するExtensionがあればローカルの利用可否も確認してください。テストは初期化スクリプトを含めて再現可能にし、ローカルアドレス以外への接続を拒否する手順を置きます。

この方式ではPostgreSQL関数・制約・RLS有効化・GRANT/REVOKE・ロック/トランザクションの試験はできます。一方、Supabase Storage API、署名URL、TUS、実際のStorage RLSとの相互作用、Supabase管理ロールの細部を合格と見なすことはできません。

## 接続先を誤らないための必須確認

- テスト用のDB名に `amuhon_local_test` など明確な非本番語を含め、既存の `amuhon` / `amuhon-staging` と異なることを確認。
- ホストをループバック `127.0.0.1` または `localhost` に固定し、接続先の表示で再確認。
- Cloud project URL/refや `.env.local` の環境変数を接続元として使わない。
- 実行前にDB名・ホスト・ポート・実行ユーザーだけ確認する。接続文字列、キー、パスワードは画面共有・ログ・チケットに貼らない。
- ローカル環境の識別センチネルは将来の専用ロジックで `amuhon-local-isolated` 等を明示し、staging値のままにしない。センチネルだけに頼らず、ホストとDB名も独立に確認。
- テストの対象は合成UUIDだけ。`order_validation_jobs.test.sql` および `order_validation_jobs_cleanup.isolated.sql` は共有環境へ絶対に実行しない。

## 複数DBセッションでの二重claim / SKIP LOCKED確認

既存のtargeted-claim SQLテストは単一トランザクションの順次確認であり、真の並行性を証明しません。並行テストは専用の使い捨てローカルDBに限り、別途レビュー済みの合成fixtureを使います（今回はfixture作成・SQL実行をしていません）。

1. 2つの独立した `psql` セッションを、同一のローカル専用DBに接続し、ホスト・DB名・ユーザーを双方で照合する。
2. ランダムな合成order/attempt/jobを作成し、両セッションから見えるようfixture作成だけをコミットする。これらのUUIDをログに出しても個人情報ではないが、実データのIDは使わない。
3. 競合テストA：セッション1で合成order（別ケースではattempt/job）行をロックしたまま保持し、セッション2から指定claimを行う。`SKIP LOCKED` 契約上、処理対象なしとなり、別jobへフォールバックしないことを確認する。
4. 競合テストB：ロックを解放後、両セッションから同一order/attemptのclaimを同時に開始する。片方だけが新しいリース付きclaimを得て、他方は対象なしとなること、jobの試行回数・リースが二重更新されないことを確認する。
5. 競合テストC：期限切れリースの再claim後、以前のリースIDで完了/commitが拒否され、新しいリースIDだけが有効であることを確認する。
6. テスト後は、合成fixtureだけの状態を監査する。推奨はテストDB自体を破棄して最初から再構築することで、既存データを削除する運用ではなく、空の一時環境を捨てる手順として行う。

同一トランザクション内でfixtureを作ってROLLBACKする既存SQLテストは、別セッションからfixtureが見えないため、そのまま並行テストには使えません。専用の並行テストハーネスが必要です。

## 追加で必要なソフトウェア・費用の確認

現時点で不足していることを確認できたツール：

- Supabase CLI（未検出）
- Docker互換コンテナランタイム（Dockerコマンド未検出。Docker Desktop等の導入状態は未確認）
- PostgreSQLクライアント/サーバー（`psql`、`postgres`、`initdb`、`pg_ctl` 未検出）
- WSL（未導入と表示）

推奨方式の最小候補はSupabase CLIとDocker Desktopです。ネイティブPostgreSQL方式ならPostgreSQL Server/Clientは必要ですが、WSLは不要です。独立Supabaseプロジェクト方式はプロジェクト作成が必要なので今回の禁止条件により実施していません。

ローカルSupabaseのクラウド利用料は発生しませんが、PCのディスク/RAM/CPU使用、Docker Desktopのライセンス適用、導入作業のコストは残ります。独立Supabaseプロジェクトの現在のアカウント枠、Free枠の利用可否、長期保管や超過時の料金は未確認です。金額を確定する前にDashboardのBilling/Usageと公式料金を再確認してください。

## 実行前チェックリスト

- [ ] 作業対象はリポジトリ外の使い捨てローカルディレクトリ。
- [ ] 使用DBは空のローカル専用DBで、DB名がstaging/productionと異なる。
- [ ] 接続先ホストは `127.0.0.1` / `localhost`。クラウドProject URL/refを含まない。
- [ ] `.env.local`やservice-role keyを読み込ませていない。
- [ ] Storageスキーマ/ロールが必要な方法を選び、その範囲と限界を理解した。
- [ ] 全migrationをファイル名順で空DBへ適用する計画になっている。
- [ ] ローカル専用sentinelを持つテスト版を別途レビュー済み。staging sentinelのまま実行しない。
- [ ] targeted claim/asset commitテストだけ先に実行し、全体claim/cleanupテストは実行対象から外した。
- [ ] 並行試験は単一トランザクションのROLLBACKテストとは分離し、合成fixtureのみを使う。
- [ ] エラー時に共有stagingへ切り替えて続行しない。ローカル接続先を再確認し、必要ならローカルDB全体を使い捨てとして再構築する。

## 未確認事項

- Docker Desktopのインストール有無、利用可能なRAM/CPU/ディスク、ライセンス適用条件。
- PostgreSQL Windows Serviceの状態（サービス一覧の確認は権限エラー）。
- Supabaseアカウントのプロジェクト枠、請求設定、独立プロジェクトの実際の料金。
- 既存SQLテストのローカル専用sentinel対応。現状のままではローカルDB向けガードを通らない。
- ローカルSupabase CLIが本プロジェクトの全migrationを追加互換スキーマなしで適用できるか。CLI設定がなく、実行もしていないため未確認。
- 複数セッションでのclaim競合結果。今回はSQLもワーカーも実行していない。
- この調査ではSupabase接続、SQL実行、ソフトウェア導入、外部プロジェクト作成、Git操作を一切行っていません。
