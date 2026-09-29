/**
 * 攻撃 #30 — DB と blob のバックアップ時点がずれる。
 *
 * 元の穴: DB を新しいバックアップから、blob を古いバックアップから戻した。
 * DB には版の行があるのに、その鍵の実体が存在しない。
 * **系譜は完全に辿れます。** `document` から `document_version` へ、
 * `artifact` から `derivation` へ、参照はすべて解決します。
 * 欠けているのは表の外側にあるバイト列だけなので、
 * `LINEAGE_COMPLETE` は真のまま緑を返します。
 *
 * この形が危ないのは、**壊れていることを表の中からは知りようがない**点です。
 * 「行があるから中身もある」は「存在するから正しい」の別の言い方です
 * （AGENTS.md 3.7）。`HASH_MATCHES_BLOB` だけが実バイト列を読み直すので、
 * これを走らせない限り不在は見つかりません。
 *
 * ## 検出のみ。修復はしません
 *
 * v0.1 は自動で戻しません（KNOWN_LIMITATIONS 4節）。**どちらのバックアップが
 * 正しいかを、システムは言えないからです。** 消えた実体を「無かったこと」に
 * して版を消すのも、古い実体を「正しい」として採用するのも、
 * どちらも人間の判断が要ります。ここで確かめるのは
 * 「気づける」ことまでです。
 *
 * フィクスチャ自身は探りを元に戻します。`HASH_MATCHES_BLOB` が破れたまま
 * 終える形（`expectedViolations`）は #11 の1本だけに限られているためで、
 * 「戻せるから軽い問題だ」という意味ではありません。
 */

import assert from "node:assert/strict";
import { rm, readFile } from "node:fs/promises";

import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import { blobPath } from "../../../src/store/blob/blob-path.ts";
import { diffSnapshots, isEmptyDiff } from "../../support/state-snapshot.ts";
import type { BlobKey, ContentHash, InvariantName, SourceId } from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = [
  "LINEAGE_COMPLETE",
  "HASH_MATCHES_BLOB",
];

const SRC = "vault-restored" as SourceId;
const KEPT_KEY = "kept.txt";
const LOST_KEY = "lost.txt";
const KEPT_BODY = "this blob survived the restore";
const LOST_BODY = "this blob is older than the database";

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC);
  const scan = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  await ctx.ingest(scan.scanId, KEPT_KEY, KEPT_BODY);
  await ctx.ingest(scan.scanId, LOST_KEY, LOST_BODY);
  await ctx.store.finishScan(scan.scanId, {
    enumeratedCount: 2,
    distinctCount: 2,
    writeFailureCount: 0,
  });
  assert.equal(ctx.count("document_version"), 2);
}

/** その stable_key の版が指している鍵と期待ハッシュ */
function blobOf(ctx: FixtureContext, stableKey: string): { key: BlobKey; hash: ContentHash } {
  const row = ctx.one<{ blob_key: string; content_hash: string }>(
    `SELECT dv.blob_key, dv.content_hash
       FROM document_version dv JOIN document d ON d.document_id = dv.document_id
      WHERE d.stable_key = ?`,
    stableKey,
  );
  assert.ok(row, `版が見つからない: ${stableKey}`);
  return { key: row.blob_key as BlobKey, hash: row.content_hash as ContentHash };
}

export async function execute(ctx: FixtureContext): Promise<void> {
  const kept = blobOf(ctx, KEPT_KEY);
  const lost = blobOf(ctx, LOST_KEY);
  const before = await ctx.snapshot();

  // --- 攻撃: blob だけ古いバックアップから戻った ---
  // DB は触りません。表は完全なまま、実体だけが1つ消えます
  await rm(blobPath(ctx.blobRoot, lost.key));

  // --- 系譜は完全に見える ---
  // 参照はすべて解決する。version 行も document 行もそのまま
  assert.equal(ctx.count("document_version"), 2, "表は無傷");
  assert.equal(ctx.count("document WHERE state='active'"), 2);
  assert.equal(
    ctx.count(
      `document_version dv JOIN document d ON d.document_id = dv.document_id
        WHERE d.stable_key = ?`,
      LOST_KEY,
    ),
    1,
    "実体が消えても行は残る。ここが LINEAGE_COMPLETE が緑を返す理由",
  );

  // --- 表の外側を読み直して初めて分かる ---
  assert.equal(
    await ctx.blobs.verify(lost.key, lost.hash),
    false,
    "消えた実体が検証を通っている",
  );
  assert.equal(await ctx.blobs.verify(kept.key, kept.hash), true, "残った方は無事");

  // 消えた実体は「読めない」であって「別内容」ではありません。
  // 修復用の口でも読めないので、中身を調べる手段そのものがありません
  await assert.rejects(
    () => ctx.blobs.getUnverifiedForRepair(lost.key),
    (error: unknown) => (error as { code?: unknown }).code === "ENOENT",
    "消えた実体が読めてしまっている",
  );

  // --- 検出のみ。ここでは人間が持ってきた正バイト列で戻す ---
  // 自動では戻しません。どちらのバックアップが正しいかをシステムは言えない
  await ctx.blobs.restoreFromVerifiedBytes(
    lost.key,
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(LOST_BODY));
        controller.close();
      },
    }),
    Buffer.byteLength(LOST_BODY, "utf8"),
  );
  assert.equal(await ctx.blobs.verify(lost.key, lost.hash), true, "戻せていない");
  assert.equal(await readFile(blobPath(ctx.blobRoot, lost.key), "utf8"), LOST_BODY);

  // DB には最初から最後まで触れていない
  assert.ok(
    isEmptyDiff(diffSnapshots(before, await ctx.snapshot())),
    "blob の消失と修復が DB の状態を動かしている",
  );
}
