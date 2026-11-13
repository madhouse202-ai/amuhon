# /final のNoto Serif JP開発検証

この機能は開発環境の `/final` だけで使います。通常表示と注文用PDFの既定値は従来の `serif`・1.00emです。D版の設定は画面内だけに保持し、注文PDF、注文、Storage、決済、DBには渡しません。

## Windowsで比較する手順

1. 開発サーバーを起動し、作品を選択済みのブラウザーで `http://localhost:3000/final` を開きます。
2. 全作品の本文取得と組版が終わり、実組版ページ数が表示されたことを確認します。
3. `現行 serif・1.00em` を選び、`現在の本文で検証PDFを保存` を押します。保存名は `amuhon-final-serif-<ページ数>pages.pdf` です。
4. 同じ画面で `D版 Noto Serif JP・1.00em` を選びます。フォントを取得・読み込めないときは明示エラーになり、serifへ黙って切り替えて成功扱いにはしません。
5. `現在の本文で検証PDFを保存` を押します。保存名は `amuhon-final-noto-serif-jp-<ページ数>pages.pdf` です。
6. 画面内の確認表示で、A6縦のページ数とルビ数が期待どおりであることを確認し、2つのPDFの同じページを見比べます。

検証PDFは `/final` が取得済みの本文テキストを、作品順を保ったままローカルの固定レンダラーへ渡して生成します。レンダラーは選択作品の本文ページごとに40字×16列、縦書き、ルビ、A6縦のページ寸法を確認します。D版ではChromiumの実使用フォント情報も検査し、本文ページでNoto Serif JP以外のフォント利用を検出した場合はPDFを成功扱いしません。

検証用フォントは公式Noto Serif CJK 2.003の日本語Regular OTFです。CSSでは開発専用の論理名 `Noto Serif JP` で読み込みますが、Chromium CDP検査では実測された内部ファミリー名 `Noto Serif CJK JP` または正確なPostScript名 `NotoSerifCJKjp-Regular` だけを許可します。論理名だけの一致や別フォントへのフォールバックは合格になりません。

### 開発用フォントの配置

フォント本体とライセンスはGitへ追加せず、`.local-assets/fonts/` にローカル配置します。このディレクトリは `.gitignore` 対象です。D版を使うPCでは、公式リリースの固定URLから `NotoSerifCJKjp-Regular.otf` と `Serif/LICENSE` を取得し、次のSHA-256を確認してから配置してください。

```powershell
$fontDir = Join-Path (Get-Location) '.local-assets\fonts'
New-Item -ItemType Directory -Force -Path $fontDir | Out-Null
$fontTmp = Join-Path $env:TEMP 'NotoSerifCJKjp-Regular.otf'
Invoke-WebRequest 'https://raw.githubusercontent.com/notofonts/noto-cjk/Serif2.003/Serif/OTF/Japanese/NotoSerifCJKjp-Regular.otf' -OutFile $fontTmp -UseBasicParsing
if ((Get-FileHash -LiteralPath $fontTmp -Algorithm SHA256).Hash -ne 'D9854C7A8EF170B5A7932558856FD64EB8DE0B007CD823FED6F9F514AD2803D3') { Remove-Item -LiteralPath $fontTmp; throw 'Font SHA-256 mismatch' }
Move-Item -LiteralPath $fontTmp -Destination (Join-Path $fontDir 'NotoSerifCJKjp-Regular.otf')
Invoke-WebRequest 'https://raw.githubusercontent.com/notofonts/noto-cjk/Serif2.003/Serif/LICENSE' -OutFile (Join-Path $fontDir 'LICENSE-Noto-Serif-CJK.txt') -UseBasicParsing
```

対象ファイルは公式配布のVersion 2.003、24,573,864 bytes、SHA-256 `D9854C7A8EF170B5A7932558856FD64EB8DE0B007CD823FED6F9F514AD2803D3` です。ライセンスはSIL Open Font License 1.1です。ライセンスファイルをフォントと一緒に保管してください。公開・コンテナ同梱を決める際は、フォント配布物にも著作権表示とライセンスを含めます。

開発用フォントAPIとPDF APIは `NODE_ENV=development`、`localhost:3000`、同一オリジン以外では応答しません。フォントファイルが未配置、サイズ違い、ハッシュ不一致の場合はD版を拒否します。

D版の切替は画面を再読み込みすると解除されます。手動の印刷PDFをserifに戻すには、同じ画面で `現行 serif・1.00em` を選んでください。通常の注文PDF生成処理は別の新規ブラウザー文脈で従来どおりserifを使用します。

## 範囲

この検証は組版比較用です。注文下書き、アップロード、Storage、Stripe、Webhook、管理画面にはアクセスしません。A6寸法とページ数はPDF構造を検査します。見た目の読みやすさ、文字の濃さ、個々の字形の好みは、保存したPDFを人が確認してください。
