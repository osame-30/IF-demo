/**
 * 攻撃 #15 — 版は入ったのにポインタが動かず、再実行が「変更なし」と判断する。
 *
 * 元の穴: `insertVersionIfAbsent` の後、`setActiveVersion` の前でクラッシュした。
 * 再実行すると `insertVersionIfAbsent` が `created: false` を返します。
 * 呼び出し側はそれを「変更なし」と読んで打ち切りました。
 * **ポインタは永久に古い版を指したままです。**
 * 版は正しく存在し、行数も整合しているので、どの検査も緑になります。
 * 壊れているのはポインタ1本だけで、検索結果だけが古い内容を返し続けます。
 *
 * 防御: **ポインタの正しさを挿入結果ではなく現在の観測から決める。**
 * `setActiveVersion` は `observedHash` と現 active の hash を比べます。
 * 版が既存（`created: false`）でも、観測した内容と違えばポインタは動きます。
 *
 * だから `created` は「変更なし」の根拠になりません。
 * `created` の値に関わらず `setActiveVersion` を必ず呼ぶ、が呼び出し規約です
 * （`types.ts` の `insertVersionIfAbsent` のコメント）。
 * このフィクスチャは、その規約を守れば壊れた状態から**自力で復帰できる**
 * ことを示します。復帰できなければ、規約は守っても意味がありません。
 */

import assert from "node:assert/strict";

import { artifactId as deriveArtifactId } from "../../../src/domain/ids.ts";
import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import { EchoProcessor } from "../../support/echo-processor.ts";
import type {
  ContentHash,
  DocumentId,
  InvariantName,
  SourceId,
  VersionId,
  WorkerId,
} from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = [
  "POINTER_MATCHES_OBSERVATION",
  "LINEAGE_COMPLETE",
];

const SRC = "pointer-lab" as SourceId;
const KEY = "report.txt";
const WORKER = "worker-1" as WorkerId;
const V1_BODY = "the first revision";
const V2_BODY = "the second revision";
const PIPELINE_VERSION = "v0.1";

const echo = new EchoProcessor({ artifactCount: 2 });

let documentId: DocumentId;
let v1: VersionId;

const activePointer = (ctx: FixtureContext): string | null =>
  ctx.one<{ active_version_id: string | null }>(
    "SELECT active_version_id FROM document WHERE document_id=?",
    documentId,
  )!.active_version_id;

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC);
  const scan = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  const ingested = await ctx.ingest(scan.scanId, KEY, V1_BODY);
  await ctx.store.finishScan(scan.scanId, {
    enumeratedCount: 1,
    distinctCount: 1,
    writeFailureCount: 0,
  });
  documentId = ingested.documentId;
  v1 = ingested.versionId;
  assert.equal(activePointer(ctx), v1);
}

export async function execute(ctx: FixtureContext): Promise<void> {
  ctx.clock.advance(1000);
  // 実体を先に置く。置かないと HASH_MATCHES_BLOB がこの版で偽になる
  const v2Blob = await ctx.putBlob(V2_BODY);
  const v2Hash = v2Blob.contentHash;
  const v2Size = v2Blob.sizeBytes;

  // --- 攻撃: 版を入れた直後、ポインタ更新の前にクラッシュする ---
  const scan2 = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  await ctx.store.recordObservedDocument(scan2.scanId, {
    stableKey: KEY,
    outcome: { kind: "content", contentHash: v2Hash, sizeBytes: v2Size },
  });
  const inserted = await ctx.store.insertVersionIfAbsent({
    documentId,
    contentHash: v2Hash,
    sizeBytes: v2Size,
    blobKey: v2Blob.blobKey,
    blobVerifiedAt: v2Blob.blobVerifiedAt,
    mimeType: "text/plain",
    discoveredByScanId: scan2.scanId,
    pipelineVersion: PIPELINE_VERSION,
  });
  assert.equal(inserted.created, true);
  // ここで落ちた、という想定。setActiveVersion は呼ばれない

  assert.equal(activePointer(ctx), v1, "前提: ポインタは古い版を指したまま");
  assert.equal(ctx.count("document_version WHERE document_id=?", documentId), 2);

  // --- 再実行: created:false が返る。ここで打ち切ると永久に直らない ---
  ctx.clock.advance(1000);
  // 再実行なので put も冪等（created:false）。証拠だけが今の時計で作り直される
  const retryBlob = await ctx.putBlob(V2_BODY);
  const retry = await ctx.store.insertVersionIfAbsent({
    documentId,
    contentHash: v2Hash,
    sizeBytes: v2Size,
    blobKey: retryBlob.blobKey,
    blobVerifiedAt: retryBlob.blobVerifiedAt,
    mimeType: "text/plain",
    discoveredByScanId: scan2.scanId,
    pipelineVersion: PIPELINE_VERSION,
  });
  assert.equal(
    retry.created,
    false,
    "版は既にある。ここを『変更なし』と読むのが #15 の誤り",
  );
  assert.equal(retry.versionId, inserted.versionId, "同じ入力からは同じ versionId が導出される");

  // --- created の値に関わらず setActiveVersion を呼ぶ、が規約 ---
  const moved = await ctx.store.setActiveVersion({
    documentId,
    observedHash: v2Hash,
    versionId: retry.versionId,
    scanId: scan2.scanId,
  });
  assert.deepEqual(
    moved,
    { updated: true },
    "ポインタは挿入結果ではなく、観測した内容と現 active の hash の比較で決まる",
  );
  assert.equal(activePointer(ctx), retry.versionId, "壊れた状態から自力で復帰できる");
  assert.equal(ctx.observationCount("version_created", documentId), 2);

  // --- 変更が無ければ本当に何もしない。過敏になっていないこと ---
  const idle = await ctx.store.setActiveVersion({
    documentId,
    observedHash: v2Hash,
    versionId: retry.versionId,
    scanId: scan2.scanId,
  });
  assert.deepEqual(idle, { updated: false, reason: "already_current" });
  assert.equal(ctx.observationCount("version_created", documentId), 2, "観測が増えていない");

  await ctx.store.finishScan(scan2.scanId, {
    enumeratedCount: 1,
    distinctCount: 1,
    writeFailureCount: 0,
  });

  // --- LINEAGE_COMPLETE: 新しい版から作った派生が原本まで辿れる ---
  const run = await ctx.store.claimRun({
    ...echo.claimMaterialsFor(retry.versionId),
    rootVersionId: retry.versionId,
    workerId: WORKER,
    leaseSeconds: 600,
  });
  assert.ok(run);
  const committed = await ctx.store.commitDerivation({
    derivation: echo.draftFor({ rootVersionId: retry.versionId }),
    artifacts: echo.run(retry.versionId),
    runId: run.runId,
    workerId: WORKER,
  });

  for (let ordinal = 0; ordinal < echo.artifactCount; ordinal += 1) {
    const traced = await ctx.store.traceToOrigin(deriveArtifactId(committed.derivationKey, ordinal));
    assert.equal(traced.version.versionId, retry.versionId, "派生の根は今 active な版");
    assert.equal(traced.document.documentId, documentId);
    assert.equal(traced.version.contentHash, v2Hash as ContentHash);
  }

  // 旧版は消えていない。原本は immutable（AGENTS.md 3.1）
  assert.equal(ctx.count("document_version WHERE version_id=?", v1), 1);
}
