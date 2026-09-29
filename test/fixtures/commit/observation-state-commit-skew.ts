/**
 * 攻撃 #26 — 状態と観測が別のトランザクションで書かれ、食い違う。
 *
 * 元の穴は2つあり、向きが逆です。
 *
 *   (a) 状態変更と観測を別トランザクションで書いていた。片方だけが成立し、
 *       「ポインタは動いたのに記録が無い」「記録はあるのに状態が動いていない」
 *       が生まれた。監査ログを信じると事実と食い違う。
 *
 *   (b) `IDEMPOTENT_REPLAY` を「全表の行が一致すること」と読んでいた。
 *       Observation は追記専用なので、再実行すれば**必ず**行が増えます。
 *       この定義だと冪等性のテストは絶対に緑になりません。
 *       落とされ続ける検査は、やがて外されます。
 *
 * (b) への答えが比較規則の明文化です（AGENTS.md 5節 / types.ts の INVARIANTS）。
 *
 *   比較に含める  : document / document_version / derivation / artifact / access_control
 *   比較に**含めない**: observation の行数と observationId
 *   比較に含める  : observation の (kind, documentId) の**集合**
 *
 * 「どの種類の事実が起きたか」は一致しなければならないが、
 * 「何回記録されたか」は一致しなくてよい。この線引きが (b) の答えです。
 *
 * (a) への答えは、状態変更と観測を同じトランザクションで書くことです。
 * ここでは COMMIT の直前で落として、**両方まとめて消える**ことを確かめます。
 * 片方だけが残るなら、そこが食い違いの入口です。
 */

import assert from "node:assert/strict";

import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import { EchoProcessor } from "../../support/echo-processor.ts";
import { isInjectedCrash } from "../../support/crash-injecting-store.ts";
import { diffSnapshots } from "../../support/state-snapshot.ts";
import type {
  DocumentId,
  InvariantName,
  SourceId,
  VersionId,
  WorkerId,
} from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = ["IDEMPOTENT_REPLAY"];

const SRC = "skew-lab" as SourceId;
const KEY = "report.txt";
/** 毎回読めないファイル。観測は増えるが版にはならない（#17 の枝） */
const LOCKED = "locked.txt";
const WORKER = "worker-1" as WorkerId;
const BODY_V1 = "the first revision";
const BODY_V2 = "the second revision";
const PIPELINE_VERSION = "v0.1";

const echo = new EchoProcessor({ artifactCount: 2 });

let documentId: DocumentId;
let v1: VersionId;

const activePointer = (ctx: FixtureContext): string | null =>
  ctx.one<{ active_version_id: string | null }>(
    "SELECT active_version_id FROM document WHERE document_id=?",
    documentId,
  )!.active_version_id;

const observationRows = (ctx: FixtureContext): number => ctx.count("observation");

/**
 * 走査を1本まるごと通す。内容は変えない。
 *
 * `locked.txt` を毎回同梱するのが要点です。読めなかったことは
 * **走査のたびに新しい事実**なので `document_unreadable` が毎回追記されます。
 * 一方この枝は版を作らないので、状態は1ビットも変わりません。
 * 「行は増えるが状態は変わらない」が同時に成立するのはこの形だけで、
 * これが無いと (b) の比較規則は検証できません。
 */
async function idempotentScan(ctx: FixtureContext): Promise<void> {
  const scan = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  await ctx.ingest(scan.scanId, KEY, BODY_V1);
  await ctx.observeOnly(scan.scanId, LOCKED, { kind: "unreadable", errorKind: "EACCES" });
  const finished = await ctx.store.finishScan(scan.scanId, {
    enumeratedCount: 2,
    distinctCount: 2,
    writeFailureCount: 0,
  });
  assert.equal(finished.status, "completed");
}

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC);
  await idempotentScan(ctx);
  documentId = ctx.one<{ document_id: string }>(
    "SELECT document_id FROM document WHERE stable_key=?",
    KEY,
  )!.document_id as DocumentId;
  v1 = activePointer(ctx) as VersionId;
  assert.ok(v1);

  // 派生も1つ作っておく。比較対象の5表すべてに行を持たせるため
  const run = await ctx.store.claimRun({
    ...echo.claimMaterialsFor(v1),
    rootVersionId: v1,
    workerId: WORKER,
    leaseSeconds: 600,
  });
  assert.ok(run);
  await ctx.store.commitDerivation({
    derivation: echo.draftFor({ rootVersionId: v1 }),
    artifacts: echo.run(v1),
    runId: run.runId,
    workerId: WORKER,
  });
  await ctx.store.upsertAcl({
    documentId,
    tenantId: "t1",
    state: "unknown",
    principals: [],
    aclHash: "unknown",
  });
}

