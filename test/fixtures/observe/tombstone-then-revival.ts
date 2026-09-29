/**
 * 攻撃 #25 — tombstone された文書が復元されると、内部矛盾と確定済み系譜の
 * 誤りが同時に発生する。
 *
 * 元の穴: tombstone された文書が復元されると、`state` は `active` に戻るのに
 * `tombstonedAt` が残ったままになり、「active なのに tombstone された時刻を
 * 持つ」という内部矛盾が生まれました。さらに、その文書の消失を「別名への
 * リネーム」と確定していた `rename_candidate.resolution = 'confirmed_rename'`
 * が、元文書が復活した以上、事後的に誤りになります
 * （リネームではなく、単に消えて戻ってきただけだった可能性がある）。
 *
 * 防御:
 *   - 復活時は `tombstoned_at` を必ず NULL に戻す（スキーマの CHECK
 *     `(state = 'tombstoned') = (tombstoned_at IS NOT NULL)` でも構造的に守る）。
 *   - 復活した文書に紐づく `confirmed_rename` を `needs_recheck` に差し戻す。
 *     **再確認のワークフローは作らない**（KNOWN_LIMITATIONS.md 3節）。
 *     差し戻すところまでが v0.1 の責務。
 *
 * tombstone を書く API は `LineageStore` に無い。書くのは STEP 4 の
 * パイプライン層（delete 判定後の実際の書き込み）の役目で、v0.1 はまだ
 * そこを実装していない。だからここでは `ctx.conn.db` で直接
 * `UPDATE document SET state='tombstoned', tombstoned_at=?` する。
 * 同じ理由で `rename_candidate` への `confirmed_rename` の INSERT も、
 * リネーム確定の判断そのものが v0.1 の外側（記録のみ。KNOWN_LIMITATIONS.md 3節の
 * 「RenameCandidate の自動統合」）にあるため、生 SQL で直接作る。
 *
 * 順序の検証は `observation_seq`（`ctx.observationOrder()`）で行う。
 * `observation_id` は UUIDv4 で構造的に整列できない（AGENTS.md 3.2）。
 * `occurred_at` も同一トランザクション内では同値になる。
 */

import assert from "node:assert/strict";

import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import type { DocumentId, InvariantName, SourceId } from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = ["IDEMPOTENT_REPLAY"];

const SRC = "revival-share" as SourceId;
/** 弁の分母 */
const ORDINARY = Array.from({ length: 18 }, (_, i) => `f${i}.txt`);
const A = "a.txt";
const B = "b.txt";

const body = (name: string): string => `contents of ${name}`;
const bodyA = "content of a.txt";
const bodyB = "content of b.txt";

/** ORDINARY + a.txt + b.txt を1本まるごと走査して完了させる（内容は不変） */
async function scanAll(ctx: FixtureContext): Promise<void> {
  const scan = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of ORDINARY) await ctx.ingest(scan.scanId, name, body(name));
  await ctx.ingest(scan.scanId, A, bodyA);
  await ctx.ingest(scan.scanId, B, bodyB);
  const finished = await ctx.store.finishScan(scan.scanId, {
    enumeratedCount: ORDINARY.length + 2,
    distinctCount: ORDINARY.length + 2,
    writeFailureCount: 0,
  });
  assert.equal(finished.status, "completed");
}

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC);
  await scanAll(ctx);
  assert.equal(ctx.count("document_version"), ORDINARY.length + 2);
}

