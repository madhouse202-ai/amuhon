# PDF製本ワーカー Cloud Run 引き継ぎ

更新日: 2026-11-15

> 2026-11-16更新: この文書のCloud Run作成手順は、それ以前の未作成状態に対する履歴です。運営者から、staging Job `amuhon-pdf-renderer`、Artifact Registry image、専用サービスアカウント、Secret Manager設定、非公開バケット、1 GiB一時ディスクの構成と、空キューでの正常終了が報告されています。現在の実設定・digestはこの作業環境から独立確認できていません。既存Jobの現在の事前確認と一回限りのE2E手順は [`STAGING_E2E_RUNBOOK.md`](STAGING_E2E_RUNBOOK.md) を参照し、以下の旧 `jobs create` コマンドをそのまま再実行しないでください。

## 今回の結果

- 本番用ではなく、staging用の既存キューとコンテナの構成を確認した。ユーザーからの報告では、キューの追加マイグレーション、DBオブジェクト、権限、RLSは staging で確認済み。
- `--run-queue-once` は一回につき最大1件を取得し、決済済み・検証済み注文だけをRPCで受け取る。アプリの手入力による注文IDやファイルパスは受け取らない。
- 本文PDFと表紙PNGを両方生成し、Noto Serif CJK JPの実使用、PDFページ寸法・ページ数、表紙PNGの寸法・色・解像度・復号を既存検査で確認してからStorageへ送る。検査条件は変更していない。
- Storageは既存の非公開 `amuhon-order-files` バケットを使い、リースごとのパスと `x-upsert: false` で新規作成する。最後のDB RPCが両方のキー・ハッシュ・サイズ・ページ数を一つのトランザクションで確定する。
- DockerとgcloudはこのWindows環境で見つからなかった。今回、Dockerビルド、Cloud Run、Secret Manager、Scheduler、Artifact Registryへの接続・変更、Supabase、Stripe、Storageへの通信はしていない。
- `.next` のWindowsローカル測定値は全体約615 MiB、ワーカーが隔離ランタイムへコピーする除外済みビルド部分は約5.14 MiBだった。Linuxイメージ上の実測値ではない。

## 実行境界と信頼条件

`Dockerfile.pdf-renderer` は Playwright `1.65.0` の公式 `noble` イメージを使い、lockfileも `playwright-core` `1.65.0` に固定している。Playwrightのバージョンと同梱Chromiumを一致させる。フォント取得スクリプトは公式 Noto CJK 2.003の日本語静的Regular OTFだけを取得し、サイズ、OTF形式、SHA-256、OFL 1.1を検査する。フォント実体はイメージに含め、Gitには追加しない。

Windowsでイメージを作る際は `--platform linux/amd64` を指定し、Cloud Run Jobにはタグではなくpush後に確認したイメージdigestを指定する。これでCPUアーキテクチャと実際に使うイメージを特定しやすくする。Playwrightタグはバージョン固定だが、今回の監査ではMCRのイメージdigestまでは固定・検証していない。

キューモードの環境は、Secret Managerから注入する `SUPABASE_SECRET_KEY` と、非秘密の `SUPABASE_URL`、`AMUHON_PDF_QUEUE_PROJECT_REF`、`AMUHON_PDF_QUEUE_ENABLED=true`、`AMUHON_PDF_WORKER_BROWSER_MODE=pinned`、`AMUHON_PDF_RENDER_PORT=3000`、`AMUHON_PDF_FONT_PATH=/opt/amuhon/fonts/NotoSerifCJKjp-Regular.otf`、`NODE_ENV=production` に限定する。URLとProject Refの完全一致が必須。秘密はワーカープロセスの `apikey` にのみ使われ、Next.js子プロセス、Chromium、引数、ログには渡さない。

ワーカーは `/final` と `/cover` を既存コードでレンダリングするため、コンテナ内でNext.jsを `127.0.0.1` にだけ起動する。Chromium側の通信はloopbackに限定し、青空文庫の取得はURL検査付きの既存APIを通す。決済APIやStripeキーはワーカー環境に渡さない。

## Cloud Runの初期構成案

