/**
 * 攻撃 #9 — Derivation だけ書けて Artifact が書けなかったのに、「処理済み」になる。
 *
 * 元の穴: `insertDerivationIfAbsent` で Derivation を先に書き、
 * その後 Artifact を書く2段構えだった。間でクラッシュすると Derivation 行だけが残る。
 * 再実行すると `insertDerivationIfAbsent` が `created: false` を返し、
 * 呼び出し側は「もう済んでいる」と判断して Artifact を書きません。
 * **Artifact は永久に書かれず、しかも系は正常に見えます。**
 *
 * これが「行が存在する」を完了の証拠にした結果です（AGENTS.md 3.7）。
 * Derivation 行の存在は、その派生が完了したことを何も意味していませんでした。
 *
 * 防御は3つ重なっています。
 *
 *   1. `commitDerivation` が Derivation・全 Artifact・run 完了を
 *      **同一トランザクション**で書く。部分成立はあり得ない。
 *   2. `artifactCount` と `outputsHash` を Derivation 行が持つ。
 *      完了の証拠が「行があること」ではなく「宣言と実体が一致すること」になる。
 *   3. その2つを**ストアが導出する**。呼び出し側は渡せない。
 *      渡せると「宣言した個数」と「実際の個数」が食い違う余地が残り、
 *      それはまさにこの穴そのものです。
 *
 * 3が要点です。1だけでは、呼び出し側が嘘の個数を宣言できます。
 * 2だけでは、その個数を誰が決めたのかが分かりません。
 */

import assert from "node:assert/strict";

import { artifactId as deriveArtifactId } from "../../../src/domain/ids.ts";
import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import { EchoProcessor, expectedOutputsHash } from "../../support/echo-processor.ts";
import { isInjectedCrash } from "../../support/crash-injecting-store.ts";
import { isStoreError } from "../../../src/domain/errors.ts";
import type {
  DocumentId,
  InvariantName,
  RunId,
  SourceId,
  VersionId,
  WorkerId,
} from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = ["NO_ORPHAN_ARTIFACT", "LINEAGE_COMPLETE"];

const SRC = "derivation-lab" as SourceId;
const KEY = "input.txt";
const WORKER = "worker-1" as WorkerId;
const ARTIFACT_COUNT = 4;

const echo = new EchoProcessor({ artifactCount: ARTIFACT_COUNT });

let documentId: DocumentId;
let rootVersionId: VersionId;

/** 新しいリースを取る。クラッシュ後の再実行はリースを取り直さない（run は leased のまま） */
async function claim(ctx: FixtureContext): Promise<RunId> {
  const run = await ctx.store.claimRun({
    ...echo.claimMaterialsFor(rootVersionId),
    rootVersionId,
    workerId: WORKER,
    leaseSeconds: 600,
  });
  assert.ok(run);
  return run.runId;
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
  const runId = await claim(ctx);
  const draft = echo.draftFor({ rootVersionId });
  const artifacts = echo.run(rootVersionId);
  assert.equal(artifacts.length, ARTIFACT_COUNT);

  // --- 攻撃1: Derivation は書けたが、Artifact の途中で落ちる ---
  // 元の実装ならここで Derivation 行だけが残っていた
  const midway = ctx.crash({
    at: "before_statement",
    matching: "INSERT INTO artifact",
    occurrence: 3,
  });
  await assert.rejects(
    () => ctx.store.commitDerivation({ derivation: draft, artifacts, runId, workerId: WORKER }),
    isInjectedCrash,
  );
  assert.equal(midway.reached, 3, "2件は実際に書かれた後で落ちている");
  midway.restore();

  assert.equal(ctx.count("derivation"), 0, "Derivation 行だけが残らない");
  assert.equal(ctx.count("artifact"), 0, "途中まで書いた Artifact も残らない");

  // --- 攻撃2: 全部書けた後、COMMIT の直前で落ちる ---
  const atCommit = ctx.crash({ at: "before_commit" });
  await assert.rejects(
    () => ctx.store.commitDerivation({ derivation: draft, artifacts, runId, workerId: WORKER }),
    isInjectedCrash,
  );
  assert.equal(atCommit.fired, 1);
  atCommit.restore();

  assert.equal(ctx.count("derivation"), 0);
  assert.equal(ctx.count("artifact"), 0);
  assert.equal(
    ctx.one<{ status: string }>("SELECT status FROM processing_run WHERE run_id=?", runId)!.status,
    "leased",
    "run も完了していない。中断は『やり直せる状態』として残る",
  );

  // --- 再実行すれば通る。「Derivation 行があるから処理済み」と誤読する余地がない ---
  const committed = await ctx.store.commitDerivation({
    derivation: draft,
    artifacts,
    runId,
    workerId: WORKER,
  });
  assert.equal(committed.created, true);
  assert.equal(committed.derivationKey, echo.keyFor(rootVersionId));

  // --- 宣言した個数と実体が一致している（#9 の署名はここに出る） ---
  const stored = ctx.one<{ artifact_count: number; outputs_hash: string }>(
    "SELECT artifact_count, outputs_hash FROM derivation WHERE derivation_key=?",
    committed.derivationKey,
  )!;
  assert.equal(stored.artifact_count, ARTIFACT_COUNT);
  assert.equal(ctx.count("artifact WHERE derivation_key=?", committed.derivationKey), ARTIFACT_COUNT);

  // outputsHash はストア実装を import せず独立に再計算して突き合わせる
  assert.equal(
    stored.outputs_hash,
    expectedOutputsHash(
      // inline の hash はストアが本文から導出する。ここでは**独立に**計算して
      // 突き合わせる（draft はもう hash を持っていない）
      artifacts.map((a) => ({
        artifactId: deriveArtifactId(committed.derivationKey, a.ordinal),
        contentHash: echo.hashFor(rootVersionId, a.ordinal),
      })),
    ),
  );

  // --- 全 Artifact から原本へ到達できる（LINEAGE_COMPLETE の実地確認） ---
  for (let ordinal = 0; ordinal < ARTIFACT_COUNT; ordinal += 1) {
    const traced = await ctx.store.traceToOrigin(deriveArtifactId(committed.derivationKey, ordinal));
    assert.equal(traced.artifact.ordinal, ordinal);
    assert.equal(traced.derivation.derivationKey, committed.derivationKey);
    assert.equal(traced.version.versionId, rootVersionId);
    assert.equal(traced.document.documentId, documentId);
    assert.equal(traced.document.stableKey, KEY);
  }

  // --- 終わった仕事はもう一度できない ---
  // 成功した run は閉じられ、その鍵は `#blockingRun` が塞ぐ。
  // 「終わったことを知らずに再実行する」経路が構造的に無い
  assert.equal(
    ctx.one<{ status: string }>("SELECT status FROM processing_run WHERE run_id=?", runId)!.status,
    "succeeded",
  );
  assert.equal(
    await ctx.store.claimRun({
      ...echo.claimMaterialsFor(rootVersionId),
      rootVersionId,
      workerId: WORKER,
      leaseSeconds: 600,
    }),
    null,
    "成功済みの派生は取り直せない",
  );
  await assert.rejects(
    () => ctx.store.commitDerivation({ derivation: draft, artifacts, runId, workerId: WORKER }),
    (e: unknown) => isStoreError(e, "stale_worker"),
    "閉じた run では commit できない。リースを持たない書き込みは通らない（#13）",
  );

  assert.equal(ctx.count("artifact"), ARTIFACT_COUNT, "Artifact が二重に増えていない");
  assert.equal(ctx.count("derivation"), 1);
  assert.equal(ctx.observationCount("derivation_output_divergence"), 0);
}
