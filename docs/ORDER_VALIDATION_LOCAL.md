# ローカル注文ファイル検証ワーカー試作

このCLIはローカルにある本文PDFとカバーPNGを、注文APIと同じ `lib/order-assets.ts` で検証する開発用試作です。Supabase、DB、Storage、注文データへ接続・書き込みを行いません。

## 実行

Node.js 24系を使い、リポジトリルートで実行します。

```powershell
npm run validate:order-assets -- ./body.pdf ./cover.png
```

手元の編む本PDF・PNGを確認する場合は、`/final` から出力した本文PDFと `/cover` から同じ版のカバーPNGをローカルへ保存し、上記コマンドの引数に指定します。両ファイルを同じ本・同じページ数で出力してください。CLIは本文PDFの実ページ数から期待するカバー寸法を計算するため、ファイル選択順はPDF、PNGです。ファイルはローカルだけで読み、結果にもファイルパスや本文を表示しません。実データを含むレポートを共有・保存する場合は、作品情報やハッシュが含まれないことを確認してください。

正常時はJSONで検証結果、実ページ数、ファイルサイズ、PNGピクセル寸法、経過時間、user/system CPU時間、プロセスのピークRSSを表示します。ハッシュ、ファイルパス、ファイル内容は結果に出力しません。検証失敗時は終了コード1、引数エラー時は2です。

## 検証条件

- 各ファイルの最大サイズは40,000,000バイト。
- PDFは `pdf-lib` で読み、破損・暗号化、実ページ数、ページごとのA6縦寸法、回転を検査します。現在のアプリ条件は8ページ単位を含む24〜496ページです。
- PNGは既存検証器で形式、PNGチャンクCRC、最大画素数、背幅モデルから計算した実寸、RGB条件、350dpiメタデータを確認し、`sharp` でデコードします。
- 表紙寸法はPDFで確認した実ページ数を使います。引数やファイル名からページ数を推測しません。

## テスト

```powershell
npm run test:order-assets
```

自動テストは `pdf-lib` と `sharp` で一時ディレクトリ内に小さな正常PDF/PNGを生成し、CLIの成功・破損入力・サイズ境界などを検査します。40MBの実ファイルや敵対的な最大負荷ファイルを生成するテストではありません。

## 合成データの段階的負荷測定

合成データは指定した出力ディレクトリにだけ作成します。出力先は新規ディレクトリでなければならず、既存ファイルを上書きしません。

```powershell
npm run generate:order-fixtures -- --out "$env:TEMP/amuhon-load-small" --sizes 1000000,5000000
npm run benchmark:order-assets -- "$env:TEMP/amuhon-load-small/1000000" "$env:TEMP/amuhon-load-small/5000000"
```

生成器は実測20ページ以上の製本条件に合わせた24ページA6 PDFと同寸法350dpi RGB PNGを作ります。PDFの末尾空白とPNGのCRC付き `tEXt` チャンクで指定サイズに合わせるため、サイズ読み込み・CRC走査・ハッシュ計算を比較できます。ただし、それらの追加データは実作品のPDF内容やPNGの圧縮率を再現しません。PNG自体は出力寸法全体を `sharp` でデコードするので、一定の展開メモリ負荷を確認できます。

複雑PDFは次のように各ページへベクター描画命令を加えて生成できます。生成自体にも時間・メモリを使うため、この例は自動実行していません。

```powershell
npm run generate:order-fixtures -- --out "$env:TEMP/amuhon-load-complex" --sizes 5000000 --complex-ops-per-page 1000 --allow-large
```

ランダムRGB画素でPNG圧縮・展開負荷を測る場合も、大きなraw pixel bufferを作るため自動実行していません。

```powershell
npm run generate:order-fixtures -- --out "$env:TEMP/amuhon-load-noise" --sizes 25000000 --png-noise --allow-large --allow-high-memory
```

CRCが壊れたPNGの拒否時間を測るには、正常な5MBケースを生成し、PNG CRCだけを壊したケースを別に作って `--expect-invalid` で測定します。

```powershell
npm run generate:order-fixtures -- --out "$env:TEMP/amuhon-load-corrupt-png" --sizes 5000000 --corrupt-png
npm run benchmark:order-assets -- "$env:TEMP/amuhon-load-corrupt-png/5000000" --expect-invalid
```

10MB超は `--allow-large`、20MB超またはノイズPNGは `--allow-high-memory`、30MB超はさらに `--allow-near-limit` が必要です。同じ許可フラグをbenchmarkコマンドにも渡します。40,000,000バイトを超えるケースは生成・測定できません。40MB近傍テストは、利用可能メモリを確認してから段階的に行ってください。

サイズ近傍の比較例（実行前に各フラグと利用可能メモリを確認してください）：

```powershell
npm run generate:order-fixtures -- --out "$env:TEMP/amuhon-load-near-cap" --sizes 10000000,20000000,30000000,39000000 --allow-large --allow-high-memory --allow-near-limit
npm run benchmark:order-assets -- "$env:TEMP/amuhon-load-near-cap/10000000" "$env:TEMP/amuhon-load-near-cap/20000000" "$env:TEMP/amuhon-load-near-cap/30000000" "$env:TEMP/amuhon-load-near-cap/39000000" --allow-large --allow-high-memory --allow-near-limit
```

## 測定値の限界

`elapsedMs` は当該ローカルプロセスの経過時間、`userCpuMs`/`systemCpuMs` はNode.jsのプロセス利用量、`processPeakRssBytes` はOSが報告するプロセス全体のピーク常駐メモリです。起動時間を含み、マシン・Node.js・依存ライブラリ・OSに依存します。クラウド環境のメモリ消費・ピークCPU・処理時間の保証や負荷試験の代替にはなりません。

ベンチマークランナーは各CLIプロセスを120秒で打ち切ります。CLIを直接呼び出す場合には外部タイムアウトがないため、複雑・未信頼なファイルにはベンチマークランナーを使用してください。

40MB PDF/PNG、複雑なPDFオブジェクト、巨大なPNG展開サイズでの計測は別途必要です。Cloud Run等へ移行する前に、最大サイズ近い代表/悪意ある入力を用いた負荷試験、メモリ上限と並列数の決定、キュー・署名付き内部通信・シークレット管理、リース更新・重複実行・失敗復旧、ログ/予算アラート、イメージの脆弱性管理、stagingのStorage・DB統合試験が必要です。