| 設定 | 初期値 | 理由・制限 |
|---|---:|---|
| Region | `asia-northeast1` | stagingとの運用距離を短くする |
| Tasks / parallelism | `1 / 1` | 1実行で最大1注文。DBロックは別途必要で、並列数だけでは重複防止にならない |
| Cloud Run task timeout | `20m` | 青空文庫取得上限10分、本文Chromium上限180秒、サーバー起動・表紙生成・Storage通信に余裕を置く。最大ページ数で実測し再評価する |
| Cloud Run retries | `0` | DBリースと最大5回の再試行だけを正とし、プラットフォーム再試行との二重管理を避ける |
| CPU / memory | `2 / 4Gi` を計測開始値にする | 88ページ成功実績はあるが、Cloud Run上の最大300ページのメモリ・時間は未測定 |
| Temporary disk | `1Gi` のephemeral diskを `/app/tmp/pdf-renderer-worker` にmount | Next.js隔離ランタイムの一時コピー先。ディスクは全ユーザーが読み書きでき、Job終了時に破棄される。容量は実行ログで監視する |
| Scheduler | まずは手動実行1回、その後 `35 * * * *`（毎時35分） | `*/35 * * * *` は35分ごとではなく、各時の00分・35分に動くため間隔が交互に25/35分となる。毎時1回なら30分リースの期限後に再取得でき、アイドル起動費も抑えやすい |
| Job image | `linux/amd64`、push後のdigest | 可変タグの差し替わりを避ける |

Cloud Run Jobsはデフォルトでタスク再試行が設定されるため、必ず `--max-retries=0` を明示する。Schedulerも `--max-retry-attempts=0`。配送の一時失敗は次の定期実行で拾う。Jobの `parallelism=1` は一つの実行内だけの上限であり、同時実行・Scheduler再送の最終ガードはDBの行ロック、lease、`order_id`一意制約である。

**費用と一時終了:** Cloud Run Jobsは実行時間・CPU・メモリに加え、ephemeral diskは割り当て容量と実行中の時間、Artifact Registryは保存量・転送、Schedulerはジョブ数、Secret Managerは保管・アクセス、さらに外部通信・ログの費用が発生し得る。Scheduler料金は実行回数でなく登録ジョブ数を基準とし、同じBilling accountの無料枠を共有する。現在の料金はリージョン・Billing account・構成により変わるため、作成前にCloud Pricing CalculatorとBillingを確認する。設定済みの月500円予算アラートは通知用で、利用や課金を自動停止しない。

Cloud Runは終了時にSIGTERMを送り、その後10秒でSIGKILLする。ワーカーはSIGTERM時のDB失敗RPCを保証していないため、ジョブは最大30分のlease期限まで `rendering` に見えることがある。強制終了前に片方または両方のファイルがStorageへ作成されていた場合、それらは非公開の孤立オブジェクトとして残り得るが、lease IDを含むcreate-onlyパスであり、完了RPCが通らない限り注文のファイル参照は更新されない。次回claimは期限切れleaseを新しいlease IDで回収する。孤立物の自動削除は行わない。

## 最小権限

- `amuhon-pdf-worker` 用ユーザー管理サービスアカウントを作り、Cloud Run Jobに割り当てる。
- この実装はGoogle Cloud APIを直接呼ばない。ワーカーSAにProject EditorやSupabase/Stripe以外の広い権限を与えない。Secret Managerの環境変数参照に必要な `roles/secretmanager.secretAccessor` だけを対象Secret上で付与する。
- Secret Managerには staging 専用の `SUPABASE_SECRET_KEY` を手動登録し、JobはSecretの固定version番号を参照する。値をPowerShell引数・環境変数・ファイル・ログへ書かない。SAのJSON鍵は作らない。
- `amuhon-pdf-scheduler` は別SAにし、そのSAに対象Jobだけの `roles/run.invoker` を付ける。SchedulerからGoogle API (`run.googleapis.com`) を呼ぶ認証はOIDCでなくOAuth service account tokenを使用する。
- Cloud Run Service AgentのArtifact Registry Readerは同一プロジェクトなら通常の連携設定を確認し、Worker SAへ不要なRegistry権限を付けない。別プロジェクトからpullする構成へ変えない。

## Windowsでの段階的な手順

以下は今後の手順案であり、今回実行していない。Cloud権限、Billing、意図したstaging projectを人が確認してから実施する。

