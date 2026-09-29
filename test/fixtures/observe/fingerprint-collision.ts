/**
 * 攻撃 #18 — 同じ弱い指紋のまま、内容だけがすり替わる。
 *
 * 元の穴: `cp -p` や `rsync -t` は mtime と size を保ったまま内容を変えます。
 * 弱い指紋（fingerprint = etag / revisionId / mtime+size など）が一致しても
 * 内容が同じとは限りません。「同 fingerprint ならスキップ」と実装すると、
 * この経路で書き換えられた内容が**永久に取り込まれません**。
 *
 * v0.1 の方針は KNOWN_LIMITATIONS.md 4節の「検出のみ」です。
 *   - やること: 同 fingerprint で別 hash が観測されたら `fingerprint_collision` を記録する
 *   - やらないこと: 自動対処（自動再取り込み、quarantine、tombstone）。
 *     定期的な全 hash 再検証バッチも作らない。
 *
 * v0.1 のローカルFS アダプタは常に hash を取ります。fingerprint による
 * skip 判断そのものを実装しません。だからこのフィクスチャは
 * `recordObservedDocument` が fingerprint 衝突を**記録するだけ**で、
 * version にも quarantine にも一切手を出していないことを確認します。
 *
 * `ctx.ingest` は fingerprint を渡せないので、ここでは
 * `ctx.observeOnly`（quickFingerprint 付き）→ `ctx.store.insertVersionIfAbsent`
 * → `ctx.store.setActiveVersion` を自分で組み立てます
 * （参照実装 `context.ts` の `ingest` の中身と同じ形）。
 *
 * 併せて `NO_VERSION_WITHOUT_VERIFIED_BLOB` も確認します。
 * 衝突を検出した後、仮に新しい内容を版にしようとしても、
 * `blobVerifiedAt` の無い version 行は `insertVersionIfAbsent` が
 * `isStoreError(e, "invalid_argument")` で拒みます。拒否時に1行も
 * 書かれていないことを `ctx.snapshot()` の差分（`diffSnapshots` / `isEmptyDiff`）
 * で確認します。
 */

import assert from "node:assert/strict";

import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import { asEpochMs } from "../../support/clock.ts";
import { diffSnapshots, isEmptyDiff } from "../../support/state-snapshot.ts";
import { isStoreError } from "../../../src/domain/errors.ts";
import type {
  ContentHash,
  DocumentId,
  InvariantName,
  ScanId,
  SourceId,
  VersionId,
} from "../../../src/domain/types.ts";
import { blobKeyOf } from "../../../src/domain/ids.ts";
import { __unsafeAttestedAt } from "../../support/unsafe-evidence.ts";

export const assertions: ReadonlyArray<InvariantName> = ["NO_VERSION_WITHOUT_VERIFIED_BLOB"];

const SRC = "fingerprint-farm" as SourceId;
/** 弁の分母。18件あれば安全弁に引っかからない */
const ORDINARY = Array.from({ length: 18 }, (_, i) => `f${i}.txt`);
const REPORT = "report.txt";
/** cp -p / rsync -t が保ってしまう弱い指紋。mtime と size は変わらない */
const FINGERPRINT = "mtime:100,size:20";

const ORIGINAL_BODY = "original report contents";
const CHANGED_BODY = "changed report contents, same fingerprint as before";

const PIPELINE_VERSION = "v0.1";

const body = (name: string): string => `contents of ${name}`;

interface FpIngestResult {
  documentId: DocumentId;
  versionId: VersionId;
  contentHash: ContentHash;
}

/**
 * `ctx.ingest` は quickFingerprint を渡せない。ここでは参照実装の
 * `ingest` の中身（observe → insertVersionIfAbsent → setActiveVersion）を
 * fingerprint 付きで自分で組み立てる。
 */
async function ingestWithFingerprint(
  ctx: FixtureContext,
  scanId: ScanId,
  stableKey: string,
  text: string,
  quickFingerprint: string,
): Promise<FpIngestResult> {
  // 実体を先に置く。置かないと HASH_MATCHES_BLOB がこの版で偽になる
  const blob = await ctx.putBlob(text);
  const contentHash = blob.contentHash;
  const sizeBytes = blob.sizeBytes;

  const documentId = await ctx.observeOnly(
    scanId,
    stableKey,
    { kind: "content", contentHash, sizeBytes },
    quickFingerprint,
  );
  const version = await ctx.store.insertVersionIfAbsent({
    documentId,
    contentHash,
    sizeBytes,
    blobKey: blob.blobKey,
    blobVerifiedAt: blob.blobVerifiedAt,
    mimeType: "text/plain",
    discoveredByScanId: scanId,
    pipelineVersion: PIPELINE_VERSION,
  });
  await ctx.store.setActiveVersion({
    documentId,
    observedHash: contentHash,
    versionId: version.versionId,
    scanId,
  });
  return { documentId, versionId: version.versionId, contentHash };
}

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC);

  const base = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of ORDINARY) await ctx.ingest(base.scanId, name, body(name));
  const original = await ingestWithFingerprint(ctx, base.scanId, REPORT, ORIGINAL_BODY, FINGERPRINT);
  await ctx.store.finishScan(base.scanId, {
    enumeratedCount: ORDINARY.length + 1,
    distinctCount: ORDINARY.length + 1,
    writeFailureCount: 0,
  });
  assert.equal(ctx.count("document_version"), ORDINARY.length + 1);

  // setup 内で作った参照は execute から使えないので、DB に確定していることだけ確認する
  const stored = ctx.one<{ active_version_id: string }>(
    "SELECT active_version_id FROM document WHERE document_id=?",
    original.documentId,
  );
  assert.equal(stored?.active_version_id, original.versionId);
}

