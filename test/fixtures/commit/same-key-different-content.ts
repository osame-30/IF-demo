/**
 * 攻撃 #11 — 同じ鍵で違う内容が到着し、先着が黙って正になる。
 *
 * 元の穴: 依存ライブラリの版が違う2台が同じ `derivationKey` を処理した。
 * 鍵の入力（processor 名・版・configHash・入力 ID）はどちらの台でも同じなのに、
 * 出てくるバイト列が違いました。`insertArtifactsIfAbsent` は
 * 「同じ artifactId が既にある」と見て**2つ目を無言でスキップ**しました。
 * 先に着いた台の結果が正になり、**決定性が壊れていることは誰にも見えません。**
 *
 * 防御: `outputsHash` が一致しなければ `DerivationDivergenceError` を投げ、
 * `derivation_output_divergence` を記録する。**無言でスキップしません。**
 * 「存在するから正しい」とは扱いません（AGENTS.md 3.7）。
 *
 * ## この不変条件は、実行後に成立していないのが正しい
 *
 * `DERIVATION_OUTPUT_STABLE` の定義は
 * `derivation_output_divergence_count == 0` です。分岐が実際に起きた以上、
 * **この主張は本当に偽です。** ストアは正しく検出して拒みましたが、
 * 「世界が決定的だった」という主張のほうは成立していません。
 *
 * だからこのフィクスチャは `expectedViolations` で
 * `DERIVATION_OUTPUT_STABLE / divergence_observed` を名指しします。
 * ランナーは「名指しされた違反が**実際に起きたか**」も検査するので、
 * 攻撃が不発に終わればテストは落ちます。緩めではなく追加の要求です。
 *
 * 検出を「起きなかったことにする」――例えば分岐を記録しないようにする――と、
 * この不変条件は緑になります。それがまさに元の穴です。
 */

import assert from "node:assert/strict";

import { isStoreError } from "../../../src/domain/errors.ts";
import { DEFAULT_THRESHOLDS, type Fixture, type FixtureContext } from "../context.ts";
import { EchoProcessor } from "../../support/echo-processor.ts";
import type {
  InvariantName,
  RunId,
  SourceId,
  VersionId,
  WorkerId,
} from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = ["DERIVATION_OUTPUT_STABLE"];

/** 分岐が起きたこと自体が、この不変条件が成立していないという事実 */
export const expectedViolations: Fixture["expectedViolations"] = [
  {
    invariant: "DERIVATION_OUTPUT_STABLE",
    problem: "divergence_observed",
    reason:
      "derivation_output_divergence_count == 0 は世界が決定的だったという主張であり、" +
      "2台が同じ入力から違う出力を出した以上それは偽。ストアは検出して拒んでおり正しい",
  },
];

const SRC = "derivation-lab" as SourceId;
const KEY = "input.txt";
const HOST_A = "worker-on-host-a" as WorkerId;
const HOST_B = "worker-on-host-b" as WorkerId;

/** 台A。依存ライブラリが古い */
const hostA = new EchoProcessor({ artifactCount: 2, contentSalt: "" });
/** 台B。**鍵も件数も同じで、内容だけが違う** */
const hostB = new EchoProcessor({ artifactCount: 2, contentSalt: "libfoo-2.0 " });

let rootVersionId: VersionId;
let runA: RunId;

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

  assert.equal(
    hostA.keyFor(rootVersionId),
    hostB.keyFor(rootVersionId),
    "前提: 2台の derivationKey は同じ。違うのは出てくるバイト列だけ",
  );
  assert.notDeepEqual(
    hostA.run(rootVersionId).map((_, i) => hostA.hashFor(rootVersionId, i)),
    hostB.run(rootVersionId).map((_, i) => hostB.hashFor(rootVersionId, i)),
    "前提: 内容は違う",
  );

  const claimed = await ctx.store.claimRun({
    ...hostA.claimMaterialsFor(rootVersionId),
    rootVersionId,
    workerId: HOST_A,
    leaseSeconds: 600,
  });
  assert.ok(claimed);
  runA = claimed.runId;
}

