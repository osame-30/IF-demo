/**
 * 攻撃 #16 — 1件の書き込み失敗が、実在するファイルを消す。
 *
 * 元の穴: 走査ループが `SQLITE_BUSY` を catch してログだけ出し、走査を続行した。
 * その document の `last_seen` だけが更新されないまま走査は「成功」で終わり、
 * 次の削除判定でその1件が欠損に見えて tombstone された。
 * **消えたのはファイルではなく、自分の記録です。**
 *
 * 防御は2つあり、片方だけでは足りません。
 *
 *   1. `recordObservedDocument` は失敗を**握りつぶさず例外を投げる**。
 *      戻り値で失敗を表すと、呼び出し側が読み飛ばした瞬間に穴が戻ります。
 *      例外なら、無視するには明示的に catch を書くしかありません。
 *   2. `writeFailureCount` が 0 でない走査は削除判定に進めない（G1）。
 *      しかも**承認で免除されません。**
 *
 * G1 が免除されない理由がこのシナリオの核心です。書き込み失敗は
 * 「世界がこうなっている」ではなく「自分の記録が不完全だ」という表明です。
 * 運用者は**記録されなかったものを知る手段を持たない**ので、
 * 「これは正当な欠損だ」という判断が原理的にできません。
 * 承認を許すと、運用者は自分が何を承認したのか分からないまま承認します。
 *
 * さらに G1 が立つと G2/G3 は評価されません。評価すると、記録されなかった観測が
 * 欠損に見え、`missing_ratio` という**誤った理由**が運用者に提示されます。
 */

import assert from "node:assert/strict";

import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import type { InvariantName, SourceId } from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = [
  "DELETION_ONLY_FROM_COMPLETED_SCAN",
  "IDEMPOTENT_REPLAY",
];

const SRC = "busy-nas" as SourceId;
const FILES = ["a.txt", "b.txt", "c.txt"];
const body = (name: string): string => `contents of ${name}`;

/**
 * 観測が既存 document の生存記録を進める文。
 * ここが失敗すると、その document だけが「今回見なかった」ことになる。
 *
 * **SQL の字面に依存しています。** 文が変われば注入は一致しなくなり、
 * `injected.fired` の検査が落ちます（S-18 で stable_key の更新を足したときに
 * 実際に落ちました）。字面ではなく名前で指定できるのは
 * before_statement / after_statement 以外の注入点だけなので、ここは字面が要ります。
 */
const LAST_SEEN_UPDATE = "UPDATE document SET stable_key=?, last_seen_at=?, last_seen_scan_id=?";

/** 走査を1本まるごと通す。全件観測して完了させる */
async function cleanScan(ctx: FixtureContext): Promise<void> {
  const scan = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of FILES) await ctx.ingest(scan.scanId, name, body(name));
  const finished = await ctx.store.finishScan(scan.scanId, {
    enumeratedCount: FILES.length,
    distinctCount: FILES.length,
    writeFailureCount: 0,
  });
  assert.equal(finished.status, "completed");
}

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC);
  await cleanScan(ctx);
  assert.equal(ctx.count("document WHERE state='active'"), 3);
}

export async function execute(ctx: FixtureContext): Promise<void> {
  ctx.clock.advance(1000);

  // --- 攻撃: 3件のうち1件だけ、観測の書き込みが失敗する ---
  const scan2 = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  await ctx.ingest(scan2.scanId, "a.txt", body("a.txt"));

  // 注入点は名前で指定する。タイミングにも SQL の実行順にも依存しない
  const injected = ctx.crash({
    at: "before_statement",
    matching: LAST_SEEN_UPDATE,
    occurrence: 1,
  });

  await assert.rejects(
    () =>
      ctx.store.recordObservedDocument(scan2.scanId, {
        stableKey: "b.txt",
        outcome: { kind: "content", contentHash: ctx.hashOf(body("b.txt")), sizeBytes: 20 },
      }),
    "失敗は戻り値ではなく例外で出る。握りつぶすには明示的な catch が要る（#16）",
  );
  assert.equal(injected.fired, 1, "注入点に到達しないまま緑になっていない");

  // 巻き戻っている。b.txt の生存記録は前回の走査のまま
  const bSeen = ctx.one<{ last_seen_scan_id: string }>(
    "SELECT last_seen_scan_id FROM document WHERE stable_key='b.txt'",
  )!;
  assert.notEqual(bSeen.last_seen_scan_id, scan2.scanId, "前提: b.txt は今回見たことになっていない");

  // 注入は1回だけ。c.txt は正常に観測できる
  await ctx.ingest(scan2.scanId, "c.txt", body("c.txt"));

  // --- 走査ループが数えた失敗件数を渡す ---
  const finished2 = await ctx.store.finishScan(scan2.scanId, {
    enumeratedCount: 3,
    distinctCount: 3,
    writeFailureCount: 1,
  });

  assert.equal(finished2.status, "aborted_safety", "書き込み失敗のある走査は完了させない");
  const reason2 = ctx.one<{ abort_reason: string }>(
    "SELECT abort_reason FROM scan_run WHERE scan_id=?",
    scan2.scanId,
  )!.abort_reason;
  assert.deepEqual(
    reason2.split(","),
    ["write_failures"],
    "G1 が立ったら G2/G3 は評価しない。誤った理由を運用者に提示しないため",
  );

  // --- 削除判定に進めない。b.txt は消えていない ---
  assert.equal(await ctx.store.promoteToCompleted(scan2.scanId), null);
  assert.equal(
    ctx.one<{ state: string }>("SELECT state FROM document WHERE stable_key='b.txt'")!.state,
    "active",
    "1件の書き込み失敗が実在するファイルを消していない",
  );
  assert.equal(ctx.observationCount("document_tombstoned"), 0);
  assert.equal(ctx.observationCount("scan_aborted_safety"), 1);

  // --- 承認しても G1 は免除されない ---
  ctx.clock.advance(1000);
  const scan3 = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of FILES) await ctx.ingest(scan3.scanId, name, body(name));
  await ctx.store.approveScan(scan3.scanId, "operator claims the missing write is harmless", 1);

  const finished3 = await ctx.store.finishScan(scan3.scanId, {
    enumeratedCount: 3,
    distinctCount: 3,
    // 全件観測しているので G2/G3 は元から立たない。残るのは G1 だけ
    writeFailureCount: 1,
  });
  assert.equal(
    finished3.status,
    "aborted_safety",
    "承認は G2/G3 にしか効かない。記録されなかったものを運用者は判断できない",
  );
  assert.deepEqual(
    ctx.one<{ abort_reason: string }>(
      "SELECT abort_reason FROM scan_run WHERE scan_id=?",
      scan3.scanId,
    )!.abort_reason.split(","),
    ["write_failures"],
  );
  // 免除されなかったので、承認された旨の記録も残らない
  assert.equal(ctx.observationCount("scan_approved_by_operator"), 0);
  assert.equal(await ctx.store.promoteToCompleted(scan3.scanId), null);

  // --- IDEMPOTENT_REPLAY: 注入なしで2回回すと状態が一致する ---
  ctx.clock.advance(1000);
  await cleanScan(ctx);
  const before = await ctx.snapshot();

  ctx.clock.advance(1000);
  await cleanScan(ctx);
  const after = await ctx.snapshot();

  ctx.declareReplay(before, after);
  assert.equal(ctx.count("document WHERE state='active'"), 3);
}
