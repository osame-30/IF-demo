/**
 * 同一性ブランドの**逃げ道**。テスト専用。
 *
 * `unsafe-evidence.ts` と分けてあります。**分けた理由は実測です。**
 *
 * `BlobKey` の逃げ道を `test/fixtures/context.ts`（全フィクスチャの土台）が
 * 使うので、1つのファイルに同居させると AC-EVD-01 の推移閉包が
 * **2ファイルから31ファイルに膨らみました。** 閉包が「誰が嘘の証拠を作るか」
 * ではなく「誰が土台を使うか」を表す表に変わってしまいます。
 *
 * ## 検査の掛け方が2つで違う理由
 *
 * - 証拠（`unsafe-evidence.ts`）は**推移閉包**で見ます。
 *   主張は「本番コードは嘘の証拠に到達できない」で、到達可能性そのものが問題だからです
 * - 同一性（このファイル）は**直接の import** で見ます。
 *   直接 import しているファイルが「実際に作っている」ファイルです。
 *   土台を経由する呼び出し元まで数えても、誰が作ったのかは分かりません
 *
 * 包み直し（`const mk = (s) => __unsafeBlobKey(s)`）は、包んだファイル自身が
 * 直接 import するので、どちらの掛け方でも現れます。
 */

import type {
  ArtifactId,
  BlobKey,
  ObservationKind,
  SourceId,
  VersionId,
} from "../../src/domain/types.ts";

/**
 * 存在しない `ArtifactId` を名乗る。**嘘の ID。**
 *
 * 正規の `artifactId(key, ordinal)` は必ず64桁の16進を返すので、
 * 「系譜が切れている」状態を作れません。**拒否されることを確かめる試験専用**です。
 */
export function __unsafeArtifactId(id: string): ArtifactId {
  return id as ArtifactId;
}

/**
 * 宣言に無い観測種別を名乗る。**嘘の kind。**
 *
 * `observation` 表の CHECK 制約が拒むことを確かめるために要ります。
 * 正規の経路からは `ObservationKind` の21種しか出てきません。
 *
 * **AC-EXH-01 はこれを数えません。** 収集器は `run()` が通った後にだけ記録するので、
 * CHECK に弾かれた kind は「起きたこと」に入りません
 * （`test/support/exhaustiveness-recorder.ts`）。
 */
export function __unsafeObservationKind(kind: string): ObservationKind {
  return kind as ObservationKind;
}

/**
 * `BlobKey` を名乗る。**v0.1 ではこれ以外に作る手段がありません。**
 *
 * 本物の経路は `BlobStore.put` が返す `PutResult.blobKey` の1つだけで、
 * **v0.1 に `BlobStore` の実装はありません**（契約だけが先にある）。
 * `IdDerivation` が blobKey の導出を公開していないのは意図的で、
 * 「`PutResult` 経由でしか手に入らないこと」が
 * **`put` を通ったという受領証**だからです（AGENTS.md 9節 軸6）。
 *
 * つまりここでの洗浄は設計の帰結であって、直せる欠陥ではありません。
 * **`BlobStore` の実装が入ったら、呼び出し側を本物の `put` に置き換えてください。**
 */
export function __unsafeBlobKey(key: string): BlobKey {
  return key as BlobKey;
}

/**
 * `SourceId` を名乗る。
 *
 * **`ids.ts` に `sourceId()` はありません。** 接続元の設定から来る値で、
 * この系が導出する対象ではないためです（AGENTS.md 9節 軸0 の「葉」）。
 * 導出関数が無いので、テストが作る手段はこれだけです。
 */
export function __unsafeSourceId(id: string): SourceId {
  return id as SourceId;
}

/**
 * `VersionId` を名乗る。
 *
 * **正規の `versionId(documentId, contentHash)` が使えるならそちらを使ってください。**
 * ここを通してよいのは、生 SQL で `version_id` を直接 seed した DB を
 * 検査する場合だけです。実導出した ID では seed した行と一致しません。
 */
export function __unsafeVersionId(id: string): VersionId {
  return id as VersionId;
}
