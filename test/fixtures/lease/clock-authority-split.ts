/**
 * 攻撃 #14 — 時刻の権威が分裂する。
 *
 * 元の穴: `heartbeatAt` はワーカーの時計、`reapAbandonedRuns` は呼び出し側の時計、
 * そこに ISO 文字列のタイムゾーン表記の混在が加わり、辞書順比較が破綻した。
 * 結果:
 *   - 時計が**遅い**ワーカーは、生きたままリースを奪われる
 *   - 時計が**進んだ**ワーカーは、クラッシュ後も永久に leased のまま残る
 *
 * どちらも「誰の時計が正しいか」を決めていないことから来ています。
 * 分散システムで時計を合わせるのは不可能なので、**合わせるのではなく
 * 参照する時計を1つに減らします。**
 *
 * 防御は規約ではなく型です。`heartbeat` / `completeRun` / `reapAbandonedRuns` に
 * 時刻の引数が**存在しません**。ワーカーは時刻を送れず、送らないので
 * ワーカーの時計は判定に影響しません。
 *
 * 規約にすると `heartbeat(runId, workerId, now)` がレビューをすり抜けた瞬間に
 * 攻撃が復活します。だから下の `@ts-expect-error` は消さないでください。
 * これは実行時テストより強い保証です。空振りすると `tsc --noEmit` が
 * 「Unused '@ts-expect-error' directive」で落ちるので、緑であること自体が検証です。
 *
 * リポジトリ全体としては AC-CLK-01（`LineageStore` の全メソッドを AST で走査し、
 * `EpochMs` に到達する経路が許可リストと完全一致するか）と
 * AC-CLK-02（`src/store/**` と `src/domain/**` に `Date.now()` / `new Date()` が
 * 現れないか）が同じことを網羅的に見ています。ここはリース経路の実地確認です。
 */

import assert from "node:assert/strict";

import { derivationKey as deriveDerivationKey } from "../../../src/domain/ids.ts";
import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import { TestClock } from "../../support/clock.ts";
import { diffSnapshots, isEmptyDiff } from "../../support/state-snapshot.ts";
import type {
  DocumentId,
  EpochMs,
  InvariantName,
  LineageStore,
  RunId,
  SourceId,
  VersionId,
  WorkerId,
} from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = ["IDEMPOTENT_REPLAY"];

// --- 型テスト（モジュールのトップレベル。実行時には何もしない） ---

const _noHeartbeatTime = (s: LineageStore, r: RunId, w: WorkerId, now: EpochMs) =>
  // @ts-expect-error heartbeat に時刻を渡す口は無い（#14 / AGENTS.md 3.8）
  s.heartbeat(r, w, now);

const _noCompleteTime = (s: LineageStore, r: RunId, w: WorkerId, now: EpochMs) =>
  // @ts-expect-error completeRun に時刻を渡す口は無い
  s.completeRun({ runId: r, workerId: w, status: "succeeded", finishedAt: now });

// @ts-expect-error reapAbandonedRuns は引数を1つも取らない
const _noReapTime = (s: LineageStore, now: EpochMs) => s.reapAbandonedRuns(now);

const SRC = "lease-lab" as SourceId;
const KEY = "input.txt";
const WORKER = "worker-with-a-bad-clock" as WorkerId;
const LEASE_SECONDS = 60;

let documentId: DocumentId;
let rootVersionId: VersionId;

function materials(suffix: string) {
  return {
    processorName: "echo",
    processorVersion: suffix,
    configHash: "cfg",
    inputIds: [rootVersionId],
  };
}

/** ストアが導出するはずの鍵。生 SQL で行を突き合わせるときだけ使う */
function key(suffix: string): ReturnType<typeof deriveDerivationKey> {
  return deriveDerivationKey(materials(suffix));
}

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC);
  const scan = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  const ingested = await ctx.ingest(scan.scanId, KEY, "the only input");
  await ctx.store.finishScan(scan.scanId, {
    enumeratedCount: 1,
    distinctCount: 1,
    writeFailureCount: 0,
  });
  documentId = ingested.documentId;
  rootVersionId = ingested.versionId;
}

