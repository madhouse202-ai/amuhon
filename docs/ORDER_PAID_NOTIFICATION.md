# 決済完了メール通知（staging運用手順）

## 動作の概要

Stripe Webhookは署名・決済内容を検証し、決済反映RPCを実行します。DBトリガーがその同じトランザクション内で管理者向け通知outboxを1注文1行だけ作成し、Webhookは保存状態を読み取り確認してHTTP 2xxを返します。Resendへの送信はWebhookでは行いません。Webhook再送は通知の再試行に使わず、通知用Cloud Run Jobが独立してclaim・送信・完了記録を行います。

お客様向けの注文確定・発送メールは追加のprivate outboxを使い、同じ独立workerが期限順に処理します。設定は別スイッチで既定OFF、staging宛先はallowlist限定です。適用手順と安全なテスト方法は[お客様向け注文メール通知](./CUSTOMER_ORDER_NOTIFICATIONS.md)を参照してください。

更新版workerは`claim_next_amuhon_email_notification_v1`を使うため、既存の決済通知migrationに加えて、顧客通知migrationもコード配備前に適用する必要があります。顧客通知migrationが未適用の状態でworker/Webhookコードだけを先行配備しないでください。

outboxのリースと注文単位の固定Resend冪等キーで、同じ注文を複数ワーカーが同時送信することや、送信成功後の完了RPCタイムアウトによる二重メールを防ぎます。送信エラーはDBに固定エラーコードで記録し、次のScheduler実行で再試行します。再試行は最大8回、初回試行から23時間までです。上限到達後は`needs_review`となり、管理者注文詳細に表示されます。DB記録自体が一時失敗した場合はリース期限切れ後に再claimされ、Resend冪等キーを使って安全に結果を回復します。

通知用Cloud Run JobはPDF生成Jobと別のJob・サービスアカウント・Schedulerで実行します。コンテナイメージは既存のPDFレンダラーと共用しますが、実行コマンドを専用Nodeワーカーに上書きします。したがって通知失敗がPDF生成キューを消費せず、PDFの再実行がResend送信を起こしません。

## 通知対象の固定

マイグレーションは通知設定を`enabled=false`で初期化し、既存のpaid注文をバックフィルしません。

- 設定OFF中に新たにpaidへ遷移した注文は`suppressed`として記録されます。この行は後から設定をONにしても送信されません。
- マイグレーション適用前にpaidだった注文は通知行がないままです。Webhookの重複受信も通知行を作成しません。
- 設定ON中に新たにpaidへ遷移した注文だけが`queued`になります。
- すでにqueuedの注文は一時的な停止後に再開できます。停止前から送信対象だった通知を保留したい場合は、DB設定だけでなくSchedulerも停止し、管理画面で状態を確認してください。

設定テーブルとoutboxはRLS有効、直接権限なしです。`SUPABASE_SECRET_KEY`を使う専用workerだけがRPC経由で処理します。アプリ環境変数のフラグをONにする方式ではありません。DB設定が唯一の送信ゲートです。

## 環境変数とSecret Manager

通知用Jobに必要な環境変数は次のとおりです。

- `SUPABASE_URL` — stagingプロジェクトのURL
- `AMUHON_NOTIFICATION_QUEUE_PROJECT_REF` — 固定値`ahxnmkuvdpzctcwcyadl`
- `SUPABASE_SECRET_KEY` — staging用Secret Manager参照
- `RESEND_API_KEY` — Resend APIキーのSecret Manager参照
- `AMUHON_PUBLIC_ORIGIN` — 本番メールの管理画面リンクに使う、許可済みHTTPSオリジン（`https://amuhon.jp`）。stagingのSupabase URLを使うworkerは、この値が設定されていてもメールにリンクを含めず、注文番号で管理画面を検索する案内だけを記載します。

キーの値をCloud Run通常環境変数、ソース、ビルド引数、コマンドラインに書かず、Secret Managerから参照します。通知workerのサービスアカウントには上記2つの秘密だけを読む権限を個別に付与します。Stripe、Storage、Artifact Registryの権限は不要です。

## stagingで有効化する前の操作順

この変更ではDBマイグレーション、Cloud Run、Scheduler、Secret Managerを変更していません。次は**運営者が staging のみで**行う手順です。実行前に、stagingプロジェクト・リージョン・既存リソースを読み取り確認してください。

1. `supabase/migrations/20261123000100_order_paid_notification_outbox.sql`をレビューし、`amuhon-staging`のSQL Editorで一度だけ適用します。成功後、次の読み取り専用SQLで設定行が1件かつ`enabled=false`、outboxが空（過去注文をbackfillしていない）、通知RPCがservice_role限定であることを確認します。値が期待と異なれば有効化・Job実行へ進まず停止します。

   ```sql
   select singleton, enabled from public.amuhon_order_paid_notification_settings;
   select count(*) as notification_rows from public.amuhon_order_paid_notifications;
   select p.proname,
          p.prosecdef as security_definer,
          has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute,
          has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'claim_amuhon_order_paid_notification_v1',
       'claim_next_amuhon_order_paid_notification_v1',
       'complete_amuhon_order_paid_notification_v1',
       'fail_amuhon_order_paid_notification_v1',
       'get_amuhon_order_paid_notification_webhook_status_v1',
       'get_amuhon_admin_order_paid_notification_status_v1'
     )
   order by p.proname;
   ```
