/**
 * 攻撃 #4 — 弁が確定する前に tombstone が書かれる。
 *
 * 元の穴: `AsyncIterable` で列挙しながら逐次 tombstone を書く実装では、
 * 件数が確定する前に大量の tombstone が書かれ、その後で弁が発火して
 * `aborted_safety` になった。弁が「もう手遅れになってから」判定される
 * 設計だと、`finishScan` の戻り値を見た時点で被害はすでに確定している。
 *
 * この LineageStore v0.1 には tombstone を書き込む API 自体がまだ存在しない
 * （`findMissingSince` は欠損の集合を返すだけで、実際に消す処理はパイプライン層
 * の責務）。だから字義通りの「逐次書く実装」は今のコードベースには無い。
 * しかし重要なのは「無いから安全」ではなく、「無くても再現できない形に
 * なっている」ことだ。防御は型と実行順の二重になっている。
 *
 *   1. `findMissingSince` は `ScanId` ではなく `CompletedScanRun` しか
 *      受け取れない。この型は `promoteToCompleted` からしか得られず、
 *      `promoteToCompleted` は `status === 'completed'` を要求する。
 *      だから「まだ finishScan していない走査」や「aborted_safety に
 *      なった走査」を渡すコードはそもそもコンパイルが通らない。
 *      将来 tombstone を書くパイプラインを実装しても、削除の入口を
 *      `ScanId` に広げない限りこの型は回避できない。
 *   2. `findMissingSince` 自身も、欠損集合を単一の読み取りトランザクション
 *      内で確定してから yield する（遅延クエリにしない）。呼び出し側が
 *      反復中に書き込んでも、自分が読んでいる集合を書き換える余地がない。
 *
 * なぜこれで効くのか — 「削除できる状態」を表す型を1つしか用意しないことで、
 * 「まだ削除していい状態と確定していないのに削除用のAPIへ渡す」という
 * バグの余地そのものを消している。実行時チェックに頼るなら、
 * チェックを1箇所書き忘れるだけで穴が戻る。型なら書き忘れようがない。
 */

import assert from "node:assert/strict";

import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import type { InvariantName, LineageStore, ScanId, SourceId } from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = [
  "SAFETY_ABORT_WRITES_NOTHING",
  "DELETION_ONLY_FROM_COMPLETED_SCAN",
];

// --- 型テスト（モジュールのトップレベル。実行時には何もしない） ---
// もし本当に findMissingSince が ScanId を受け取れてしまっていたら、
// 次の行に型エラーが無くなり、tsc --noEmit が
// 「Unused '@ts-expect-error' directive」で落ちる。緑になること自体が検証。
// @ts-expect-error findMissingSince は ScanId を受け取らない。CompletedScanRun だけが入口
const _typeGuard = (store: LineageStore, scanId: ScanId) => store.findMissingSince(scanId);

const SRC = "silent-nas" as SourceId;
const FILES = ["a.txt", "b.txt", "c.txt"];

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC);
  const base = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of FILES) await ctx.ingest(base.scanId, name, `contents of ${name}`);
  await ctx.store.finishScan(base.scanId, {
    enumeratedCount: FILES.length,
    distinctCount: FILES.length,
    writeFailureCount: 0,
  });
  assert.equal(ctx.count("document WHERE state='active'"), 3);
}

export async function execute(ctx: FixtureContext): Promise<void> {
  ctx.clock.advance(1000);

  // --- 攻撃: 次の走査は1件も観測せずに finishScan する ---
  // マウントが応答しなくなり、列挙が0件で終わった状況の再現
  const next = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  const finished = await ctx.store.finishScan(next.scanId, {
    enumeratedCount: 0,
    distinctCount: 0,
    writeFailureCount: 0,
  });

  assert.equal(finished.status, "aborted_safety", "全件欠損なので弁が発火するはず");

  // --- 削除判定の唯一の入口が閉じている ---
  assert.equal(
    await ctx.store.promoteToCompleted(next.scanId),
    null,
    "aborted_safety の走査から CompletedScanRun は得られない。" +
      "findMissingSince を呼ぶ手段そのものが無い",
  );

  // --- tombstone は1件も書かれていない ---
  assert.equal(ctx.count("document WHERE state='tombstoned'"), 0);
  assert.equal(ctx.observationCount("document_tombstoned"), 0);

  // --- 原本は immutable。aborted_safety になった走査でも document 行は消えない ---
  assert.equal(ctx.count("document WHERE source_id=?", SRC), 3, "原本の行は消えていない");
  assert.equal(ctx.count("document WHERE source_id=? AND state='active'", SRC), 3);

  // --- 弁の発火が観測にも残る ---
  assert.equal(ctx.observationCount("scan_aborted_safety"), 1);
}
