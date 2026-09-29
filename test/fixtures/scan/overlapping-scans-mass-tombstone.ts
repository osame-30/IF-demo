/**
 * 攻撃 #1 — 走査AとBが重なり、遅れて完了したAが全件を欠損と読む。
 *
 * 元の穴: 走査AとBが同時に走り、Bが全件の lastSeen を更新した後で
 * Aが遅れて完了し、`findMissingSince(A)` を呼んだ。Aから見ると
 * 全件が「自分の走査で見ていない」ので、全件が tombstone になった。
 *
 * 防御は2層です。どちらか片方でも消えると攻撃は通ります。
 *   1. `idx_one_running_scan` — そもそも同時に running にできない
 *   2. `promoteToCompleted` が最新完了走査でなければ `null` を返す
 *
 * 2層目が要るのは、1層目が「同時に走らせない」しか言っていないからです。
 * 順番に走らせて、古いほうを後から promote する経路は塞げません。
 * **どちらの層も、削除の入口が `CompletedScanRun` 1つしかないから意味を持ちます。**
 */

import assert from "node:assert/strict";

import { isStoreError } from "../../../src/domain/errors.ts";
import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import type { InvariantName, ScanId, SourceId } from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = [
  "ONE_RUNNING_SCAN_PER_SOURCE",
  "DELETION_ONLY_FROM_COMPLETED_SCAN",
];

const SRC = "nas-tokyo" as SourceId;
const FILES = ["a.txt", "b.txt", "c.txt"];

/** 走査を1本まるごと通す。観測 → 完了 */
async function fullScan(ctx: FixtureContext, files: ReadonlyArray<string>): Promise<ScanId> {
  const scan = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of files) await ctx.ingest(scan.scanId, name, `contents of ${name}`);
  await ctx.store.finishScan(scan.scanId, {
    enumeratedCount: files.length,
    distinctCount: files.length,
    writeFailureCount: 0,
  });
  return scan.scanId;
}

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC);
  // 基準となる完了走査。3件が active な状態から攻撃を始める
  await fullScan(ctx, FILES);
  assert.equal(ctx.count("document WHERE state='active'"), 3);
}

export async function execute(ctx: FixtureContext): Promise<void> {
  // --- 1層目: 同一 source で running を2本にできない ---
  const scanA = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);

  await assert.rejects(
    () => ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS),
    (e: unknown) => isStoreError(e, "concurrent_scan"),
  );
  assert.equal(ctx.count("scan_run WHERE source_id=? AND status='running'", SRC), 1);

  // --- 2層目: 順番に走らせて古いほうを後から promote する ---
  // Aは全件を観測して正常に完了する。Aだけを見れば何も異常はない
  for (const name of FILES) await ctx.ingest(scanA.scanId, name, `contents of ${name}`);
  await ctx.store.finishScan(scanA.scanId, {
    enumeratedCount: 3,
    distinctCount: 3,
    writeFailureCount: 0,
  });

  ctx.clock.advance(1000);
  // Bが後から走り、全件の lastSeen を自分の scanId に更新する
  const scanB = await fullScan(ctx, FILES);

  // ここが攻撃の核心。Aは completed で writeFailure も 0 なのに、
  // 最新ではないので削除判定に進めない
  assert.equal(
    await ctx.store.promoteToCompleted(scanA.scanId),
    null,
    "追い越された走査から削除判定に入れてはいけない",
  );

  // Bは進める。そして欠損は0件（Bが全件見ているので当然）
  const promotedB = await ctx.store.promoteToCompleted(scanB);
  assert.ok(promotedB, "最新完了走査は進める");

  const missing: string[] = [];
  for await (const doc of ctx.store.findMissingSince(promotedB)) missing.push(doc.stableKey);
  assert.deepEqual(missing, [], "Bから見れば欠損はない");

  // --- 結果: tombstone は1件も書かれていない ---
  assert.equal(ctx.count("document WHERE state='tombstoned'"), 0);
  assert.equal(ctx.observationCount("document_tombstoned"), 0, "全件 tombstone が起きていない");
  assert.equal(ctx.count("document WHERE state='active'"), 3);
}
