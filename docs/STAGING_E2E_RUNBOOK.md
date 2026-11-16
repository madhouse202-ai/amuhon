# staging E2E: テスト決済から製本データ生成まで

更新日: 2026-11-16

この手順は `amuhon-staging` と Stripe のテストモードだけを対象にします。Cloud Run Job の手動実行はキューをClaimし、注文とStorageを書き換えるため、前提確認後に運営者が明示的に実行してください。この文書の作成・テストでは外部サービス、DB、Storage、Stripe、Cloud Runに接続していません。

## 処理経路と担当コード

1. `/api/orders` が注文ドラフトを作り、注文用の限定Cookieを返します。価格はクライアント値を信用しません。
2. `/api/orders/[id]/files` と検証APIが、本文PDF・表紙PNGを既存の非公開 `amuhon-order-files` バケットへ保存し、固定RPCで検証結果を確定します。
3. `/api/orders/[id]/checkout` は検証済み注文だけをCheckout可能にし、DBのCheckout許可ホスト、Stripe応答、注文価格・通貨・モードを確認します。
4. Webhook受信先は `/api/webhooks/stripe` です。raw bodyの署名、テスト/ライブモード、支払済み状態、金額・通貨・注文・試行・Session参照を確認し、`apply_amuhon_stripe_checkout_paid_v2` を呼びます。成功画面への戻りだけでは支払い確定になりません。
5. `20261115000200_order_pdf_render_jobs.sql` のトリガーが、注文の状態が新たに `paid` へ変わった同じDBトランザクションで注文あたり1件の生成ジョブを登録します。過去のpaid注文は自動登録されません。
6. `scripts/render-order-assets-worker.mjs --run-queue-once` がClaim RPCを一度呼び、対象を最大1件処理します。service-role-only RPCがpaid・検証済み・有効なSnapshot・30分以内のleaseを確認し、テーブルへの直接権限は引き続き拒否します。
7. ワーカーはAozoraの固定許可URLから本文を取得し、既存 `/final` と `/cover`、Playwright/Chromium、固定Noto Serif CJK JP、CDPフォント確認、A6/PDF/PNG品質検査を使用します。
8. 両ファイルの検査・ページ数・サイズ・SHA-256照合が済んだ場合だけ、既存バケットへlease固有パスで `x-upsert: false` 保存します。完了RPCがlease、paid状態、両方のファイル情報と注文時のページ数を再確認してから注文とジョブを確定します。
9. 管理者の注文詳細(`/admin/orders/[id]`)は認可後に生成状態を表示し、決済済みかつ検証済みファイルだけを保護されたAPIからダウンロードできます。

主要実装: `app/api/orders/route.ts`、`app/api/orders/[id]/files/route.ts`、`app/api/orders/[id]/validation/route.ts`、`app/api/orders/[id]/checkout/route.ts`、`app/api/webhooks/stripe/route.ts`、`lib/pdf-render-queue-worker.ts`、`lib/pdf-render-queue-supabase.ts`、`scripts/render-order-assets-worker.mjs`、`lib/pdf-renderer-worker.ts`、`app/api/admin/orders/[id]/route.ts`。

## 事前確認

1. Supabase Dashboardのプロジェクト選択が `amuhon-staging` であることを画面上で確認します。SQLだけでは開いているDashboardのProject Refを保証できません。本番 `amuhon` ならここで中止します。
2. Stripe Dashboardでテストデータ表示が有効であることを目視します。Checkout APIの設定も `STRIPE_MODE=test` とテスト用キーであることを、値を表示・コピーせず設定画面で確認します。ライブキー・ライブCheckout URLなら中止します。
3. stagingアプリとCloud Run JobのSupabase URL/Project Refが同じstagingを示すことを確認します。Cloud Runワーカーが外部から受け取る必須設定は `SUPABASE_URL`、Secret Managerからの `SUPABASE_SECRET_KEY`、`AMUHON_PDF_QUEUE_PROJECT_REF`、`AMUHON_PDF_QUEUE_ENABLED=true` です。Dockerfileは `NODE_ENV=production`、`AMUHON_PDF_WORKER_BROWSER_MODE=pinned`、port `3000`、固定フォントpathを既定設定します。Job設定でこれらをoverrideしていないか確認してください。秘密値は画面共有・ログ・コマンド出力に出しません。`NEXT_PUBLIC_SUPABASE_URL` だけではワーカーの `SUPABASE_URL` を満たしません。
   - Next.jsの `NEXT_PUBLIC_*` はクライアントbundleのbuild時に埋め込まれます。workerが開く `/final`、`/cover`、`/api/aozora` はSupabaseブラウザークライアントを使わないため、このキュー経路には公開URL/キーを渡す必要はありません。実行時に `NEXT_PUBLIC_SUPABASE_URL` を追加しても、build済みbundleの値は変わりません。
