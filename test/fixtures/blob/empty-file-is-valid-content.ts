/**
 * 攻撃 #20 — 空ファイルが「存在しない」として扱われる。
 *
 * 元の穴: 0バイトのファイルを「中身が無い＝まだ書かれていない」と読み、
 * 版を作らずに飛ばした。あるいは既存の blob をサイズで判定して
 * 「0バイトなら未書き込み」とみなし、毎回書き直した。
 * **0 は正当な内容であり、「値なし」ではありません。**
 *
 * 防御は2つあります。
 *
 *   1. `BlobStore` に `exists()` がありません。存在判定の代わりに
 *      実バイト列を読み直してハッシュを突き合わせます。空ファイルの
 *      sha256 は `e3b0c4...` という具体的な値を持つので、
 *      「無い」と区別できます。
 *   2. `put` の `expectedSizeBytes` は `number` であって省略可能では
 *      ありません。0 を渡す経路と渡さない経路が型の上で別です（#7）。
 *
 * このフィクスチャは空の内容を1件取り込み、**同じ空の内容をもう一度**
 * 取り込んでも新しい行が増えないことを見ます。サイズで存在を判定して
 * いれば、2回目は「まだ無い」と読んで版を作り直します。
 */

import assert from "node:assert/strict";

import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import type { InvariantName, SourceId } from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = [
  "HASH_MATCHES_BLOB",
  "NO_WORK_WITHOUT_CHANGE",
];

const SRC = "archive-empty" as SourceId;
const EMPTY_KEY = "empty.txt";
const FILLED_KEY = "filled.txt";
const FILLED_BODY = "not empty";

/**
 * 空バイト列の sha256。**FIXTURES.md #20 が固定値として名指ししている値です。**
 *
 * ここに書くのは、実装の出力を実装で検算しないためです。
 * 外から与えた値と一致しなければ、ハッシュの計算そのものが動いています。
 */
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC);
  const scan1 = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  // 空と非空を両方入れる。空だけだと「1件も処理していない」と区別できない
  await ctx.ingest(scan1.scanId, EMPTY_KEY, "");
  await ctx.ingest(scan1.scanId, FILLED_KEY, FILLED_BODY);
  await ctx.store.finishScan(scan1.scanId, {
    enumeratedCount: 2,
    distinctCount: 2,
    writeFailureCount: 0,
  });
  assert.equal(ctx.count("document WHERE state='active'"), 2);
  assert.equal(ctx.count("document_version"), 2);
}

export async function execute(ctx: FixtureContext): Promise<void> {
  // --- 空の内容は具体的な鍵を持つ。「無い」とは別物 ---
  const emptyVersion = ctx.one<{ blob_key: string; content_hash: string; size_bytes: number }>(
    `SELECT dv.blob_key, dv.content_hash, dv.size_bytes
       FROM document_version dv JOIN document d ON d.document_id = dv.document_id
      WHERE d.stable_key = ?`,
    EMPTY_KEY,
  );
  assert.ok(emptyVersion, "空の内容にも版がある");
  assert.equal(emptyVersion.content_hash, EMPTY_SHA256, "外から与えた固定値と一致する");
  assert.equal(emptyVersion.blob_key, EMPTY_SHA256, "鍵は内容ハッシュそのもの");
  assert.equal(emptyVersion.size_bytes, 0, "0 が保存されている（NULL でも欠損でもない）");

  // --- 実体はサイズ 0 のまま検証を通る ---
  // サイズで存在を判定していれば、ここが false になります
  assert.equal(
    await ctx.blobs.verify(
      emptyVersion.blob_key as Parameters<typeof ctx.blobs.verify>[0],
      emptyVersion.content_hash as Parameters<typeof ctx.blobs.verify>[1],
    ),
    true,
    "0バイトの実体が「無い」と判定されている",
  );

  // --- 再 put は created:false。書き直していない ---
  const again = await ctx.putBlob("");
  assert.equal(String(again.blobKey), EMPTY_SHA256);
  assert.equal(again.sizeBytes, 0);

  // --- NO_WORK_WITHOUT_CHANGE: 同じ内容の再取り込みで行が増えない ---
  ctx.clock.advance(1000);
  const scan2 = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);

  const before = await ctx.snapshot();
  await ctx.ingest(scan2.scanId, EMPTY_KEY, "");
  await ctx.ingest(scan2.scanId, FILLED_KEY, FILLED_BODY);
  const after = await ctx.snapshot();
  ctx.declareReplay(before, after);

  await ctx.store.finishScan(scan2.scanId, {
    enumeratedCount: 2,
    distinctCount: 2,
    writeFailureCount: 0,
  });

  // 版が増えていたら、空の内容を毎回「新しい」と読んでいる
  assert.equal(ctx.count("document_version"), 2, "空の内容が版を増やしていない");
  assert.equal(ctx.count("document WHERE state='active'"), 2);
}
