# お客様向け注文メール通知

## 動作

この機能は、既存の注文通知用Cloud Run JobとResendを使います。管理者向け決済通知は既存の専用outbox・文面・送信先のまま維持されます。共通workerは、管理者通知とお客様通知の有効な行を期限順に1件ずつclaimします。

- **注文確定メール**：注文が初めて`paid`へ遷移したトランザクション内で、`order_confirmed`を1行作成します。
- **発送通知メール**：管理用RPCが`printer_submission_status`を初めて`shipped`へ変更したトランザクション内で、`order_shipped`を1行作成します。`submitted`では作成しません。
- 各注文・通知種別の一意制約とResendの安定した冪等キーで重複送信を抑止します。
- お客様の宛先はclaim時に注文に保存されている`customer.email`から取得します。宛先、本文、provider応答はアプリログ・workerログ・管理状態APIに含めません。
- 既存注文を対象とするバックフィルはありません。機能導入前の決済済み・発送済み注文は送信対象になりません。
- データベース設定の初期値は`enabled=false`です。OFF中に発生したイベントは`suppressed`として固定され、後からONにしても送信されません。
- 各通知は既存基盤と同じく最大8回・初回試行から23時間まで再試行し、上限後は`needs_review`になります。支払い・発送状態は巻き戻しません。
- stagingではResend呼び出し前に受信アドレスをallowlistと照合します。不一致・未設定は送信せず、`needs_review`へ移します。

## 通知本文

注文確定メールには注文番号、書名、決済金額、問い合わせ先`amuhon.jp@gmail.com`を載せ、問い合わせ時に注文番号を伝えるよう案内します。発送通知には注文番号、書名、発送した旨、問い合わせ先を載せます。確定情報がない配送日や追跡番号は記載しません。購入者向け本文に管理画面リンクは含めません。

## stagingに適用・設定する順番

この変更ではSQL適用、Cloud Run変更、Scheduler実行、設定ON、メール送信を行っていません。stagingで試す場合は運営者が次の順に進めてください。

1. `supabase/migrations/20261125000100_customer_order_notifications.sql`をレビューし、既存の注文通知migrationの後に`amuhon-staging`へ一度だけ適用します。設定が1行かつ`enabled=false`、新しいoutboxが空、RLSが有効、直接アクセス権がなく、RPCがservice_role限定であることを読み取り専用で確認します。ここで不一致があれば停止します。

   ```sql
   select singleton, enabled from public.amuhon_customer_order_notification_settings;
   select count(*) as customer_notification_rows from public.amuhon_customer_order_notifications;
   select c.relname, c.relrowsecurity,
          has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
          has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_select,
          has_table_privilege('service_role', c.oid, 'SELECT') as service_role_direct_select
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('amuhon_customer_order_notifications', 'amuhon_customer_order_notification_settings')
   order by c.relname;
   select p.proname, p.prosecdef as security_definer,
          has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute,
          has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in (
     'claim_amuhon_customer_order_notification_v1',
     'complete_amuhon_customer_order_notification_v1',
     'fail_amuhon_customer_order_notification_v1',
     'claim_next_amuhon_email_notification_v1',
     'get_amuhon_order_paid_notification_webhook_status_v1',
     'get_amuhon_admin_order_customer_notification_status_v1'
   ) order by p.proname;
   ```
2. 最新コードを含む確認済みイメージを既存の通知Jobへ反映します。JobはこれまでどおりPDF Jobと分離し、`node --experimental-strip-types scripts/send-order-paid-notifications-worker.mjs --run-queue-once`で一度に1件だけ処理します。Jobを実行するまではメールは送信されません。
3. staging Jobの通常環境変数に`AMUHON_CUSTOMER_NOTIFICATION_MODE=staging`、`AMUHON_STAGING_CUSTOMER_EMAIL_ALLOWLIST`に運営者が管理するテスト用アドレスだけを設定します。複数アドレスはカンマ区切りです。個人のお客様のアドレスをallowlistに入れないでください。`SUPABASE_URL`はstagingの固定プロジェクトURLである必要があります。Resendキーは従来どおりSecret Managerから渡します。
4. データベース設定がOFFのままworkerを実行し、`PAID_NOTIFICATION_DISABLED`またはキュー空のログを確認します。この時点で顧客メールが送信されてはいけません。過去のテスト注文も新outboxへ追加されません。
5. stagingの通知設定を明示的にONにする前に、allowlist、Resend送信元、Cloud Scheduler対象Job、運営者の監視を二者確認します。ONにした時点以降に**新しく作るテスト注文**だけが対象です。設定OFF中に作った注文は`suppressed`のため、テストには使えません。
6. allowlist内のテストアドレスを購入者メールとして**新規のStripe test-mode注文**に入力し、実際のテスト決済とWebhookでpaid状態にします。WebhookはDB outbox登録を確認して2xxを返し、独立workerが注文確定メールを送ります。注文状態を直接書き換えて試さないでください。
7. 入稿・発送を試す場合は、製本会社側の確認を伴う既存の管理操作を運営手順に従って行います。`submitted`の時点では通知されず、確認済みの初回`shipped`遷移だけが通知行を作ります。DBで状態を直接更新しないでください。
8. 管理画面の注文詳細で注文確定・発送通知の状態を確認します。テスト後はまずSchedulerを停止し、データベースの通知設定をOFFにします。`sent`のメールは取り消せないため、宛先と件名を実施前に再確認してください。

通知の状態は、管理者認証後の注文詳細画面で確認できます。APIは状態、試行回数、固定エラーコード、次回予定、送信日時のみ返し、宛先やResend IDは返しません。

## 環境設定

通知workerは既存の`SUPABASE_URL`、`AMUHON_NOTIFICATION_QUEUE_PROJECT_REF`、`SUPABASE_SECRET_KEY`、`RESEND_API_KEY`、`AMUHON_PUBLIC_ORIGIN`を引き続き使います。顧客向け送信では次を追加します。

- `AMUHON_CUSTOMER_NOTIFICATION_MODE=staging`：`SUPABASE_URL`がstagingプロジェクトと完全一致する場合のみ有効。
- `AMUHON_STAGING_CUSTOMER_EMAIL_ALLOWLIST`：stagingで送信可能なテストアドレス。
- 本番では`AMUHON_CUSTOMER_NOTIFICATION_MODE=production`かつ`NODE_ENV=production`が必要です。stagingプロジェクトではこのモードを拒否します。

モードや設定が欠けた顧客通知は送信せず、固定エラーコード付きで`needs_review`にします。管理者向け通知の既存設定・送信先・有効化スイッチには影響しません。Resend APIキーの値を通常環境変数やログへ出さないでください。

## 今回未実施

- Supabase migration適用、DB設定の有効化
- Cloud Run / Schedulerの変更・実行
- Resendへの実メール送信
- 新規Stripe test注文、決済、発送状態変更
- 本番環境の設定・送信
