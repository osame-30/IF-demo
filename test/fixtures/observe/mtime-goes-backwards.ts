/**
 * 攻撃 #19 — バックアップ復元で報告時刻が過去に戻ったのに、内容は別物だった。
 *
 * 元の穴: 接続元が報告する更新時刻（`SourceEntry.modifiedAt` に相当する
 * `VersionDraft.sourceModifiedAt`）は**参考値**です。バックアップ復元のような
 * 操作では、この値が既存より**古くなる**のに内容は別物ということが起こります。
 * 「報告時刻が古い → 変更なし → hash 取得も version 化もスキップ」と判断すると、
 * その変更は**永久に取り込まれません**。時刻は取り込みを止める理由にならない。
 *
 * 接続元が報告する時刻は参考値であって、判定に使ってはいけません
 * （types.ts の `SourceEntry.modifiedAt` のコメント、絶対ルール7）。
 * 判定に使う時刻の権威はストアの時計だけです。`sourceModifiedAt` は
 * 「判定に使わない証拠値」として version に残すだけの値です。
 *
 * `ctx.ingest` は `sourceModifiedAt` を渡せないので、ここでは
 * `ctx.store.recordObservedDocument` → `insertVersionIfAbsent`（sourceModifiedAt 付き）
 * → `setActiveVersion` を自分で呼んで組み立てます。
 * `ctx.clock` を巻き戻す必要はありません。`sourceModifiedAt` は接続元が報告する
 * 参考値であって、ストアの時計とは無関係だからです（巻き戻したい場合は
 * `ctx.clock.rewindTo` がありますが、ここでは使いません）。
 *
 * `LINEAGE_COMPLETE` は `traceToOrigin`（Artifact が要る）を使わずに、
 * 新旧2つの版が同じ document に属していること・`document_version.document_id` が
 * 正しいこと・原本が消えていないこと（immutable / AGENTS.md 3.1）を生 SQL で確認します。
 */

import assert from "node:assert/strict";

import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import { asEpochMs } from "../../support/clock.ts";
import type {
  ContentHash,
  DocumentId,
  InvariantName,
  ScanId,
  SourceId,
  VersionId,
} from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = ["LINEAGE_COMPLETE"];

const SRC = "backup-restored-share" as SourceId;
/** 弁の分母。18件あれば安全弁に引っかからない */
const ORDINARY = Array.from({ length: 18 }, (_, i) => `f${i}.txt`);
const DOC = "doc.txt";

/** バックアップ復元前の報告時刻。十分に「新しい」値 */
const RECENT_MODIFIED_AT = 2_000_000_000_000;
/** 復元後の報告時刻。既存より過去だが、内容は別物 */
const PAST_MODIFIED_AT = 1_000_000_000_000;

const ORIGINAL_BODY = "content before the backup was restored";
const RESTORED_BODY = "different content, but the reported mtime went backwards";

const PIPELINE_VERSION = "v0.1";

const body = (name: string): string => `contents of ${name}`;

interface SmIngestResult {
  documentId: DocumentId;
  versionId: VersionId;
  contentHash: ContentHash;
  updated: boolean;
}

/**
 * `ctx.ingest` は sourceModifiedAt を渡せない。参照実装の `ingest` の中身
 * （observe → insertVersionIfAbsent → setActiveVersion）を sourceModifiedAt 付きで
 * 自分で組み立てる。
 */
