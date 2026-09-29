/**
 * 攻撃 #27 — 重複列挙が基準値を膨らませ、次の正常な走査を誤停止させる。
 *
 * 元の穴: bind マウントで同じ `stableKey` が2回列挙され、件数が2倍になった。
 * その膨らんだ件数が次回の基準値になり、重複が解消された正常な走査が
 * 「前回比50%」で誤停止した。逆に、重複が消えるのと同時に本物の欠損が起きると、
 * 2つが相殺されて弁が沈黙した。**同じ1つの数字が、両方向に嘘をつきます。**
 *
 * 防御: 安全弁は `distinctCount`（重複除去後）だけを見る。
 * `enumeratedCount` は記録するが判定には使わない。
 *
 * なぜ「両方見る」ではなく「片方だけ見る」が正しいのか — 判定に使う数字が
 * 2つあると、どちらが基準だったかが後から復元できません。重複は接続元側の
 * 事情であって、文書の集合が変わったことを意味しません。
 * 弁が守ろうとしているのは「文書が消えていないか」なので、
 * 見るべき数字は最初から1つに決まっています。
 *
 * `enumeratedCount` を捨てないのは、重複が起きていた事実そのものを
 * 後から追えるようにするためです（判定には使いません）。
 */

import assert from "node:assert/strict";

import { isStoreError } from "../../../src/domain/errors.ts";
import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import { isEmptyDiff, diffSnapshots } from "../../support/state-snapshot.ts";
import type { InvariantName, SourceId } from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = ["SAFETY_ABORT_WRITES_NOTHING"];

const SRC = "bind-mounted-nas" as SourceId;
const FILES = ["a.txt", "b.txt", "c.txt"];
const body = (name: string): string => `contents of ${name}`;

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC);

  // bind マウントで同じ3件が2回ずつ列挙された走査。
  // 観測は重複除去後の3件に畳まれるが、列挙数は6件として記録される
  const scan1 = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of FILES) await ctx.ingest(scan1.scanId, name, body(name));
  const finished = await ctx.store.finishScan(scan1.scanId, {
    enumeratedCount: 6,
    distinctCount: 3,
    writeFailureCount: 0,
  });

  assert.equal(finished.status, "completed");
  assert.equal(ctx.count("document"), 3, "同じ鍵は同じ document に畳まれる");
  assert.equal(finished.enumeratedCount, 6, "列挙数は事実として残る");
}

export async function execute(ctx: FixtureContext): Promise<void> {
  ctx.clock.advance(1000);

  // --- 基準値として採られるのは distinct のほう ---
  const scan2 = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  assert.equal(
    scan2.previousDistinctCount,
    3,
    "基準は重複除去後の3件。6件が基準になると以降の計算が丸ごと攻撃の再現になる",
  );

  // --- 重複が解消された正常な走査は通過する ---
  // もし弁が enumeratedCount を見ていたら 3/6 = 50% で誤停止していた
  for (const name of FILES) await ctx.ingest(scan2.scanId, name, body(name));
  const finished2 = await ctx.store.finishScan(scan2.scanId, {
    enumeratedCount: 3,
    distinctCount: 3,
    writeFailureCount: 0,
  });

  assert.equal(finished2.status, "completed", "重複の解消は異常ではない");
  assert.equal(ctx.observationCount("scan_aborted_safety"), 0);
  assert.equal(ctx.count("document WHERE state='tombstoned'"), 0);
  assert.ok(await ctx.store.promoteToCompleted(scan2.scanId), "削除判定に進める");

  // --- 「重複を無視する」が「何も検出しない」になっていないこと ---
  ctx.clock.advance(1000);
  const scan3 = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  await ctx.ingest(scan3.scanId, "a.txt", body("a.txt"));
  const finished3 = await ctx.store.finishScan(scan3.scanId, {
    enumeratedCount: 1,
    distinctCount: 1,
    writeFailureCount: 0,
  });

  assert.equal(finished3.status, "aborted_safety", "本物の欠損は今も捕まる");
  const reasons = ctx
    .one<{ abort_reason: string }>("SELECT abort_reason FROM scan_run WHERE scan_id=?", scan3.scanId)!
    .abort_reason.split(",");
  assert.ok(reasons.includes("count_ratio"), `count_ratio が理由に含まれるはず: ${reasons.join()}`);
  assert.equal(ctx.observationCount("scan_aborted_safety"), 1);
  assert.equal(ctx.count("document WHERE state='tombstoned'"), 0);

  // --- distinct が enumerated を超える件数は構造的に拒む ---
  // 重複除去後の件数が総件数を超えることはあり得ない。
  // ここを通すと、弁に渡る数字が「あり得ない状態」から作られる
  ctx.clock.advance(1000);
  const scan4 = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  const before = await ctx.snapshot();
  const scansBefore = ctx.count("scan_run");

  await assert.rejects(
    () =>
      ctx.store.finishScan(scan4.scanId, {
        enumeratedCount: 1,
        distinctCount: 2,
        writeFailureCount: 0,
      }),
    (e: unknown) => isStoreError(e, "invalid_counts"),
  );

  assert.ok(
    isEmptyDiff(diffSnapshots(before, await ctx.snapshot())),
    "拒否時に1行も書かない",
  );
  assert.equal(ctx.count("scan_run"), scansBefore);
  assert.equal(
    ctx.one<{ status: string }>("SELECT status FROM scan_run WHERE scan_id=?", scan4.scanId)!.status,
    "running",
    "拒まれた走査は running のまま。誤った件数で完了していない",
  );
}
