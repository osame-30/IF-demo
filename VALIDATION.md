# 公開候補の検証

実施日: 2026-09-29。Windows / Node.js 24.13.0 / npm 11.6.2。

| 検査 | 結果 |
|---|---|
| 新しい候補フォルダで `npm ci --ignore-scripts` | 成功 |
| `npm run typecheck` | 成功 |
| `npm test` | 770件中768成功、失敗0、skip 2 |
| CLIデモを子プロセスで実起動 | 成功、架空3資料を列挙 |
| HTTP画面取得・認証なしAPI拒否 | 200 / 401を確認 |
| Word・Excelの解析→正規化→原本取得 | 成功、原本の全バイト一致 |
| 正規化再実行 | 同じartifactIdを再利用 |
| 無変更の再走査 | document_version / derivation / artifact 全行不変 |
| 壊したWordの解析 | failedとして報告 |
| `npm audit`（開発依存も含む） | 既知脆弱性0件 |
| Gitleaks 8.30.1 | 候補ツリーの秘密情報検出0件 |

skipはPOSIXの権限状態をWindowsで再現できない試験1件と、ローカルFSでfetchAclを実装しないためdeferredの試験1件です。

今回、ブラウザの画面操作・Officeアプリでの目視照合・macOS/Linuxでの実行は再実施していません。CI設定を同梱していますが、新リポジトリでの実行は未実施です。スキャンでの検出0件は、未知の脆弱性や全ての機密情報がないことの証明ではありません。

コード本体と試験はOffice対応済みの同一スナップショットから抽出しました。公開向け文書とCIを作成し、Windows起動cmdの改行を配布指定のCRLFに揃えています。機能を足したデモ用モックではありません。