export async function execute(ctx: FixtureContext): Promise<void> {
  ctx.clock.advance(1000);

  const docA = ctx.one<{ document_id: string }>(
    "SELECT document_id FROM document WHERE stable_key=?",
    A,
  )!.document_id as DocumentId;
  const docB = ctx.one<{ document_id: string }>(
    "SELECT document_id FROM document WHERE stable_key=?",
    B,
  )!.document_id as DocumentId;

  // --- 1. a.txt を tombstone にする ---
  // LineageStore に tombstone を書く API は無い（書くのは STEP 4 のパイプライン層）。
  // ここでは delete 判定後の書き込みが既に行われた状態を直接作る
  const tombstonedAt = ctx.clock.now();
  ctx.conn.db
    .prepare("UPDATE document SET state='tombstoned', tombstoned_at=? WHERE document_id=?")
    .run(tombstonedAt, docA);

  // a.txt の消失を b.txt へのリネームとして確定していた、という想定を直接作る。
  // リネーム確定の判断そのものは v0.1 の外側（記録のみ）にあるため、ここも生 SQL
  const renameHash = ctx.hashOf("a.txt renamed to b.txt (assumed)");
  ctx.conn.db
    .prepare(
      `INSERT INTO rename_candidate
         (disappeared_document_id, appeared_document_id, content_hash, observed_at, resolution)
       VALUES (?, ?, ?, ?, 'confirmed_rename')`,
    )
    .run(docA, docB, renameHash, ctx.clock.now());

  assert.equal(
    ctx.one<{ state: string }>("SELECT state FROM document WHERE document_id=?", docA)!.state,
    "tombstoned",
  );

  // --- 2. 次の走査で a.txt を再観測すると復活する ---
  ctx.clock.advance(1000);
  const scan2 = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of ORDINARY) await ctx.ingest(scan2.scanId, name, body(name));
  const observedA = await ctx.store.recordObservedDocument(scan2.scanId, {
    stableKey: A,
    outcome: { kind: "content", contentHash: ctx.hashOf(bodyA), sizeBytes: Buffer.byteLength(bodyA, "utf8") },
  });
  assert.equal(observedA.revived, true, "recordObservedDocument が revived を返す");
  await ctx.ingest(scan2.scanId, B, bodyB);
  await ctx.store.finishScan(scan2.scanId, {
    enumeratedCount: ORDINARY.length + 2,
    distinctCount: ORDINARY.length + 2,
    writeFailureCount: 0,
  });

  // --- 3. state='active' かつ tombstoned_at IS NULL。残っていたら内部矛盾 ---
  const revivedRow = ctx.one<{ state: string; tombstoned_at: number | null }>(
    "SELECT state, tombstoned_at FROM document WHERE document_id=?",
    docA,
  )!;
  assert.equal(revivedRow.state, "active");
  assert.equal(revivedRow.tombstoned_at, null, "tombstonedAt が残ると内部矛盾になる（スキーマの CHECK でも守られる）");

  // --- 4. document_revived が1件、rename_needs_recheck が1件。resolution も戻る ---
  assert.equal(ctx.observationCount("document_revived", docA), 1);
  assert.equal(ctx.observationCount("rename_needs_recheck", docA), 1);

  const candidate = ctx.one<{ resolution: string }>(
    "SELECT resolution FROM rename_candidate WHERE disappeared_document_id=? AND appeared_document_id=?",
    docA,
    docB,
  )!;
  assert.equal(
    candidate.resolution,
    "needs_recheck",
    "確定済みだったリネーム判断は事後的に誤りになりうる。差し戻すだけで再確認はしない",
  );

  // --- 5. 順序は observation_seq で確認する。復活が先、差し戻しが後 ---
  const order = ctx.observationOrder();
  const revivedIdx = order.indexOf("document_revived");
  const recheckIdx = order.indexOf("rename_needs_recheck");
  assert.ok(revivedIdx >= 0 && recheckIdx >= 0, "両方の observation が記録されている");
  assert.ok(revivedIdx < recheckIdx, "復活の記録が先、リネーム差し戻しの記録が後");

  // --- 6. IDEMPOTENT_REPLAY: 復活後にもう一度同じ走査を回しても状態が一致する ---
  const before = await ctx.snapshot();
  ctx.clock.advance(1000);
  await scanAll(ctx);
  const after = await ctx.snapshot();
  ctx.declareReplay(before, after);
}