### 1. ローカルツールと対象リポジトリの確認

PowerShellで以下を確認する。gcloud/Dockerがない場合は公式Windows installerを使うが、今夜はインストールしていない。

```powershell
Get-Command gcloud, docker -ErrorAction SilentlyContinue | Select-Object Name, Source
gcloud version
docker version
```

Google Cloud ConsoleのProject selectorで `amuhon-staging` を目視し、Billing account、Artifact Registry repository `amuhon-pdf-renderer` のLocation、Cloud Run/Scheduler/Secret Manager APIsが既に有効か確認する。APIを有効化する前に課金設定と無料枠を確認する。gcloudでは全コマンドに `--project=amuhon-staging` とリージョンを明示する。

### 2. 既存のローカル品質確認（DB・外部通信なし）

```powershell
npm run test:pdf-render-queue
npm run test:order-admin
npm run render:pdf-worker:self-test
```

固定Linuxイメージを作る場合は、Dockerを導入したWindowsで次を行う。buildでは公式font配布元から取得するためビルド時ネットワークが必要。起動後のself-testは `--network none` で行い、DB・Storage・Stripe・青空文庫へ接続させない。

```powershell
$Project = 'amuhon-staging'
$Region = 'asia-northeast1'
$Repository = 'amuhon-pdf-renderer'
$ImageName = 'pdf-renderer'
$Tag = 'staging-20261116-unique'
$Image = "${Region}-docker.pkg.dev/${Project}/${Repository}/${ImageName}:$Tag"
docker buildx build --platform linux/amd64 -f Dockerfile.pdf-renderer -t $Image --load .
if ($LASTEXITCODE -ne 0) { throw 'Linux amd64 renderer image build failed.' }
$artifactRoot = Join-Path (Get-Location) 'tmp/pdf-renderer-worker'
New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
$artifactRoot = (Resolve-Path $artifactRoot).Path
docker run --rm --network none --mount "type=bind,source=$artifactRoot,target=/app/tmp/pdf-renderer-worker" $Image --self-test
if ($LASTEXITCODE -ne 0) { throw 'Offline renderer self-test failed.' }
```

成功ログの固定コードとA6・Noto・ruby検査を確認し、PDF/PNGを開いて目視する。テスト失敗時は品質ゲートを緩めず停止する。

### 3. imageをpushし、digestを固定する

まずConsoleでrepository locationとWriter権限を確認する。Docker認証はユーザーのgcloud credential helperを使い、鍵を保存しない。

```powershell
gcloud auth login
gcloud auth configure-docker asia-northeast1-docker.pkg.dev
docker push $Image
if ($LASTEXITCODE -ne 0) { throw 'Artifact Registry push failed.' }
```

Artifact Registry Consoleでpushしたtagのsha256 digestを確認し、Cloud Run Jobには `$Image@sha256:...` 形式を使う。digestとtagをリリース記録に残す。タグのimmutable設定が未確認なら、tagだけを本番識別子にしない。

### 4. Secretとサービスアカウント

Secret Manager Consoleでstaging専用Secretを作成し、stagingの `SUPABASE_SECRET_KEY` の新しいversionを追加する。キー値はシェルへ貼らず、PowerShellにも入力しない。version番号だけを控える。専用worker SAを作成し、対象SecretだけにSecret Accessorを付ける。Scheduler用のSAは別に作成する。Jobへのサービスアカウント割当には、デプロイする本人にそのSA上の `roles/iam.serviceAccountUser` が必要。

### 5. Cloud Run Jobを作成（作成のみ、初回は実行しない）

Project Refは既知のstaging Refを人が確認し、値はSecretと混在させない。`$ImageDigest`、`$WorkerSa`、`$SecretId`、`$SecretVersion` は確認済みの識別値に置き換える。

