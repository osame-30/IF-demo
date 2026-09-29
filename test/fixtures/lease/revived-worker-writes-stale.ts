/**
 * 攻撃 #13 — 失効したリースを持つワーカーが復活して書き込む。
 *
 * 元の穴: ワーカーAが長時間停止（GC の停止、ホストのサスペンド、ネットワーク断）し、
 * その間にリースが失効して回収され、ワーカーBが同じ仕事を引き継いだ。
 * その後Aが**何事もなかったかのように再開し**、自分の結果を書き込んだ。
 * Aは自分が失効したことを知りません。知る手段もありません。
 *
 * 防御: 所有権の検査を**書き込む側ではなく、書き込まれる側で行う**。
 * `heartbeat` / `completeRun` / `commitDerivation` はいずれも
 * 「status が leased」「worker_id が一致」「期限を過ぎていない」の3つを見ます。
 * ワーカーが自分で「まだ生きているはず」と判断する余地がありません。
 *
 * 期限の検査が要るのが要点です。所有者が一致していても、期限を過ぎたリースは
 * 既に他のワーカーのものになりうるからです。reap がまだ走っていないだけで、
 * 「回収されていない = まだ自分のもの」とは言えません。
 *
 * **所有者の一致だけでは足りません。** 同じワーカーが失効後に同じ鍵を取り直すと、
 * 鍵も名乗りも一致したまま世代だけが変わります。区別しているのは `runId` です。
 * workerId はホスト/プロセスの識別子、runId が世代の識別子。この関係が
 * 3経路すべてで成り立っていることを、後半で同一ワーカーについても確かめます。
 *
 * 拒否は**必ず記録します**。`stale_worker_rejected` が残らないと、
 * 「Aの結果が反映されていない」ことに後から誰も気づけません。
 * ただし `commitDerivation` の経路には記録が失われる窓があります
 * （KNOWN_LIMITATIONS.md 9節）。throw する経路はロールバック後の後書きなので、
 * ROLLBACK と観測書き込みの間で落ちると記録だけが消えます。
 */

import assert from "node:assert/strict";

import { isStoreError } from "../../../src/domain/errors.ts";
import { derivationKey as deriveDerivationKey } from "../../../src/domain/ids.ts";
import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import type {
  DerivationDraft,
  InvariantName,
  RunId,
  SourceId,
  VersionId,
  WorkerId,
} from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = ["IDEMPOTENT_REPLAY"];

const SRC = "lease-lab" as SourceId;
const KEY = "input.txt";
/** 停止していて、失効に気づかないまま復活するワーカー */
const REVIVED = "worker-revived" as WorkerId;
/** 仕事を引き継いだワーカー */
const SUCCESSOR = "worker-successor" as WorkerId;
const LEASE_SECONDS = 60;

let rootVersionId: VersionId;
let staleRunId: RunId;

function draft(): DerivationDraft {
  return {
    processorName: "echo",
    processorVersion: "1",
    configHash: "cfg",
    inputIds: [rootVersionId],
  };
}

function materials() {
  return {
    processorName: "echo",
    processorVersion: "1",
    configHash: "cfg",
    inputIds: [rootVersionId],
  };
}

/** ストアが導出するはずの鍵。生 SQL で行を突き合わせるときだけ使う */
function key(): ReturnType<typeof deriveDerivationKey> {
  return deriveDerivationKey(materials());
}

/** 復活したワーカーが試みる操作をひととおり。すべて拒否されること */
async function revivedWorkerAttempts(ctx: FixtureContext): Promise<void> {
  assert.deepEqual(
    await ctx.store.heartbeat(staleRunId, REVIVED),
    { ok: false, reason: "stale_worker" },
    "失効したリースは自己延長できない",
  );

  assert.deepEqual(
    await ctx.store.completeRun({ runId: staleRunId, workerId: REVIVED, status: "succeeded" }),
    { ok: false, reason: "stale_worker" },
    "失効したワーカーは run を閉じられない",
  );

  await assert.rejects(
    () =>
      ctx.store.commitDerivation({
        derivation: draft(),
        artifacts: [],
        runId: staleRunId,
        workerId: REVIVED,
      }),
    (e: unknown) => isStoreError(e, "stale_worker"),
    "失効したワーカーは派生を確定できない（B-3）",
  );
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
  rootVersionId = ingested.versionId;

  // ワーカーがリースを取ってから停止する
  const claimed = await ctx.store.claimRun({
    ...materials(),
    rootVersionId,
    workerId: REVIVED,
    leaseSeconds: LEASE_SECONDS,
  });
  assert.ok(claimed);
  staleRunId = claimed.runId;
}