export async function execute(ctx: FixtureContext): Promise<void> {
  // --- (a) 状態変更と観測は同じトランザクション。片方だけ残らない ---
  ctx.clock.advance(1000);
  const scan2 = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  // 実体を先に置く。置かないと HASH_MATCHES_BLOB がこの版で偽になる
  const v2Blob = await ctx.putBlob(BODY_V2);
  const v2Hash = v2Blob.contentHash;
  const v2Size = v2Blob.sizeBytes;

  await ctx.store.recordObservedDocument(scan2.scanId, {
    stableKey: KEY,
    outcome: { kind: "content", contentHash: v2Hash, sizeBytes: v2Size },
  });
  const v2 = await ctx.store.insertVersionIfAbsent({
    documentId,
    contentHash: v2Hash,
    sizeBytes: v2Size,
    blobKey: v2Blob.blobKey,
    blobVerifiedAt: v2Blob.blobVerifiedAt,
    mimeType: "text/plain",
    discoveredByScanId: scan2.scanId,
    pipelineVersion: PIPELINE_VERSION,
  });
  // この走査でも locked.txt は読めない。弁の分母を揃えるため先に観測しておく
  await ctx.observeOnly(scan2.scanId, LOCKED, { kind: "unreadable", errorKind: "EACCES" });

  const observationsBefore = observationRows(ctx);
  const crash = ctx.crash({ at: "before_commit" });
  await assert.rejects(
    () =>
      ctx.store.setActiveVersion({
        documentId,
        observedHash: v2Hash,
        versionId: v2.versionId,
        scanId: scan2.scanId,
      }),
    isInjectedCrash,
  );
  assert.equal(crash.fired, 1);
  crash.restore();

  assert.equal(activePointer(ctx), v1, "状態は動いていない");
  assert.equal(
    observationRows(ctx),
    observationsBefore,
    "観測も残っていない。片方だけ残るなら、そこが食い違いの入口",
  );
  assert.equal(
    ctx.observationCount("version_created", documentId),
    1,
    "巻き戻ったのは「ポインタが動いた」という記録そのもの",
  );

  // 再実行すれば両方まとめて成立する
  const moved = await ctx.store.setActiveVersion({
    documentId,
    observedHash: v2Hash,
    versionId: v2.versionId,
    scanId: scan2.scanId,
  });
  assert.deepEqual(moved, { updated: true });
  assert.equal(activePointer(ctx), v2.versionId);
  assert.equal(ctx.observationCount("version_created", documentId), 2, "状態と記録が揃って進む");

  // 元の内容に戻して、以降の再実行を無変更にする
  const finished2 = await ctx.store.finishScan(scan2.scanId, {
    enumeratedCount: 2,
    distinctCount: 2,
    writeFailureCount: 0,
  });
  assert.equal(finished2.status, "completed");
  ctx.clock.advance(1000);
  await idempotentScan(ctx);

  // --- (b) 再実行で observation の行数は増える。それは差分ではない ---
  const before = await ctx.snapshot();
  const rowsBefore = observationRows(ctx);

  ctx.clock.advance(1000);
  await idempotentScan(ctx);

  const after = await ctx.snapshot();
  const rowsAfter = observationRows(ctx);

  ctx.declareReplay(before, after);

  assert.ok(
    rowsAfter > rowsBefore,
    "前提: 追記専用なので行は増える。増えない実装なら、この比較規則の話は始まらない",
  );
  assert.deepEqual(
    diffSnapshots(before, after).observationKindsAdded,
    [],
    "増えたのは行数だけ。(kind, documentId) の集合は変わらない",
  );
  assert.deepEqual(diffSnapshots(before, after).rows, [], "内容を持つ5表は1行も変わらない");
}
