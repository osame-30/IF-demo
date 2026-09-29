/**
 * 攻撃 #2 — 追い越された走査の観測が active ポインタを巻き戻す。
 *
 * 元の穴: 走査Aが版1を観測した後で止まっている間に、走査Bが版2を観測して
 * ポインタを進めた。その後Aの書き込みが遅れて到着し、ポインタが版1に戻った。
 * 版は2つとも残り、`document_version` 表を見ても矛盾は見つかりません。
 * **壊れているのはポインタだけなので、行数を数える検査では永久に見つかりません。**
 *
 * 防御: `setActiveVersion` は走査が running でなければポインタを動かさない。
 * 同一 source で running な走査は高々1件なので（#1）、
 * 「running でない走査からの更新」は「追い越された走査からの更新」と同じ意味になります。
 *
 * ここで検証しているのは「巻き戻らない」ことと、
 * **巻き戻さなかったことが観測にも現れない**ことです。
 * `version_reverted` が書かれてしまうと、後から見て
 * 「戻したのか、戻そうとして拒んだのか」が区別できなくなります。
 */

import assert from "node:assert/strict";

import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import type {
  ContentHash,
  DocumentId,
  InvariantName,
  ScanId,
  SourceId,
  VersionId,
} from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = [
  "POINTER_MATCHES_OBSERVATION",
  "SINGLE_ACTIVE_VERSION",
];

const SRC = "nas-tokyo" as SourceId;
const KEY = "report.txt";

/** 走査Aが観測した内容。攻撃はこの版へポインタを戻そうとする */
let staleDocumentId: DocumentId;
let staleVersionId: VersionId;
let staleHash: ContentHash;
let staleScanId: ScanId;

const activePointer = (ctx: FixtureContext, documentId: DocumentId): string | null =>
  ctx.one<{ active_version_id: string | null }>(
    "SELECT active_version_id FROM document WHERE document_id=?",
    documentId,
  )!.active_version_id;

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC);

  // 走査A: 版1を観測して完了する。ここまでは何も異常がない
  const scanA = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  const v1 = await ctx.ingest(scanA.scanId, KEY, "version one");
  await ctx.store.finishScan(scanA.scanId, {
    enumeratedCount: 1,
    distinctCount: 1,
    writeFailureCount: 0,
  });

  staleDocumentId = v1.documentId;
  staleVersionId = v1.versionId;
  staleHash = v1.contentHash;
  staleScanId = scanA.scanId;

  assert.equal(activePointer(ctx, v1.documentId), v1.versionId);
}

export async function execute(ctx: FixtureContext): Promise<void> {
  ctx.clock.advance(1000);

  // 走査B: 版2を観測してポインタを進める。Aは追い越された
  const scanB = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  const v2 = await ctx.ingest(scanB.scanId, KEY, "version two");
  assert.equal(activePointer(ctx, v2.documentId), v2.versionId);
  assert.notEqual(v2.versionId, staleVersionId, "前提: 別の版になっている");

  // --- 攻撃: 走査Aの書き込みが遅れて到着する ---
  const result = await ctx.store.setActiveVersion({
    documentId: staleDocumentId,
    observedHash: staleHash,
    versionId: staleVersionId,
    scanId: staleScanId,
  });

  // 戻り値で理由が分かること自体が防御の一部。呼び出し側が握りつぶせない
  assert.deepEqual(result, { updated: false, reason: "stale_scan" });
  assert.equal(
    activePointer(ctx, staleDocumentId),
    v2.versionId,
    "ポインタは版2のまま。巻き戻ると検索結果が古い内容に戻る",
  );

  // 拒んだことを「戻した」と読める記録にしない
  assert.equal(
    ctx.observationCount("version_reverted", staleDocumentId),
    0,
    "拒否は version_reverted ではない",
  );
  // 版そのものは2つとも残る。原本は immutable（AGENTS.md 3.1）
  assert.equal(ctx.count("document_version WHERE document_id=?", staleDocumentId), 2);

  // 走査Bを閉じても結論は変わらない
  await ctx.store.finishScan(scanB.scanId, {
    enumeratedCount: 1,
    distinctCount: 1,
    writeFailureCount: 0,
  });
  assert.equal(activePointer(ctx, staleDocumentId), v2.versionId);

  // 最新の版観測とポインタが一致している（POINTER_MATCHES_OBSERVATION の実地確認）
  const latest = ctx.rows<{ version_id: string }>(
    `SELECT version_id FROM observation
      WHERE document_id=? AND kind IN ('version_created','version_reverted')
      ORDER BY observation_seq DESC LIMIT 1`,
    staleDocumentId,
  );
  assert.equal(latest[0]!.version_id, v2.versionId);
}
