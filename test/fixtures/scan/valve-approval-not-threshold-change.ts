/**
 * 攻撃 #28 — 弁が正当に発火し続ける source で、運用者が閾値を0にして
 * 弁そのものを恒久的に無効化する。
 *
 * 元の穴: 正当に縮小していく source では、弁が毎回発火します。走査を通す手段が
 * 「閾値を下げる」しかなければ、運用者は必ず閾値を下げます。そして
 * **閾値を0にした瞬間、本物のマウント失敗も通過するようになります。**
 * 弁は残っているのに、二度と鳴りません。
 *
 * 防御: `approveScan` は**その走査にのみ効く1回限りの記録**で、閾値は変えません。
 * 閾値を書き換える API は `LineageStore` に存在しません。
 *
 * なぜ「承認」という別の口を用意するのかが要点です。弁が正当に発火する状況が
 * 実在する以上、通す手段を用意しないことは選べません。用意しないと、
 * 運用者は用意されている唯一の手段（閾値）を壊します。
 * 用意するなら、**効果範囲が1回に限られていて、次の走査には持ち越されない**
 * 形でなければ、承認は実質的な無効化と同じになります。
 *
 * 承認が G1（書き込み失敗）を免除しないことは #16 が受け持ちます。
 */

import assert from "node:assert/strict";

import { isStoreError } from "../../../src/domain/errors.ts";
import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import type { InvariantName, LineageStore, SourceId } from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = ["SAFETY_ABORT_WRITES_NOTHING"];

// 閾値を書き換える口が存在しないことをコンパイル時に確かめる。
// この口が生えたら承認は要らなくなり、同時に弁も要らなくなる。
// @ts-expect-error 閾値を書き換える API は存在しない（KNOWN_LIMITATIONS 8節）
const _noThresholdSetter = (store: LineageStore) => store.setThresholds;

const SRC = "shrinking-share" as SourceId;
const BASELINE = Array.from({ length: 10 }, (_, i) => `f${i}.txt`);
const body = (name: string): string => `contents of ${name}`;

/** 走査を1本開き、渡した鍵だけを観測して閉じる。承認は任意 */
async function scanWith(
  ctx: FixtureContext,
  files: ReadonlyArray<string>,
  approveNote?: string,
): Promise<{ scanId: string; status: string }> {
  const scan = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of files) await ctx.ingest(scan.scanId, name, body(name));
  if (approveNote !== undefined) await ctx.store.approveScan(scan.scanId, approveNote, BASELINE.length);
  const finished = await ctx.store.finishScan(scan.scanId, {
    enumeratedCount: files.length,
    distinctCount: files.length,
    writeFailureCount: 0,
  });
  return { scanId: scan.scanId, status: finished.status };
}

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC);
  const base = await scanWith(ctx, BASELINE);
  assert.equal(base.status, "completed");
  assert.equal(ctx.count("document WHERE state='active'"), 10);
}

export async function execute(ctx: FixtureContext): Promise<void> {
  // --- 正当な縮小でも、承認なしでは通らない ---
  ctx.clock.advance(1000);
  const unapproved = await scanWith(ctx, ["f0.txt", "f1.txt"]);
  assert.equal(unapproved.status, "aborted_safety", "弁は正当な縮小でも発火する。これは仕様");
  assert.equal(ctx.observationCount("scan_aborted_safety"), 1);

  // --- 承認するとその走査だけが通る ---
  ctx.clock.advance(1000);
  const approved = await scanWith(
    ctx,
    ["f0.txt", "f1.txt"],
    "8 files were archived off-site on purpose; ticket OPS-1421",
  );
  assert.equal(approved.status, "completed");

  const excused = ctx.observationDetails("scan_approved_by_operator");
  assert.equal(excused.length, 1, "承認して通した事実が記録に残る");
  assert.deepEqual(
    excused[0]!["excused"],
    ["count_ratio", "missing_ratio"],
    "何を免除したかが正準トークンで残る。自由文だと後から機械判定できない",
  );
  assert.equal(excused[0]!["note"], "8 files were archived off-site on purpose; ticket OPS-1421");

  // --- 閾値そのものは1ビットも変わっていない ---
  const thresholds = ctx.rows<{ count_ratio_threshold_bp: number; missing_ratio_threshold_bp: number }>(
    "SELECT count_ratio_threshold_bp, missing_ratio_threshold_bp FROM scan_run ORDER BY started_at",
  );
  for (const row of thresholds) {
    assert.equal(row.count_ratio_threshold_bp, DEFAULT_THRESHOLDS.countRatioThresholdBp);
    assert.equal(row.missing_ratio_threshold_bp, DEFAULT_THRESHOLDS.missingRatioThresholdBp);
  }

  // --- 承認は次の走査に持ち越されない ---
  // さらに縮小した（2件 → 0件）走査は、前回承認されていても改めて発火する
  ctx.clock.advance(1000);
  const next = await scanWith(ctx, []);
  assert.equal(next.status, "aborted_safety", "1回限りでなければ承認は実質的な無効化と同じ");
  assert.equal(
    ctx.one<{ approved_at: number | null }>(
      "SELECT approved_at FROM scan_run WHERE scan_id=?",
      next.scanId,
    )!.approved_at,
    null,
    "承認の記録が勝手に引き継がれていない",
  );
  assert.equal(ctx.observationCount("scan_approved_by_operator"), 1, "承認は1件のまま");

  // --- 理由のない承認は記録として使えない ---
  ctx.clock.advance(1000);
  const bare = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const note of ["", "   "]) {
    await assert.rejects(
      () => ctx.store.approveScan(bare.scanId, note, BASELINE.length),
      (e: unknown) => isStoreError(e, "invalid_argument"),
    );
  }
  assert.equal(
    ctx.one<{ approved_at: number | null }>(
      "SELECT approved_at FROM scan_run WHERE scan_id=?",
      bare.scanId,
    )!.approved_at,
    null,
    "拒否時に承認の痕跡を残さない",
  );

  // --- 承認は「承認してから完了させる」順序に限る ---
  await ctx.store.finishScan(bare.scanId, {
    enumeratedCount: 0,
    distinctCount: 0,
    writeFailureCount: 0,
  });
  await assert.rejects(
    () => ctx.store.approveScan(bare.scanId, "let it through after the fact", BASELINE.length),
    (e: unknown) => isStoreError(e, "scan_not_running"),
    "終わった走査を後から承認できると、弁は判定の後に無効化できる",
  );

  // --- 弁が守ろうとしたものは最後まで消えていない ---
  assert.equal(ctx.count("document WHERE state='tombstoned'"), 0);
  assert.equal(ctx.observationCount("document_tombstoned"), 0);
  assert.equal(ctx.count("document WHERE state='active'"), 10);
}