export async function execute(ctx: FixtureContext): Promise<void> {
  const startedAt = ctx.clock.now();

  // ワーカーの時計。**ストアはこれを一度も読みません。**
  // 読ませる口が型に無いので、どれだけ狂っていても判定に影響しません
  const workerClock = new TestClock(startedAt + 10 * 60 * 60 * 1000);
  assert.ok(workerClock.now() > startedAt, "前提: ワーカーの時計は10時間進んでいる");

  const run = await ctx.store.claimRun({
    ...materials("1"),
    rootVersionId,
    workerId: WORKER,
    leaseSeconds: LEASE_SECONDS,
  });
  assert.ok(run);

  // 失効時刻はストアの時計から決まる。leaseSeconds は「期間」であって「時刻」ではない
  assert.equal(
    ctx.one<{ lease_expires_at: number }>(
      "SELECT lease_expires_at FROM processing_run WHERE run_id=?",
      run.runId,
    )!.lease_expires_at,
    startedAt + LEASE_SECONDS * 1000,
    "ワーカーの時計（10時間先）ではなく、ストアの時計 + 期間で決まる",
  );

  // --- 時計が進んだワーカーがいても、回収はストアの時計に従う ---
  assert.equal(
    await ctx.store.reapAbandonedRuns(),
    0,
    "ワーカーの時計では失効済みでも、ストアの時計ではまだ生きている",
  );
  assert.deepEqual(await ctx.store.heartbeat(run.runId, WORKER), { ok: true });

  // 延長幅も claim 時に決まった lease_seconds から決まる。呼び出し側は渡せない
  assert.equal(
    ctx.one<{ lease_expires_at: number }>(
      "SELECT lease_expires_at FROM processing_run WHERE run_id=?",
      run.runId,
    )!.lease_expires_at,
    ctx.clock.now() + LEASE_SECONDS * 1000,
    "失効寸前のワーカーが自分で寿命を伸ばせないよう、期間は claim 時に固定される",
  );

  // --- ストアの時計が進めば、同じ呼び出しが回収する ---
  ctx.clock.advance(LEASE_SECONDS * 1000 + 1);
  assert.equal(await ctx.store.reapAbandonedRuns(), 1);
  assert.deepEqual(
    await ctx.store.heartbeat(run.runId, WORKER),
    { ok: false, reason: "stale_worker" },
    "回収された後は、所有者が正しくても延長できない",
  );

  // --- ストアの時計を巻き戻しても、判定はその時計だけを見る ---
  // 時計が1つしか無いということは、狂っていても矛盾はしないということ。
  // 2つあると「どちらから見ても正しくない状態」が作れてしまう
  ctx.clock.rewindTo(startedAt);
  const afterRewind = await ctx.store.claimRun({
    ...materials("2"),
    rootVersionId,
    workerId: WORKER,
    leaseSeconds: LEASE_SECONDS,
  });
  assert.ok(afterRewind, "巻き戻した後も、新しいリースは取れる");
  assert.equal(
    await ctx.store.reapAbandonedRuns(),
    0,
    "巻き戻した時計から見て、このリースはまだ失効していない",
  );

  // --- 再実行: 何も期限切れでないときの回収は、状態を1ビットも変えない ---
  const before = await ctx.snapshot();
  assert.equal(await ctx.store.reapAbandonedRuns(), 0);
  assert.equal(await ctx.store.reapAbandonedRuns(), 0);
  const after = await ctx.snapshot();
  assert.ok(isEmptyDiff(diffSnapshots(before, after)));
  ctx.declareReplay(before, after);

  assert.equal(ctx.count("derivation"), 0, "リースの操作だけでは派生は生まれない");
}
