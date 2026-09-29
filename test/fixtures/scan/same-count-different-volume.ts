/**
 * 攻撃 #5 — 件数が一致するだけの別ボリュームが差し替わる。
 *
 * 元の穴: 同じ件数の別ボリュームがマウントされた（例: 空の新規ディスクに
 * たまたま同数のファイルが置かれていた、バックアップの取り違え等）。
 * 件数閾値（count_ratio）は通過したまま、旧内容が全件 tombstone され、
 * 新内容が全件新規として取り込まれた。**件数一致は安全の証明にならない。**
 *
 * 防御: 安全弁は件数比（count_ratio）だけでなく欠損率（missing_ratio）も
 * 独立に見る。別ボリュームは「前回見た文書を1件も見ていない」という点で
 * 必ず矛盾する。件数がどれだけ偶然一致していても、旧文書の
 * `last_seen_scan_id` が今回の走査を指さない以上、`missing` はゼロにならない。
 *
 * なぜ2つの閾値が独立に要るのか — count_ratio は「総量」しか見ない。
 * 総量が同じでも中身の集合が完全に入れ替わるケースを、総量だけの検査は
 * 原理的に検出できない。missing_ratio は「前回の集合のうち今回見えなかった
 * 割合」を見るので、総量が一致していても集合が入れ替わっていれば必ず反応する。
 * このシナリオは、count_ratio が沈黙していても missing_ratio が単独で
 * 発火する実地証拠になっている。もし G2（count_ratio）だけの実装だったら、
 * このシナリオは何の痕跡も残さず素通りする。
 */

import assert from "node:assert/strict";

import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import type { InvariantName, SourceId } from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = [
  "SAFETY_ABORT_WRITES_NOTHING",
  "NO_WORK_WITHOUT_CHANGE",
];

const SRC = "vault-kyoto" as SourceId;
const OLD_FILES = ["a.txt", "b.txt", "c.txt"];
const NEW_FILES = ["x.txt", "y.txt", "z.txt"];

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC);
  const scan1 = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of OLD_FILES) await ctx.ingest(scan1.scanId, name, `contents of ${name}`);
  await ctx.store.finishScan(scan1.scanId, {
    enumeratedCount: OLD_FILES.length,
    distinctCount: OLD_FILES.length,
    writeFailureCount: 0,
  });
  assert.equal(ctx.count("document WHERE state='active'"), 3);
}

export async function execute(ctx: FixtureContext): Promise<void> {
  ctx.clock.advance(1000);

  // --- 攻撃: 件数は同じ3件だが、中身は完全に別のボリューム ---
  const scan2 = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of NEW_FILES) await ctx.ingest(scan2.scanId, name, `contents of ${name}`);

  const finished2 = await ctx.store.finishScan(scan2.scanId, {
    enumeratedCount: NEW_FILES.length,
    distinctCount: NEW_FILES.length,
    writeFailureCount: 0,
  });

  // 件数比は 3/3 = 100% で通過するのに、欠損率で弁が発火する
  assert.equal(finished2.status, "aborted_safety", "件数一致だけでは通過してはいけない");

  // メッセージ文字列ではなく abort_reason の正準トークンで判定する
  const row = ctx.one<{ abort_reason: string }>(
    "SELECT abort_reason FROM scan_run WHERE scan_id=?",
    scan2.scanId,
  );
  const reasons = row!.abort_reason.split(",");
  assert.ok(reasons.includes("missing_ratio"), `missing_ratio が理由に含まれるはず: ${row!.abort_reason}`);
  assert.ok(
    !reasons.includes("count_ratio"),
    "件数比は通過しているはず。これが『件数一致は安全の証明にならない』の機械的証拠",
  );

  // --- 削除判定には進めない。旧3件は tombstone されていない ---
  assert.equal(await ctx.store.promoteToCompleted(scan2.scanId), null);
  assert.equal(
    ctx.count(
      "document WHERE source_id=? AND stable_key IN ('a.txt','b.txt','c.txt') AND state='tombstoned'",
      SRC,
    ),
    0,
    "旧ボリュームの文書は消えていない",
  );
  assert.equal(ctx.count("document WHERE state='tombstoned'"), 0);
  assert.equal(ctx.observationCount("document_tombstoned"), 0);
  assert.equal(ctx.observationCount("scan_aborted_safety"), 1);

  // --- NO_WORK_WITHOUT_CHANGE ---
  // finishScan の閾値だけでは「必ず通す」を表現できない。旧3件を今回も
  // 見ていない以上、次に同じ内容で回しても missing_ratio は再現する
  // （承認は1回限りの走査にのみ効き、閾値そのものは変えない — AGENTS.md 3.5）。
  // だから確実に通すには approveScan を使う。
  const scan3 = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);

  // 再実行の直前 → 直後。x/y/z は既に scan2 で observe 済み・同一内容なので、
  // document_version / derivation / artifact に新規行が増えないことを示す
  const before = await ctx.snapshot();
  for (const name of NEW_FILES) await ctx.ingest(scan3.scanId, name, `contents of ${name}`);
  const after = await ctx.snapshot();
  ctx.declareReplay(before, after);

  await ctx.store.approveScan(
    scan3.scanId,
    "same volume re-scan; missing_ratio against old baseline is expected and not a real anomaly",
    OLD_FILES.length,
  );
  const finished3 = await ctx.store.finishScan(scan3.scanId, {
    enumeratedCount: NEW_FILES.length,
    distinctCount: NEW_FILES.length,
    writeFailureCount: 0,
  });
  assert.equal(finished3.status, "completed", "承認済みなので今回は通過する");
}
