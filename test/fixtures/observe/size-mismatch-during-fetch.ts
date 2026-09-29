/**
 * 攻撃 #7 — 取得中にサイズが変わったファイルが、そのまま版になる。
 *
 * 元の穴: 列挙時に報告されたサイズと、実際に読めたバイト数が食い違った
 * （書き込み途中のファイル、ローテーション中のログ）。それでも
 * 「hash は計算できた」ので版が作られ、**切れた内容が正本として確定した**。
 * 後から本物の完全な内容が来ても、hash が違うので別の版として並び、
 * どちらが本物かは誰にも分かりません。
 *
 * 防御: `IngestOutcome` が3つの枝を持つ判別可能ユニオンであること。
 * v0.2 の根本原因6「『観測したが version 化しない』を表す型がない」への答えです。
 *
 *   - `content`       — 版になりうる唯一の枝
 *   - `unreadable`    — 読めなかった（#17）
 *   - `size_mismatch` — サイズが合わなかった（#7, #20）
 *
 * なぜ型で分けることが効くのか — 型が無かった頃、実装者に選べたのは
 * 「不完全な内容で版を作る」か「見えなかったことにする」の二択でした。
 * どちらも壊れています。3つ目の枝があると、**`last_seen` を更新する経路と
 * 非 content を記録する経路が同一になる**ので、
 * 「サイズが合わなかった → 欠損 → tombstone」というコードが書けなくなります。
 *
 * 0 は正当なサイズであって「値なし」ではありません（#20）。
 * `declaredSizeBytes` と `actualSizeBytes` を両方持つのはそのためです。
 */

import assert from "node:assert/strict";

import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import type { InvariantName, ScanId, SourceId } from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = [
  "IDEMPOTENT_REPLAY",
  "NO_WORK_WITHOUT_CHANGE",
];

const SRC = "rotating-logs" as SourceId;
/** 走査の前後で内容が変わらない普通のファイル。弁の分母を作る */
const STABLE = Array.from({ length: 8 }, (_, i) => `f${i}.txt`);
const body = (name: string): string => `contents of ${name}`;

/** 列挙時 100 バイトと報告されたが、読めたのは 40 バイトだった */
const TRUNCATED = { kind: "size_mismatch", declaredSizeBytes: 100, actualSizeBytes: 40 } as const;
/** 読めたバイト数が 0。これは「値なし」ではなく「0 バイト読めた」（#20） */
const VANISHED = { kind: "size_mismatch", declaredSizeBytes: 12, actualSizeBytes: 0 } as const;

/** サイズ不一致の2件を含めて、走査を1本まるごと通す */
async function scanWithMismatches(ctx: FixtureContext): Promise<ScanId> {
  const scan = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of STABLE) await ctx.ingest(scan.scanId, name, body(name));
  await ctx.observeOnly(scan.scanId, "app.log", TRUNCATED);
  await ctx.observeOnly(scan.scanId, "empty-during-fetch.txt", VANISHED);
  const finished = await ctx.store.finishScan(scan.scanId, {
    enumeratedCount: STABLE.length + 2,
    distinctCount: STABLE.length + 2,
    writeFailureCount: 0,
  });
  assert.equal(finished.status, "completed");
  return scan.scanId;
}

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC);

  // 基準走査。app.log は最初は正常に読めていた
  const base = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of STABLE) await ctx.ingest(base.scanId, name, body(name));
  await ctx.ingest(base.scanId, "app.log", "a complete log line\n");
  await ctx.store.finishScan(base.scanId, {
    enumeratedCount: STABLE.length + 1,
    distinctCount: STABLE.length + 1,
    writeFailureCount: 0,
  });
  assert.equal(ctx.count("document_version"), STABLE.length + 1);
}

export async function execute(ctx: FixtureContext): Promise<void> {
  ctx.clock.advance(1000);

  const versionsBefore = ctx.count("document_version");
  const logActive = ctx.one<{ active_version_id: string }>(
    "SELECT active_version_id FROM document WHERE stable_key='app.log'",
  )!.active_version_id;

  // --- 攻撃: ローテーション中の app.log と、取得中に消えた新規ファイル ---
  const scanId = await scanWithMismatches(ctx);

  // 版は1件も増えない。切れた内容が正本になっていない
  assert.equal(ctx.count("document_version"), versionsBefore, "不完全な内容から版を作らない");
  assert.equal(
    ctx.one<{ active_version_id: string }>(
      "SELECT active_version_id FROM document WHERE stable_key='app.log'",
    )!.active_version_id,
    logActive,
    "既存の完全な版が、切れた内容で上書きされていない",
  );

  // 新規ファイルは document としては存在する。版を持たないだけ
  const fresh = ctx.one<{ state: string; active_version_id: string | null }>(
    "SELECT state, active_version_id FROM document WHERE stable_key='empty-during-fetch.txt'",
  )!;
  assert.equal(fresh.state, "active", "観測できた以上、欠損ではない");
  assert.equal(fresh.active_version_id, null, "版になりうるのは content の枝だけ");

  // --- 版にならなかった事実が、そうと分かる形で残っている ---
  const details = ctx.observationDetails("size_mismatch_rejected");
  assert.equal(details.length, 2);
  assert.deepEqual(details[0], { declaredSizeBytes: 100, actualSizeBytes: 40 });
  assert.deepEqual(
    details[1],
    { declaredSizeBytes: 12, actualSizeBytes: 0 },
    "0 は正当なサイズ。値なしと区別する（#20）",
  );

  // --- 「サイズが合わない」は「見えなかった」ではない ---
  const promoted = await ctx.store.promoteToCompleted(scanId);
  assert.ok(promoted, "サイズ不一致があっても走査そのものは正常に完了する");

  const missing: string[] = [];
  for await (const doc of ctx.store.findMissingSince(promoted)) missing.push(doc.stableKey);
  assert.deepEqual(missing, [], "last_seen が進んでいるので欠損に見えない");
  assert.equal(ctx.observationCount("document_tombstoned"), 0);

  // --- 再実行しても何も増えない ---
  // 同じ不一致がもう一度観測されても、内容表には1行も書かれない
  ctx.clock.advance(1000);
  await scanWithMismatches(ctx);
  const before = await ctx.snapshot();

  ctx.clock.advance(1000);
  await scanWithMismatches(ctx);
  const after = await ctx.snapshot();

  ctx.declareReplay(before, after);
  assert.equal(ctx.count("document_version"), versionsBefore);
}