async function ingestWithSourceModifiedAt(
  ctx: FixtureContext,
  scanId: ScanId,
  stableKey: string,
  text: string,
  sourceModifiedAt: number,
): Promise<SmIngestResult> {
  // 実体を先に置く。置かないと HASH_MATCHES_BLOB がこの版で偽になる
  const blob = await ctx.putBlob(text);
  const contentHash = blob.contentHash;
  const sizeBytes = blob.sizeBytes;

  const observed = await ctx.store.recordObservedDocument(scanId, {
    stableKey,
    outcome: { kind: "content", contentHash, sizeBytes },
  });
  const version = await ctx.store.insertVersionIfAbsent({
    documentId: observed.documentId,
    contentHash,
    sizeBytes,
    blobKey: blob.blobKey,
    blobVerifiedAt: blob.blobVerifiedAt,
    mimeType: "text/plain",
    sourceModifiedAt: asEpochMs(sourceModifiedAt),
    discoveredByScanId: scanId,
    pipelineVersion: PIPELINE_VERSION,
  });
  const pointer = await ctx.store.setActiveVersion({
    documentId: observed.documentId,
    observedHash: contentHash,
    versionId: version.versionId,
    scanId,
  });
  return {
    documentId: observed.documentId,
    versionId: version.versionId,
    contentHash,
    updated: pointer.updated,
  };
}

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC);

  const base = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of ORDINARY) await ctx.ingest(base.scanId, name, body(name));
  const original = await ingestWithSourceModifiedAt(
    ctx,
    base.scanId,
    DOC,
    ORIGINAL_BODY,
    RECENT_MODIFIED_AT,
  );
  await ctx.store.finishScan(base.scanId, {
    enumeratedCount: ORDINARY.length + 1,
    distinctCount: ORDINARY.length + 1,
    writeFailureCount: 0,
  });
  assert.ok(original.updated, "初回の観測でポインタが立つ");
  assert.equal(ctx.count("document_version"), ORDINARY.length + 1);
}

export async function execute(ctx: FixtureContext): Promise<void> {
  ctx.clock.advance(1000);

  const documentId = ctx.one<{ document_id: string }>(
    "SELECT document_id FROM document WHERE stable_key=?",
    DOC,
  )!.document_id as DocumentId;
  const originalVersionId = ctx.one<{ active_version_id: string }>(
    "SELECT active_version_id FROM document WHERE document_id=?",
    documentId,
  )!.active_version_id;

  // --- 攻撃: 同じ doc.txt を、内容は別物・報告時刻は過去で観測する ---
  const scan2 = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of ORDINARY) await ctx.ingest(scan2.scanId, name, body(name));
  const restored = await ingestWithSourceModifiedAt(
    ctx,
    scan2.scanId,
    DOC,
    RESTORED_BODY,
    PAST_MODIFIED_AT,
  );
  await ctx.store.finishScan(scan2.scanId, {
    enumeratedCount: ORDINARY.length + 1,
    distinctCount: ORDINARY.length + 1,
    writeFailureCount: 0,
  });

  // --- 核心: 「報告時刻が古いからスキップ」が起きていない ---
  assert.equal(restored.documentId, documentId, "同じ document に属す");
  assert.notEqual(restored.versionId, originalVersionId, "新しい版が作られる");
  assert.ok(restored.updated, "active ポインタが新しい版に動く");

  const activeNow = ctx.one<{ active_version_id: string }>(
    "SELECT active_version_id FROM document WHERE document_id=?",
    documentId,
  )!.active_version_id;
  assert.equal(activeNow, restored.versionId, "ポインタが新しい版を指している");

  // --- version_created が発火している ---
  assert.equal(
    ctx.observationCount("version_created", documentId),
    2,
    "初回の作成と、報告時刻が過去でも新しい版が作られたこと、両方が観測に残る",
  );

  // --- LINEAGE_COMPLETE: 新旧2つの版が同じ document に属し、原本は消えていない ---
  const versions = ctx.rows<{ version_id: string; document_id: string; content_hash: string }>(
    "SELECT version_id, document_id, content_hash FROM document_version WHERE document_id=? ORDER BY ingested_at",
    documentId,
  );
  assert.equal(versions.length, 2, "旧版は immutable。消されずに残っている");
  assert.ok(
    versions.every((v) => v.document_id === documentId),
    "document_version.document_id が正しい",
  );
  const versionIds = versions.map((v) => v.version_id).sort();
  assert.deepEqual(versionIds, [originalVersionId, restored.versionId].sort());

  // sourceModifiedAt は「判定に使わない証拠値」として残るだけ。過去の値のまま記録されている
  const restoredRow = ctx.one<{ source_modified_at: number }>(
    "SELECT source_modified_at FROM document_version WHERE version_id=?",
    restored.versionId,
  )!;
  assert.equal(restoredRow.source_modified_at, PAST_MODIFIED_AT);
}