4. ワーカーJobのimageが意図した `linux/amd64` のdigestで、コンテナ引数が `--run-queue-once`、コンテナコマンドが空欄、タスク1/並列1/再試行0/timeout 20分であることをCloud Run画面で確認します。`Dockerfile.pdf-renderer` のENTRYPOINTは `node --experimental-strip-types scripts/render-order-assets-worker.mjs` なので、Job引数が正しくENTRYPOINTへ渡されます。空キューでの成功は設定・Claim RPC到達の確認にはなりますが、Chromium起動、Next.jsレンダリング、Storage、完了RPCの確認にはなりません。
5. Jobのサービスアカウントがstaging用Secret Manager Secretだけを読み取れること、Secretのversionが有効であることを確認します。Secret参照が `latest` の場合、実行ごとに解決されるversionが変わり得ます。再現性を優先する運用では、Secretの実際の値を表示せずversion番号だけを確認し、Jobが数値versionを固定参照することを推奨します。Stripeキーはレンダーワーカーへ与えません。Storageバケット `amuhon-order-files` が非公開であることもDashboardで確認します。
6. アプリ、worker、renderer、固定フォント取得処理を含むソースが、登録済みdigestを作成したソースと一致することを確認します。digest作成後に上記のいずれかを変更していたら、そのdigestを使いません。CI/build・self-test後に新しいdigestを登録し、Job設定を更新してから続行します。
7. Stripe Webhookの受信経路を一つだけ選びます。
   - stagingサイト: Stripe Dashboardのテスト用Webhook endpointに `checkout.session.completed` が登録され、配信先がstagingの `/api/webhooks/stripe` であること、最近のテストイベントが成功応答を受けたことを確認します。
   - localhostで注文フローを試す場合: 開発サーバーを起動したPCでStripe CLIを使い、`stripe listen --forward-to http://localhost:3000/api/webhooks/stripe --events checkout.session.completed` を実行します。CLIが表示する署名Secretはローカルの秘密設定にだけ登録し、画面共有・チャット・ログへ貼りません。CLI転送先をCloud Runや本番URLと混在させないでください。