2. Secret ManagerにResendキーを登録し、通知専用サービスアカウントへそのSecretとSupabase staging Secretの`secretAccessor`だけを付与します。秘密値をシェル履歴やチャットへ貼りません。
3. 初回のコード配備前は通知Jobがまだないため、既存PDF Jobの現在確認済みdigestを使って`amuhon-order-notification-worker`をbootstrap作成します。初期イメージに通知workerのスクリプトが入っていない可能性があるため、**新しいコードのdigestへCloud Buildが更新するまで絶対に実行しません**。Job作成は実行を開始しません。1タスク、並列数1、Cloud Run再試行0、タイムアウト2分程度を設定し、専用サービスアカウントと上記環境変数を指定します。**コンテナCommand**は`node --experimental-strip-types scripts/send-order-paid-notifications-worker.mjs`、**引数**は`--run-queue-once`です。DockerfileのPDF用ENTRYPOINTをそのまま起動すると通知Jobにならないため、Commandの上書きが必須です。Job作成後、レビュー済みブランチのCloud Buildを明示的なstaging deploy設定で通し、新digestが両Jobへ反映されたことを確認します。
4. `amuhon-order-notification-scheduler`を10分間隔で作成し、専用SchedulerサービスアカウントからこのJobだけを起動できるようにします。OAuth認証を使い、SchedulerにはJob更新権限を与えません。まだ通知を有効にしない段階ではSchedulerを停止状態にするか、作成を保留します。
5. DB設定がOFFのままでJobを手動実行し、固定ログ`PAID_NOTIFICATION_DISABLED`を確認します。この実行は通知を送らず、outboxをclaimしません。さらに管理画面で過去注文が「通知記録なし」、OFF期間中にpaidとなった注文が「送信対象外」と表示されることを確認します。
6. Resend Secret、管理画面リンク、Webhookのoutbox永続確認、Schedulerの対象Job、ログアラートを運営者が確認した後、初めて明示的に送信を有効化します。SQL Editorで設定行の`enabled`をtrueにし、その後Schedulerを開始します。これは現在未実施です。通知を止める場合は設定をfalseにしSchedulerも停止します。
7. staging用の新しいテスト決済を1件だけ実施し、Webhookが2xx、outboxがqueuedからsent、管理画面に送信済みと表示されることを確認します。これは別途承認後の実機試験です。

このリポジトリの`cloudbuild.staging.yaml`は、デプロイを明示的に許可した場合に、既存PDF Jobと通知Jobの両方へ同じ確認済みdigestを反映します。staging設定では通知Jobが存在することをpreflightで要求します。デプロイ既定値は引き続き`_DEPLOY_STAGING=false`です。Job作成・Scheduler作成・メール有効化は自動実行しません。

SQL Editorでの明示的な有効化・停止は、事前確認が終わったときだけ次の更新を運営者が実行します。今回の作業では実行しません。

```sql
-- 有効化（Scheduler開始の直前）
update public.amuhon_order_paid_notification_settings
set enabled = true, updated_at = clock_timestamp()
where singleton = true and enabled = false;

-- 停止（別途Schedulerもpauseする）
update public.amuhon_order_paid_notification_settings
set enabled = false, updated_at = clock_timestamp()
where singleton = true and enabled = true;
```

## 管理画面と監視

管理者認証済みの注文詳細に通知状態を表示します。表示対象は状態、試行回数、固定エラーコード、次回試行予定、送信時刻だけです。宛先、Resend API応答本文、provider email IDは返しません。

Cloud Loggingでは次の固定コードを監視します。ログに注文本文・顧客情報・APIキー・Resend応答本文は含めません。

- `PAID_NOTIFICATION_NEEDS_REVIEW`
- `PAID_NOTIFICATION_FAILURE_RECORDING_PENDING`
- `PAID_NOTIFICATION_COMPLETION_UNKNOWN`
- `PAID_NOTIFICATION_WORKER_FAILED`
- `PAID_NOTIFICATION_WORKER_CONFIG_INVALID`

`needs_review`は既存管理画面で対象注文を開いて確認します。自動で注文状態・決済状態を変更したり、返金・再決済をしたりしません。再送のためにStripe Webhookを再送する必要はありません。復旧操作は原因確認後に別途設計し、outboxの状態を直接書き換える回避策は使わないでください。

## 今回の未実施事項

- Supabaseへのマイグレーション適用
- Secret ManagerへのResendキー登録
- Cloud Run Job / Schedulerの作成・変更・実行
- DB通知スイッチの有効化
- Resendへの実メール送信
- stagingテスト注文、決済、Webhook、Storage操作

実施したのはローカルコード・SQL草案・モックテスト・ドキュメントの変更だけです。
