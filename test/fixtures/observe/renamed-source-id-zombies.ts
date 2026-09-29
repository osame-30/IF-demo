/**
 * 攻撃 #24 — sourceId を改名すると、旧 source の文書が誰にも走査されず
 * 永久に active なゾンビとして残る。
 *
 * 元の穴: 運用者が `nas-tokyo` を `nas-tokyo-2` に改名すると、旧 sourceId
 * (`nas-tokyo`) の文書は二度と `beginScan` の対象になりません。
 * 走査されない以上 `findMissingSince` にも引っかからず、**誰も気づかないまま
 * active であり続けます。** SINGLE_ACTIVE_VERSION は「1文書に版が1本」を
 * 守りますが、この攻撃は「もう存在しない source の下で active な文書」という、
 * 型では表現できない種類の孤児を作ります。
 *
 * v0.1 の方針は KNOWN_LIMITATIONS.md 3節の「記録のみ（自動対処しない）」です。
 *   - やること: `findOrphanedSources` で走査対象に含まれない sourceId の
 *     active 文書を検出し、呼び出し側が `orphaned_source_detected` を記録する
 *   - やらないこと: 自動的な統合、自動的な tombstone
 *
 * 自動対処は誤爆すると元に戻せません（本当に一時的に走査対象から外しただけの
 * source を tombstone してしまう事故になりえる）。だから人間の判断待ちにします。
 *
 * `findOrphanedSources` は判定関数です。**1行も書きません。**
 * 「検出しただけで状態が変わる」なら、それは検出ではなく対処です
 * （`lineage-store.ts` のヘッダコメントが明言している規律）。
 * ストアが `orphaned_source_detected` を勝手に記録しないことも、
 * 呼び出し側がその記録を自分の判断で行えることも、両方ここで確認します。
 */

import assert from "node:assert/strict";

import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import { diffSnapshots, isEmptyDiff } from "../../support/state-snapshot.ts";
import type { InvariantName, SourceId } from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = ["SINGLE_ACTIVE_VERSION"];

/** 運用者が nas-tokyo を nas-tokyo-2 に改名した、という想定 */
const SRC_OLD = "nas-tokyo" as SourceId;
const SRC_NEW = "nas-tokyo-2" as SourceId;

/** 弁の分母。各 source ごとに独立して走査を完了させる */
const FILES_OLD = Array.from({ length: 18 }, (_, i) => `old-${i}.txt`);
const FILES_NEW = Array.from({ length: 18 }, (_, i) => `new-${i}.txt`);

const body = (name: string): string => `contents of ${name}`;

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC_OLD);
  ctx.addSource(SRC_NEW);

  // 改名前: nas-tokyo として走査されていた
  const scanOld = await ctx.store.beginScan(SRC_OLD, DEFAULT_THRESHOLDS);
  for (const name of FILES_OLD) await ctx.ingest(scanOld.scanId, name, body(name));
  await ctx.store.finishScan(scanOld.scanId, {
    enumeratedCount: FILES_OLD.length,
    distinctCount: FILES_OLD.length,
    writeFailureCount: 0,
  });

  // 改名後: nas-tokyo-2 として運用が続いている
  ctx.clock.advance(1000);
  const scanNew = await ctx.store.beginScan(SRC_NEW, DEFAULT_THRESHOLDS);
  for (const name of FILES_NEW) await ctx.ingest(scanNew.scanId, name, body(name));
  await ctx.store.finishScan(scanNew.scanId, {
    enumeratedCount: FILES_NEW.length,
    distinctCount: FILES_NEW.length,
    writeFailureCount: 0,
  });

  assert.equal(ctx.count("document WHERE source_id=? AND state='active'", SRC_OLD), FILES_OLD.length);
  assert.equal(ctx.count("document WHERE source_id=? AND state='active'", SRC_NEW), FILES_NEW.length);
}

export async function execute(ctx: FixtureContext): Promise<void> {
  // --- 検出: 走査対象に nas-tokyo-2 だけを渡すと、nas-tokyo が孤児として返る ---
  const orphanedIfOnlyNew = await ctx.store.findOrphanedSources([SRC_NEW]);
  assert.deepEqual(orphanedIfOnlyNew, [SRC_OLD]);

  // --- 両方を走査対象として渡せば、孤児は無い ---
  const orphanedIfBoth = await ctx.store.findOrphanedSources([SRC_OLD, SRC_NEW]);
  assert.deepEqual(orphanedIfBoth, []);

  // --- 検出は1行も書かない。問い合わせただけで状態が変わるなら、それは対処 ---
  const before = await ctx.snapshot();
  await ctx.store.findOrphanedSources([SRC_NEW]);
  const after = await ctx.snapshot();
  assert.ok(isEmptyDiff(diffSnapshots(before, after)), "findOrphanedSources は1行も書かない");

  // --- 旧 source の文書は active のまま残る。自動 tombstone していない ---
  assert.equal(
    ctx.count("document WHERE source_id=? AND state='active'", SRC_OLD),
    FILES_OLD.length,
    "自動対処しない。誤爆は元に戻せないため人間の判断待ちにする",
  );

  // --- ストアは orphaned_source_detected を勝手に記録しない。判定するだけ ---
  assert.equal(
    ctx.observationCount("orphaned_source_detected"),
    0,
    "findOrphanedSources は判定関数。記録するかどうかは呼び出し側の判断",
  );

  // --- 呼び出し側の判断で記録できることを示す。detail は構造化された値のみ ---
  await ctx.store.appendObservation({
    kind: "orphaned_source_detected",
    detail: { sourceId: String(SRC_OLD), knownSourceIds: [String(SRC_NEW)] },
  });
  assert.equal(ctx.observationCount("orphaned_source_detected"), 1);

  // --- ctx.declareKnownSources はここでは呼ばない ---
  //
  // 呼ぶと invariant-checker の SINGLE_ACTIVE_VERSION が knownSourceIds を
  // 使って「走査対象に含まれない active 文書」を違反として報告し、ランナーが落ちる。
  // このフィクスチャ自身が findOrphanedSources を通じて孤児の検出を検証しているので、
  // invariant-checker 側にも同じ孤児を違反として二重に検出させる必要はない。
  // （#24 は「検出のみ」が仕様。invariant-checker に孤児を怒らせるのは、
  //  自動対処を前提にした別の設計を書くフィクスチャの役目であって、これではない）
}