export async function execute(ctx: FixtureContext): Promise<void> {
  ctx.clock.advance(1000);

  const before1 = ctx.one<{ active_version_id: string }>(
    "SELECT active_version_id FROM document WHERE stable_key=?",
    REPORT,
  )!;
  const originalVersionId = before1.active_version_id;
  const originalHash = ctx.one<{ content_hash: string }>(
    "SELECT content_hash FROM document_version WHERE version_id=?",
    originalVersionId,
  )!.content_hash;
  const documentId = ctx.one<{ document_id: string }>(
    "SELECT document_id FROM document WHERE stable_key=?",
    REPORT,
  )!.document_id as DocumentId;

  // --- 攻撃: 同じ fingerprint のまま、別内容が観測される ---
  const scan2 = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of ORDINARY) await ctx.ingest(scan2.scanId, name, body(name));

  const changedHash = ctx.hashOf(CHANGED_BODY);
  const observedDocId = await ctx.observeOnly(
    scan2.scanId,
    REPORT,
    { kind: "content", contentHash: changedHash, sizeBytes: Buffer.byteLength(CHANGED_BODY, "utf8") },
    FINGERPRINT,
  );
  await ctx.store.finishScan(scan2.scanId, {
    enumeratedCount: ORDINARY.length + 1,
    distinctCount: ORDINARY.length + 1,
    writeFailureCount: 0,
  });

  assert.equal(observedDocId, documentId, "同じ document として扱われる。別物として作り直さない");

  // --- 衝突は記録される。1件だけ ---
  assert.equal(ctx.observationCount("fingerprint_collision"), 1);
  const details = ctx.observationDetails("fingerprint_collision");
  assert.deepEqual(details[0], {
    quickFingerprint: FINGERPRINT,
    knownHash: originalHash,
    observedHash: changedHash,
  });

  // --- 記録だけで、自動対処はしない ---
  const doc = ctx.one<{ state: string; tombstoned_at: number | null; active_version_id: string }>(
    "SELECT state, tombstoned_at, active_version_id FROM document WHERE document_id=?",
    documentId,
  )!;
  assert.equal(doc.state, "active", "quarantined になっていない");
  assert.equal(doc.tombstoned_at, null, "tombstone されていない");
  assert.equal(doc.active_version_id, originalVersionId, "既存の版が黙って差し替わっていない");
  assert.equal(ctx.count("document_version WHERE document_id=?", documentId), 1, "新しい版は作られていない");

  // --- 指紋が同じで hash も同じなら、それは衝突ではない ---
  ctx.clock.advance(1000);
  const scan3 = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of ORDINARY) await ctx.ingest(scan3.scanId, name, body(name));
  await ctx.observeOnly(
    scan3.scanId,
    REPORT,
    { kind: "content", contentHash: originalHash as ContentHash, sizeBytes: Buffer.byteLength(ORIGINAL_BODY, "utf8") },
    FINGERPRINT,
  );
  await ctx.store.finishScan(scan3.scanId, {
    enumeratedCount: ORDINARY.length + 1,
    distinctCount: ORDINARY.length + 1,
    writeFailureCount: 0,
  });
  assert.equal(
    ctx.observationCount("fingerprint_collision"),
    1,
    "同 fingerprint かつ同 hash は衝突として記録が増えない",
  );

  // --- NO_VERSION_WITHOUT_VERIFIED_BLOB ---
  // 衝突検出後、新しい内容を版にしようとしても blobVerifiedAt が無ければ拒まれる。
  // 1行も書かれずに reject されることを snapshot の差分で確認する
  const beforeReject = await ctx.snapshot();
  await assert.rejects(
    () =>
      ctx.store.insertVersionIfAbsent({
        documentId,
        contentHash: changedHash,
        sizeBytes: Buffer.byteLength(CHANGED_BODY, "utf8"),
        blobKey: blobKeyOf(changedHash),
        // 読了の証拠を持たない値。正規の鋳造からは出てこない
        blobVerifiedAt: __unsafeAttestedAt(0),
        mimeType: "text/plain",
        discoveredByScanId: scan3.scanId,
        pipelineVersion: PIPELINE_VERSION,
      }),
    (error: unknown) => isStoreError(error, "invalid_argument"),
  );
  const afterReject = await ctx.snapshot();
  assert.ok(
    isEmptyDiff(diffSnapshots(beforeReject, afterReject)),
    "blobVerifiedAt の無い version は1行も書かれずに拒否される",
  );
}