export async function execute(ctx: FixtureContext): Promise<void> {
  // --- リースが失効し、回収され、後継が引き継ぐ ---
  ctx.clock.advance(LEASE_SECONDS * 1000 + 1);
  assert.equal(await ctx.store.reapAbandonedRuns(), 1, "期限切れのリースは回収される");
  assert.equal(
    ctx.one<{ status: string }>("SELECT status FROM processing_run WHERE run_id=?", staleRunId)!
      .status,
    "abandoned",
  );

  const successor = await ctx.store.claimRun({
    ...materials(),
    rootVersionId,
    workerId: SUCCESSOR,
    leaseSeconds: LEASE_SECONDS,
  });
  assert.ok(successor, "回収されたリースは次のワーカーが取れる");
  assert.equal(successor.attempt, 2, "試行回数は積み上がる。1回目が無かったことにならない");

  // --- 攻撃: 停止していたワーカーが、失効に気づかないまま復活する ---
  await revivedWorkerAttempts(ctx);

  const rejections = ctx.observationDetails("stale_worker_rejected");
  assert.equal(
    rejections.length,
    3,
    "3経路すべてで拒否が記録される。記録が無いと反映されていないことに誰も気づけない",
  );
  for (const detail of rejections) {
    assert.equal(detail["workerId"], REVIVED, "誰が拒まれたかが残る");
  }

  const byOperation = new Map(rejections.map((d) => [String(d["operation"]), d]));

  // 3経路とも「その run はどうなっているか」を答える。世代を特定できるのは
  // runId だけなので、3経路とも runId を受け取り、3経路とも runId で答える
  for (const operation of ["heartbeat", "completeRun", "commitDerivation"]) {
    const detail = byOperation.get(operation);
    assert.ok(detail, `no rejection recorded for ${operation}`);
    assert.equal(detail["runId"], staleRunId, "どの世代が拒まれたか");
    assert.equal(detail["status"], "abandoned", "その run は回収済み");
  }

  // commitDerivation は鍵も突き合わせるので、その分だけ記録が厚い
  const commit = byOperation.get("commitDerivation")!;
  assert.equal(commit["derivationKey"], key(), "derivation から導出された鍵");
  assert.equal(commit["runDerivationKey"], key(), "run が指していた鍵。鍵は一致していた");
  assert.equal(commit["owner"], REVIVED, "名乗りも一致していた。落ちたのは世代の条件");
  assert.equal(commit["mismatch"], "not_leased");

  // 後継のリースは無傷
  assert.equal(
    ctx.one<{ status: string; worker_id: string }>(
      "SELECT status, worker_id FROM processing_run WHERE run_id=?",
      successor.runId,
    )!.worker_id,
    SUCCESSOR,
    "復活したワーカーの操作が後継のリースを壊していない",
  );

  // --- 再実行: 拒否を繰り返しても状態は変わらない ---
  // 観測は追記されるが、種類の集合は増えない（IDEMPOTENT_REPLAY の比較規則）
  const before = await ctx.snapshot();
  await revivedWorkerAttempts(ctx);
  const after = await ctx.snapshot();
  ctx.declareReplay(before, after);

  assert.equal(ctx.count("derivation"), 0, "失効したワーカーの結果は1件も入っていない");
  assert.equal(ctx.count("artifact"), 0);

  // --- 同じワーカーが取り直した場合。ここまでの検査では捕まらない ---
  //
  // ここまでは復活側と後継側が**別のワーカー**だったので、名乗りの一致だけを
  // 見ていても弾けました。同じワーカーが自分の失効に気づかず取り直すと、
  // 鍵も名乗りも一致したまま世代だけが違います。停止と復活を繰り返すワーカーは
  // これを日常的に起こします（同じホストで再起動しただけで workerId は同じ）。
  //
  // 通ってしまうと、古い世代の成果物が確定し、`#succeedRun` が**新しい世代**を
  // 閉じ、`#blockingRun` がその鍵を恒久的に塞ぎます。誤った artifact が正本の
  // まま、その文書は二度と処理できません。
  ctx.clock.advance(LEASE_SECONDS * 1000 + 1);
  assert.equal(await ctx.store.reapAbandonedRuns(), 1, "後継のリースも失効して回収される");

  const retaken = await ctx.store.claimRun({
    ...materials(),
    rootVersionId,
    workerId: SUCCESSOR, // 同じワーカーが取り直す
    leaseSeconds: LEASE_SECONDS,
  });
  assert.ok(retaken);
  assert.notEqual(retaken.runId, successor.runId, "前提: 世代は変わった");

  await assert.rejects(
    () =>
      ctx.store.commitDerivation({
        derivation: draft(),
        artifacts: [],
        runId: successor.runId, // 固まっていた間に終えた、古い世代の仕事
        workerId: SUCCESSOR,
      }),
    (e: unknown) => isStoreError(e, "stale_worker"),
    "鍵も名乗りも一致するが、世代が古い",
  );
  assert.equal(ctx.count("derivation"), 0, "古い世代の成果物が正本になっていない");
  assert.equal(
    ctx.one<{ status: string }>("SELECT status FROM processing_run WHERE run_id=?", retaken.runId)!
      .status,
    "leased",
    "新しい世代が巻き添えで閉じられていない。閉じられるとこの鍵は永久に塞がる",
  );

  const generation = ctx.observationDetails("stale_worker_rejected").at(-1)!;
  assert.equal(generation["mismatch"], "not_leased");
  assert.equal(generation["runId"], successor.runId);
  assert.equal(generation["owner"], SUCCESSOR, "名乗りは一致していた");
  assert.equal(generation["runDerivationKey"], key(), "鍵も一致していた");

  // --- 現世代はふつうに仕事を終えられる ---
  const committed = await ctx.store.commitDerivation({
    derivation: draft(),
    artifacts: [],
    runId: retaken.runId,
    workerId: SUCCESSOR,
  });
  assert.equal(committed.created, true);
  assert.equal(ctx.count("derivation"), 1);
  assert.equal(
    ctx.observationCount("derivation_output_divergence"),
    0,
    "後継の結果が先着として確定する。分岐は起きていない",
  );
}