export async function execute(ctx: FixtureContext): Promise<void> {
  const key = hostA.keyFor(rootVersionId);

  // --- 台Aが先に着く ---
  const first = await ctx.store.commitDerivation({
    derivation: hostA.draftFor({ rootVersionId }),
    artifacts: hostA.run(rootVersionId),
    runId: runA,
    workerId: HOST_A,
  });
  assert.equal(first.created, true);
  const storedHash = ctx.one<{ outputs_hash: string }>(
    "SELECT outputs_hash FROM derivation WHERE derivation_key=?",
    key,
  )!.outputs_hash;

  // --- 別の鍵のリースでは、そもそも近づけない（B の修正） ---
  // 台Bが手持ちのリースを流用して台Aの派生を上書きしにくる経路は塞がっている
  const unrelated = await ctx.store.claimRun({
    // 鍵は直接渡せないので、材料を変えて別の鍵にする。
    // **「無関係な鍵のリース」は、材料が違うリースとしてしか作れなくなりました。**
    // 以前はここに `"an-unrelated-key" as never` を書いていました。
    // どの processor からも出てこない値なので、実運用では起こらない状況です。
    ...hostA.claimMaterialsFor(rootVersionId),
    processorName: "unrelated-processor",
    rootVersionId,
    workerId: HOST_B,
    leaseSeconds: 600,
  });
  assert.ok(unrelated);
  // 「別の鍵である」ことを暗黙にしない。材料を1つ変えたつもりで同じ鍵になっていたら、
  // この節は「鍵が違えば通らない」ではなく「同じ鍵でも通らない」を主張してしまう
  assert.notEqual(
    ctx.one<{ derivation_key: string }>(
      "SELECT derivation_key FROM processing_run WHERE run_id=?",
      unrelated.runId,
    )!.derivation_key,
    key,
    "前提: このリースは別の鍵のもの",
  );
  await assert.rejects(
    () =>
      ctx.store.commitDerivation({
        derivation: hostB.draftFor({ rootVersionId }),
        artifacts: hostB.run(rootVersionId),
        runId: unrelated.runId,
        workerId: HOST_B,
      }),
    (e: unknown) => isStoreError(e, "stale_worker"),
    "生きたリースでも、鍵が違えば commit できない。分岐の検出以前の防御",
  );
  assert.equal(
    ctx.observationDetails("stale_worker_rejected").at(-1)!["mismatch"],
    "key_mismatch",
    "落ちたのは鍵の条件。世代でも名乗りでもない",
  );
  assert.equal(ctx.observationCount("derivation_output_divergence"), 0, "まだ分岐は起きていない");

  // --- 台Bが同じ鍵で、違う内容を持ってくる ---
  //
  // 正規の経路では、成功した派生の鍵は `#blockingRun` が恒久的に塞ぐので
  // 二度と claim できません。分岐に到達するのは **run の記録と derivation が
  // 食い違っている**場合だけです。#11 の前提（2台が同じ系譜 DB を共有し、
  // 片方の run 記録がこの DB に無い / 運用で刈られた / バックアップから復元した）が
  // まさにその状況なので、ここでは run 記録だけを手放して再現します。
  //
  // DELETE ではなく status を落とすのは observation.run_id の FK を壊さないため。
  ctx.conn.db
    .prepare("UPDATE processing_run SET status='abandoned', finished_at=? WHERE derivation_key=?")
    .run(ctx.clock.now(), key);

  const runB = await ctx.store.claimRun({
    ...hostA.claimMaterialsFor(rootVersionId),
    rootVersionId,
    workerId: HOST_B,
    leaseSeconds: 600,
  });
  assert.ok(runB, "run の記録が無ければ鍵は取れる。derivation の側だけが残っている");
  // ここが表題の事象。**同じ鍵**で、次に**違う内容**を持ち込む。
  // 分解後は「同じ鍵」を材料の一致としてしか作れないので、明示して固定する
  assert.equal(
    ctx.one<{ derivation_key: string }>(
      "SELECT derivation_key FROM processing_run WHERE run_id=?",
      runB.runId,
    )!.derivation_key,
    key,
    "前提: 台Bのリースは台Aと同じ鍵。違うのは持ち込む内容だけ",
  );

  await assert.rejects(
    () =>
      ctx.store.commitDerivation({
        derivation: hostB.draftFor({ rootVersionId }),
        artifacts: hostB.run(rootVersionId),
        runId: runB.runId,
        workerId: HOST_B,
      }),
    (e: unknown) => isStoreError(e, "derivation_divergence"),
    "無言でスキップしない。失敗として表面化させる",
  );

  // --- 先着が黙って正になっていない。分岐は記録に残る ---
  const details = ctx.observationDetails("derivation_output_divergence");
  assert.equal(details.length, 1, "分岐は必ず記録される。記録が無いと誰も気づけない");

  const record = details[0]!;
  assert.deepEqual(
    Object.keys(record).sort(),
    [
      "derivationKey",
      "incomingArtifactCount",
      "incomingOutputsHash",
      "storedArtifactCount",
      "storedOutputsHash",
    ],
    "detail は構造化された値だけを持つ。人間可読の文は入れない",
  );
  assert.equal(record["derivationKey"], String(key));
  assert.equal(record["storedOutputsHash"], storedHash);
  assert.equal(record["storedArtifactCount"], 2);
  assert.equal(record["incomingArtifactCount"], 2, "件数は同じ。違うのは内容だけ");
  assert.notEqual(
    record["incomingOutputsHash"],
    storedHash,
    "記録が「何と何が食い違ったか」を両方持っている",
  );

  // --- 状態は台Aのまま。後着が上書きしていない ---
  assert.equal(ctx.count("derivation"), 1);
  assert.equal(ctx.count("artifact WHERE derivation_key=?", key), 2);
  assert.equal(
    ctx.one<{ outputs_hash: string }>(
      "SELECT outputs_hash FROM derivation WHERE derivation_key=?",
      key,
    )!.outputs_hash,
    storedHash,
    "後着が先着を上書きしていない",
  );
  assert.deepEqual(
    ctx
      .rows<{ inline_content: string }>(
        "SELECT inline_content FROM artifact WHERE derivation_key=? ORDER BY ordinal",
        key,
      )
      .map((r) => r.inline_content),
    hostA.run(rootVersionId).map((_, i) => hostA.textFor(rootVersionId, i)),
    "台Bの内容が1件も混ざっていない",
  );

  // --- 台Bの run は成功として閉じられていない ---
  assert.equal(
    ctx.one<{ status: string }>("SELECT status FROM processing_run WHERE run_id=?", runB.runId)!
      .status,
    "leased",
    "分岐したのに『成功した』と記録されていない",
  );

  // --- 同じ内容なら分岐ではない。検出が過敏になっていないこと ---
  // 台Bが持っているリースはこの鍵のものなので、正しい内容を出せば通る
  const idempotent = await ctx.store.commitDerivation({
    derivation: hostA.draftFor({ rootVersionId }),
    artifacts: hostA.run(rootVersionId),
    runId: runB.runId,
    workerId: HOST_B,
  });
  assert.equal(idempotent.created, false, "同じ内容の再 commit は no-op");
  assert.equal(
    ctx.one<{ status: string }>("SELECT status FROM processing_run WHERE run_id=?", runB.runId)!
      .status,
    "succeeded",
    "閉じられたのは、渡した run そのもの",
  );
  assert.equal(
    ctx.observationCount("derivation_output_divergence"),
    1,
    "同じ内容では分岐が増えない",
  );
  assert.equal(ctx.count("artifact WHERE derivation_key=?", key), 2);
}
