# Third-party dependencies

この配布候補は依存パッケージの実体を同梱しません。`npm ci --ignore-scripts` は `package-lock.json` に固定した依存を取得します。各パッケージの権利表示・ライセンスはインストール先に保持されます。

| パッケージ | lockfileの版 | ライセンス |
|---|---|---|
| yauzl | 3.4.0 | MIT |
| pend | 1.2.0 | MIT |
| saxes | 6.0.0 | ISC |
| xmlchars | 2.2.0 | MIT |
| tsx | 4.23.13 | MIT |
| esbuild（プラットフォーム別バイナリを含む） | 0.28.2 | MIT |
| TypeScript | 5.9.3 | Apache-2.0 |
| @types/node | 22.20.1 | MIT |
| @types/yauzl | 3.4.0 | MIT |
| undici-types | 6.21.0 | MIT |
| fsevents（optional） | 2.3.3 | MIT |

上表はlockfileのライセンス情報を確認したものです。バイナリや依存物を再配布する際には、その配布内容に応じたLICENSE・NOTICEを別途同梱してください。

Officeのサンプルは `test/support/office-samples.ts` が生成する架空資料です。開発時の実資料・画像・PDF・外部テンプレート・モデル重みは同梱しません。