```powershell
$Project = 'amuhon-staging'
$Region = 'asia-northeast1'
$Job = 'amuhon-pdf-renderer'
$WorkerSa = 'amuhon-pdf-worker@amuhon-staging.iam.gserviceaccount.com'
$SecretId = 'amuhon-supabase-secret'
$SecretVersion = '1'
$SecretRef = "${SecretId}:$SecretVersion"
$SupabaseProjectRef = '<staging-project-ref-confirmed-in-dashboard>'
$ImageDigest = '<asia-northeast1-docker.pkg.dev/.../pdf-renderer@sha256:...>'
$NonSecretEnv = @(
  'NODE_ENV=production',
  'AMUHON_PDF_WORKER_BROWSER_MODE=pinned',
  'AMUHON_PDF_QUEUE_ENABLED=true',
  "AMUHON_PDF_QUEUE_PROJECT_REF=$SupabaseProjectRef",
  "SUPABASE_URL=https://$SupabaseProjectRef.supabase.co",
  'AMUHON_PDF_RENDER_PORT=3000',
  'AMUHON_PDF_FONT_PATH=/opt/amuhon/fonts/NotoSerifCJKjp-Regular.otf'
) -join ','
gcloud run jobs create $Job --project=$Project --region=$Region --image=$ImageDigest `
  --tasks=1 --parallelism=1 --max-retries=0 --task-timeout=20m --cpu=2 --memory=4Gi `
  --service-account=$WorkerSa --args=--run-queue-once `
  --set-env-vars=$NonSecretEnv --set-secrets="SUPABASE_SECRET_KEY=$SecretRef" `
  --add-volume=name=worker-tmp,type=ephemeral-disk,size=1Gi `
  --add-volume-mount=volume=worker-tmp,mount-path=/app/tmp/pdf-renderer-worker
```

This command intentionally has no `--execute-now`. Confirm the Job description shows only the staging URL/ref, fixed secret reference, expected digest, one task, no retries, and the mounted ephemeral directory. Never use `gcloud run jobs execute` until a deliberately created staging test order is paid, queued, and explicitly approved for rendering.

### 6. One controlled staging test, then Scheduler

Before executing the Job, run the repository's staging read-only queue verification SQL from the Supabase Dashboard against the project chosen manually. Do not run the claim RPC as a test. Confirm there is only the intended new test payment awaiting generation; the migration does not backfill older paid orders. Then make one explicitly authorized Stripe test-mode order and observe its admin status. Run the Job once, inspect fixed-code logs and admin status, verify the private asset download via the authorized admin route, and visually inspect both artifacts. Do not run it if an unexpected queue row exists.

Only after the one-off execution succeeds, grant the Scheduler SA `roles/run.invoker` on this Job and create the hourly trigger. Cloud Scheduler's target is the Cloud Run Jobs API, so use an OAuth access token:

```powershell
$Project = 'amuhon-staging'
$Region = 'asia-northeast1'
$Job = 'amuhon-pdf-renderer'
$SchedulerSa = 'amuhon-pdf-scheduler@amuhon-staging.iam.gserviceaccount.com'
$RunUri = "https://run.googleapis.com/v2/projects/$Project/locations/$Region/jobs/${Job}:run"
gcloud run jobs add-iam-policy-binding $Job --project=$Project --region=$Region `
  --member="serviceAccount:$SchedulerSa" --role=roles/run.invoker
gcloud scheduler jobs create http amuhon-pdf-renderer-hourly --project=$Project --location=$Region `
  --schedule='35 * * * *' --time-zone='Asia/Tokyo' --uri=$RunUri --http-method=POST `
  --oauth-service-account-email=$SchedulerSa --oauth-token-scope='https://www.googleapis.com/auth/cloud-platform' `
  --max-retry-attempts=0 --attempt-deadline=30s