Stripe CLIの転送方法は[Stripe CLI: listen for events](https://docs.stripe.com/stripe-cli/use-cli#forward-events)、署名検証は[Webhook signatures](https://docs.stripe.com/webhooks/signature)、テスト用カードは[Testing](https://docs.stripe.com/testing)を参照してください。

## 注文とテスト決済

1. stagingのWebアプリを使い、短編を選び、表紙を作り、完成ページ数を確認します。ページ数は本番の対応範囲かつ8ページ単位である必要があります。注文画面で本文PDF・表紙PNGの両方が検証済み、サーバー確定価格が表示されてからCheckoutへ進みます。最初の価格帯を試す場合は実際の見積りが1,980円であることを画面で確認し、クライアント値は指定しません。
2. Checkout画面がStripeテストモードのものであることを目視します。現行Checkoutはカード決済のみを要求するため、Stripe公式のテストカードを使い、実カード情報を入力しません。テストカード番号・日付・CVCは[Stripe Testing](https://docs.stripe.com/testing)を参照します。テスト決済はStripe test dataに記録されますが、実際の請求・製本発注は行いません。支払い方法を非同期方式へ広げる前に、対応するWebhookイベントと状態遷移の実装・テストが別途必要です。
3. Checkoutから戻っただけでは成功扱いにしません。Webhookの配信履歴で `checkout.session.completed` が署名検証を通って成功応答になり、管理画面で支払いが `paid`、生成状態が `queued` になるまで待ちます。失敗イベントや`payment_status`未払いでは進みません。

このworkerは製本直送.comへの注文・入稿を呼び出しません。E2E確認中に管理画面の「入稿済みにする」も押しません。

## キュー確認ゲート

Jobを実行する直前に、Supabase SQL EditorのProject selectorが `amuhon-staging` であることをもう一度確認し、次の集計SELECTを実行します。結果を注文番号・個人情報と一緒に共有しません。SQLは集計のみで、業務RPCも呼びません。

```sql
select
  count(*) filter (where jobs.state = 'queued') as queued_jobs,
  count(*) filter (where jobs.state = 'rendering') as rendering_jobs,
  count(*) filter (where jobs.state = 'succeeded') as succeeded_jobs,
  count(*) filter (where jobs.state = 'failed') as failed_jobs,
  count(*) filter (where orders.status is distinct from 'paid') as jobs_not_paid,
  count(*) filter (where orders.files_validated_at is null) as jobs_without_verified_assets
from public.amuhon_order_pdf_render_jobs as jobs
join public.amuhon_orders as orders on orders.id = jobs.order_id;
```

SQL Editorの集計と、認証済み管理画面の対象注文詳細を合わせて確認します。これから処理する注文が `paid` と `queued`、ファイル検証済みであり、全体の `queued_jobs` が1件だけ、他状態に想定外の行がない場合にだけ続行します。想定外のqueued/rendering行、テーブル不存在、問い合わせエラー、対象が特定できない状態では実行しません。過去のpaid注文で `not_queued` があることだけでは異常ではありません（このマイグレーションはbackfillしません）。

## Cloud Run Jobの1回実行

キュー確認ゲートを通過した後、Google Cloud Consoleでプロジェクト `amuhon-staging`、リージョン `asia-northeast1`、Job `amuhon-pdf-renderer` を再確認してから一度だけExecuteします。Windows PowerShellで実行する場合:

```powershell
gcloud run jobs execute amuhon-pdf-renderer --project=amuhon-staging --region=asia-northeast1 --wait
```

このコマンドはDB Claim、Storage保存、完了RPCを実際に実行するため、確認前に実行しません。ワーカーは最古のeligible jobをClaimし、任意のorder IDを受け取らない設計です。GoogleのCLIリファレンスでは `--wait` は実行完了まで待つ指定です（[gcloud run jobs execute](https://docs.cloud.google.com/sdk/gcloud/reference/run/jobs/execute)、[Execute jobs](https://docs.cloud.google.com/run/docs/execute/jobs)）。実行後は同一のstagingプロジェクトとexecutionを開き、秘密を含まない固定ログコードだけを確認します。

## 成功判定

すべて満たした場合だけE2E成功とします。

- StripeテストイベントのWebhook配信が署名検証済みで2xx応答。
- 管理画面で対象注文の支払いが `paid`、生成状態が `succeeded`、attempt countが1以上5以下。
- Cloud Run taskがexit 0で、固定ログに `PDF_QUEUE_JOB_SUCCEEDED` と `APP_SERVER_STOPPED` がある。`PDF_QUEUE_IDLE` は成功した注文処理ではありません。
- 管理者認証後の既存ダウンロードAPIから本文PDF・表紙PNGの両方を取得でき、表示内容・A6寸法・ページ数・ルビ・文字・目次を目視確認できる。公開Storage URLや秘密URLを作らない・共有しない。
- PDFのページ数は注文時の検証済みページ数と一致し、生成物のサイズとSHA-256が注文に記録され、注文の支払い・価格状態が維持されている。

成功したstagingのテスト注文・ファイルは確認記録として残します。今回のE2E確認後に手動削除や決済状態の巻き戻しは行わず、必要なデータ保持・削除は別途承認された運用手順に従います。

## 失敗時の停止・再試行・後片付け

- Jobが非0終了、timeout、または `PDF_QUEUE_FINALIZATION_UNKNOWN` ならすぐ再実行せず、まず管理画面の生成状態とattempt count、StripeのテストWebhook配信、Cloud Run固定ログを確認します。例外本文、注文snapshot、URL、環境変数、秘密値は共有しません。
- Cloud Run retryは0、DB leaseは最大30分です。強制終了後に `rendering` が残る場合はlease期限を過ぎるまで待ちます。DBが `queued` に戻ったこと、対象注文・queue countが依然想定どおりであることを読み取り確認後に限って、運営者が次のJobを実行します。
- DB attempt countは最大5です。`failed` は自動的に無制限再試行しません。PDF品質・ページ数・Snapshot・ハッシュの失敗を設定変更で回避せず、原因を修正してから再処理方針をレビューします。
- Storageの片側だけ保存された場合、ファイルは非公開のlease固有パスに孤立している可能性があります。`x-upsert:false`のため上書きされず、完了RPCが成功するまで注文参照は変わりません。状態を確かめずにファイル削除、注文更新、leaseの直接変更、Cleanup SQLを実行しません。
- 支払い済み注文の `not_queued` はこのmigrationが過去注文をbackfillしない仕様による場合があります。ad hoc SQLでキューに登録せず、現在の注文とWebhook記録を認可済み画面・既存の読み取り手順で確認してから別途判断します。
- 一回の成功後もSchedulerはすぐ有効化せず、実行時間・タイムアウト・失敗コード・費用見積りを確認してから別工程で設定します。

## この手順の検証範囲

`npm run test:staging-e2e-contract` はStripe署名済みイベント、重複イベント、paid→queue境界、Queue adapter、create-only private Storage要求、完了RPCをすべてモックして接続契約を検査します。これは実Stripe/Supabase/Cloud RunのE2Eではありません。キュー単体テストは `npm run test:pdf-render-queue`、Webhook/Checkoutは `npm run test:order-checkout` です。クラウド実行・注文・Storage・実際のPDF再生成は、上記の人手確認後の一度限りのstaging操作として残ります。
