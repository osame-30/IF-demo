/**
 * 攻撃 #3 — failed に落ちた走査が次回の基準値を汚染する。
 *
 * 元の穴: マウント半死で120件しか取れずに `failed` になった走査があった。
 * 次の走査がその120件を基準値として使い、110/120 = 0.92 で件数比の弁を
 * 通過し、本来まだ存在する9880件を欠損と誤認して tombstone にした。
 * `failed` は「世界の状態」ではなく「自分の観測が壊れていた」という表明であり、
 * それを基準にすると弁は嘘の合格を出す。
 *
 * 防御: `beginScan` が基準値（previousCompletedScanId / previousDistinctCount）を
 * 採るクエリは `WHERE status = 'completed'` に絞られている（lineage-store.ts の
 * `beginScan`）。`failed` の走査は最新であっても基準の候補にすら入らない。
 * なぜこれで効くのか — 基準値の「出所」を型やAPIで縛るのではなく、
 * SQL の WHERE 句1本に集約しているので、"failed" 状態から基準値へ至る経路が
 * 構造的に存在しない。実装者が誤って `ORDER BY started_at DESC LIMIT 1`
 * のような「最新の走査」クエリを書かない限り、この穴は再現しようがない。
 *
 * 走査を `failed` で閉じるのは `failScan` です。列挙そのものが続けられなく
 * なったときにパイプライン層が呼びます。この口が無いと、クラッシュした走査が
 * `running` のまま残り、`idx_one_running_scan` によってその source では
 * 二度と `beginScan` できません。「安全に閉じる手段が無い」のは
 * fail-closed ではなく、ただの閉塞です。
 *
 * 対比（実行はしない。防御が塞いでいる経路なので API 越しに再現できない）:
 * もし failed の走査（distinctCount=2）が基準に選ばれていたら、次の走査が
 * 同じ2件だけを観測しても 2/2 = 100% で件数比を通過し、欠損率も 0/2 = 0% で
 * 通過する。旧基準の20件のうち18件がまだ実在するにもかかわらず、
 * 弁は「何も異常はない」と報告してしまう。正しい基準（20件）を使えば、
 * 同じ2件しか観測できていない事実は 2/20 として弁を発火させる。
 */

import assert from "node:assert/strict";

import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import type { InvariantName, ScanId, SourceId } from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = ["SAFETY_ABORT_WRITES_NOTHING"];

const SRC = "half-dead-nas" as SourceId;
// 10000件は重いので縮尺する。比率の構造は同じ（正しい基準 vs 汚染された基準）
const BASELINE_FILES = Array.from({ length: 20 }, (_, i) => `f${i}.txt`);

/** 正常に完了した基準走査。execute から見て「正しい基準」がこれであることを検証する */
let baseScanId: ScanId;

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC);

  // 正常な基準走査。20件が active になる
  const base = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of BASELINE_FILES) await ctx.ingest(base.scanId, name, `contents of ${name}`);
  await ctx.store.finishScan(base.scanId, {
    enumeratedCount: BASELINE_FILES.length,
    distinctCount: BASELINE_FILES.length,
    writeFailureCount: 0,
  });
  assert.equal(ctx.count("document WHERE state='active'"), 20);
  baseScanId = base.scanId;

  ctx.clock.advance(1000);

  // --- 「半死の走査」を作る ---
  // マウントが半分死んでおり、20件中2件だけ読めたところで
  // プロセスごと落ちた、という状況を再現する。2件は実際に観測させ、
  // その後 failed に落とす。
  const halfDead = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  await ctx.ingest(halfDead.scanId, "f0.txt", "contents of f0.txt");
  await ctx.ingest(halfDead.scanId, "f1.txt", "contents of f1.txt");

  // `finishScan` を経由しない。パイプライン層が「これ以上は続けられない」と
  // 判断して `failScan` で閉じた状態にする。安全弁は判定されない
  const failed = await ctx.store.failScan(halfDead.scanId, "mount_lost");
  assert.equal(failed.status, "failed", "前提: 半死の走査が failed になっている");
  assert.equal(failed.completionSeq, undefined, "失敗した走査は完了順に並ばない");
}

export async function execute(ctx: FixtureContext): Promise<void> {
  ctx.clock.advance(1000);

  // --- 攻撃: failed の走査の直後に、正規の走査を開始する ---
  const next = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);

  // ここが防御の核心。failed の2件ではなく、その前の completed な20件が
  // 基準として選ばれていること。ここが逆転していたら、以降の計算は
  // すべて「120件を基準にした攻撃」の再現になってしまう
  assert.equal(
    next.previousCompletedScanId,
    baseScanId,
    "基準は最後に completed した走査でなければならない。failed の走査であってはいけない",
  );
  assert.equal(
    next.previousDistinctCount,
    20,
    "基準値は failed 走査の2件ではなく、completed 走査の20件でなければならない",
  );

  // --- この走査は少数（2件）しか観測できなかったとする ---
  await ctx.ingest(next.scanId, "f0.txt", "contents of f0.txt");
  await ctx.ingest(next.scanId, "f1.txt", "contents of f1.txt");

  const finished = await ctx.store.finishScan(next.scanId, {
    enumeratedCount: 2,
    distinctCount: 2,
    writeFailureCount: 0,
  });

  // 正しい基準（20件）に対して 2件は 10% に満たない。弁が発火する。
  // もし failed の2件が基準になっていたら 2/2 = 100% で素通りしていた
  assert.equal(
    finished.status,
    "aborted_safety",
    "正しい基準（20件）に対して弁が発火しなければならない",
  );

  // メッセージ文字列ではなく abort_reason の正準トークンで判定する
  const row = ctx.one<{ abort_reason: string }>(
    "SELECT abort_reason FROM scan_run WHERE scan_id=?",
    next.scanId,
  );
  const reasons = row!.abort_reason.split(",");
  assert.ok(
    reasons.includes("count_ratio"),
    `count_ratio が理由に含まれるはず: ${row!.abort_reason}`,
  );

  // --- 削除判定に進めない。tombstone は1件も書かれていない ---
  assert.equal(await ctx.store.promoteToCompleted(next.scanId), null);
  assert.equal(ctx.count("document WHERE state='tombstoned'"), 0);
  assert.equal(ctx.observationCount("document_tombstoned"), 0);
  assert.equal(ctx.observationCount("scan_aborted_safety"), 1);
}