```

## 失敗時の停止・復旧

1. Jobが非0終了・timeout・`PDF_QUEUE_FINALIZATION_UNKNOWN` を返したら、手動でJobを再実行したりファイルを消したりしない。
2. ログから固定コード、task attempt、実行時間だけを確認する。例外本文、環境変数、Supabase URL query、注文Snapshotはログへ出さない。
3. 管理者画面で対象注文の生成状態・attempt countを確認する。`rendering` はlease期限まで待ち、30分後以降の次のJob実行で再取得されることを確認する。
4. `failed` は最大5回または品質上の恒久失敗。品質条件を外さず、原因を修正した後の再処理方法は別途安全設計をレビューする。
5. 非公開Storageの孤立物はDBの現在参照を読み取り確認するまで手動削除しない。自動Cleanupは未実装・未許可。
6. 不明な設定・digest・project/ref・secret versionならSchedulerを作成せず、Jobを無効化または手動停止し、DB/RPCの権限を広げない。

## 実施した検証と未検証

- PDFキューのmock/static test 23件、renderer/admin関連test 12件、asset validation/worker test 42件、validation migration static test 16件がすべて成功。
- `npx tsc --noEmit`、`npm run lint`、`npm run build` が成功。buildはNext.js 16.4.2のwebpack経路。
- `git diff --check` は成功。既存ワークツリーのLF/CRLF変換注意が表示されたが、空白エラーはない。
- 引き継ぎ書内PowerShellコードブロック6件のAST構文解析が成功。
- Cloud Run上のCPU・memory・最大ページ数、Secret Manager注入、Artifact Registry pull、Scheduler OAuth、Supabaseの実際の通信は未検証。コンテナ内のself-testは過去に成功したとのユーザー報告があるが、今夜の実行環境ではDocker CLIがなく再実行していない。

## 明日のチェックリスト

- [ ] gcloudとDocker Desktopをローカルで確認し、Google Cloud project selectorが `amuhon-staging` であることを目視する。
- [ ] staging用read-only migration/queue検証SQLを実行し、最新migrationのRPC・権限・RLSを再確認する。既存paid注文に未確認のqueue rowがないか集計で見る。
- [ ] `linux/amd64` のDocker self-testを実行してPDF/PNGを開き、digestを固定する。
- [ ] Secret Managerにstagingキーを1 versionだけ登録し、worker/scheduler各SAに必要最小限の権限を設定する。
- [ ] Jobを作成して設定を確認するが、予期しないqueued注文があれば実行しない。
- [ ] 明示的に許可した新規stagingテスト注文1件だけを処理し、管理画面と非公開ファイル取得まで確認する。
- [ ] 成功後にのみhourly Schedulerを作成し、ログ・費用・job failureを監視する。
- [ ] staging運用が安定するまでは本番Supabase/Stripeへ切り替えない。

## 推奨する次の3ステップ

1. 明日、stagingの読み取り専用queue検証SQLを実行し、既存paid注文に想定外の生成ジョブがないことを確認する。
2. Windowsでgcloud/Dockerを確認し、`linux/amd64` self-testとArtifact Registryへのdigest pushを行う。
3. Secret Managerと最小権限SAを設定してCloud Run Jobを作成し、実行前にqueue状態を確認してから、明示的に許可されたテスト決済1件で一度だけ動作確認する。

## 参照したGoogle公式資料

- [Cloud Run container runtime contract](https://docs.cloud.google.com/run/docs/container-contract) — ephemeral filesystem、task終了時のSIGTERM/SIGKILL猶予。
- [Cloud Run Jobs task retries](https://docs.cloud.google.com/run/docs/jobs-retries) と [task timeout](https://docs.cloud.google.com/run/docs/configuring/task-timeout) — taskごとのtimeout/retry。
- [Cloud Run Jobs ephemeral disk](https://docs.cloud.google.com/run/docs/configuring/jobs/ephemeral-disk) — 1–100Gi mount、一時データの破棄、ユーザー読み書き。
- [Cloud Run Jobs secrets](https://docs.cloud.google.com/run/docs/configuring/jobs/secrets) と [service identity](https://docs.cloud.google.com/run/docs/configuring/jobs/service-identity) — Secret Manager・専用identity。
- [Cloud Scheduler HTTP auth](https://docs.cloud.google.com/scheduler/docs/http-target-auth) と [Cloud Run Jobs scheduling](https://docs.cloud.google.com/run/docs/triggering/using-scheduler) — Job API呼び出しとOAuth。
- [Artifact Registry access control](https://docs.cloud.google.com/artifact-registry/docs/access-control) と [Docker authentication](https://docs.cloud.google.com/artifact-registry/docs/docker/authentication) — repository IAMとcredential helper。
- [Cloud Scheduler pricing](https://cloud.google.com/scheduler/pricing), [Cloud Run pricing](https://cloud.google.com/run/pricing), [Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing), [Cloud Billing budgets](https://docs.cloud.google.com/billing/docs/how-to/budgets) — 料金と予算アラート。
