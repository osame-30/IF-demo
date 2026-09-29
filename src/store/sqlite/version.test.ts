/**
 * AC-VER-01..03 / AC-PTR-01..05
 *
 * #15（版は入ったがポインタが動かない）が中心です。
 * 「created:false だから変更なし」と判断する実装を落とすテストが要点になります。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { openStore, type StoreConnection } from "./connection.ts";
import { SqliteLineageStore } from "./lineage-store.ts";
import { TestClock } from "../../../test/support/clock.ts";
import { isStoreError } from "../../domain/errors.ts";
import { versionId as deriveVersionId } from "../../domain/ids.ts";
import { attestContentHash, attestPersisted } from "../../domain/evidence.ts";
import {
  __unsafeAttestContentHash,
  __unsafeAttestedAt,
} from "../../../test/support/unsafe-evidence.ts";
import { assertInvariants, checkInvariants } from "../../../test/support/invariant-checker.ts";
import type {
  VerifiedContentHash,
  BlobKey,
  ContentHash,
  DocumentId,
  ScanId,
  SourceId,
  VersionDraft,
  VersionId,
} from "../../domain/types.ts";

let clock: TestClock;
let conn: StoreConnection;
let store: SqliteLineageStore;

const SRC = "src1" as SourceId;
const BP = { countRatioThresholdBp: 0, missingRatioThresholdBp: 10000 };

const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]): T | undefined =>
  conn.db.prepare(sql).get(...(p as never[])) as T | undefined;
const count = (sql: string, ...p: unknown[]): number =>
  (one<{ n: number }>(`SELECT count(*) AS n FROM ${sql}`, ...p) ?? { n: -1 }).n;

function totalRows(): number {
  return ["scan_run", "document", "document_version", "observation"].reduce((n, t) => n + count(t), 0);
}

/** 実在するバイト列のハッシュを使う。固定文字列を hex に見せかけない */
const hashOf = (text: string): VerifiedContentHash => attestContentHash(Buffer.from(text, "utf8"));

const H1 = hashOf("one");
const H2 = hashOf("two");

let scanId: ScanId;
let docId: DocumentId;

function draft(hash: VerifiedContentHash, over: Partial<VersionDraft> = {}): VersionDraft {
  return {
    documentId: docId,
    contentHash: hash,
    sizeBytes: 3,
    blobKey: `blob-${hash.slice(0, 8)}` as BlobKey,
    blobVerifiedAt: attestPersisted(clock.now(), hash),
    mimeType: "text/plain",
    discoveredByScanId: scanId,
    pipelineVersion: "v0.1",
    ...over,
  };
}

/** 版を入れてポインタも立てる、正常系のひとまとまり */
async function ingest(hash: VerifiedContentHash): Promise<VersionId> {
  const { versionId } = await store.insertVersionIfAbsent(draft(hash));
  await store.setActiveVersion({ documentId: docId, observedHash: hash, versionId, scanId });
  return versionId;
}

beforeEach(async () => {
  clock = new TestClock(1000);
  conn = openStore({ clock });
  store = new SqliteLineageStore(conn);
  conn.db
    .prepare(
      `INSERT INTO source (source_id, kind, config_hash, display_name,
         key_unicode_form, key_case_fold, key_path_separator, key_trim_slashes)
       VALUES ('src1', 'local-fs', 'cfg', 'src1', 'NFC', 0, 'posix', 1)`,
    )
    .run();
  const scan = await store.beginScan(SRC, BP);
  scanId = scan.scanId;
  const observed = await store.recordObservedDocument(scanId, {
    stableKey: "a.txt",
    outcome: { kind: "content", contentHash: H1, sizeBytes: 3 },
  });
  docId = observed.documentId;
});

afterEach(() => conn.close());

describe("insertVersionIfAbsent", () => {
  it("AC-VER-01: 新規挿入で created:true / blobVerifiedAt が入る", async () => {
    const r = await store.insertVersionIfAbsent(draft(H1));
    assert.equal(r.created, true);
    assert.equal(r.versionId, deriveVersionId(docId, H1));

    const row = one<{ blob_verified_at: number; ingested_at: number }>(
      "SELECT blob_verified_at, ingested_at FROM document_version WHERE version_id=?",
      r.versionId,
    )!;
    assert.equal(row.blob_verified_at, 1000);
    assert.equal(row.ingested_at, 1000);
  });

  it("ingestedAt はストアの時計が刻む（引数に口がない）", async () => {
    clock.setTo(7777);
    const r = await store.insertVersionIfAbsent(draft(H1));
    assert.equal(
      one<{ ingested_at: number }>("SELECT ingested_at FROM document_version WHERE version_id=?", r.versionId)!
        .ingested_at,
      7777,
    );
  });

  it("AC-VER-02: 同一版の再挿入は created:false かつ1行も書かない", async () => {
    const first = await store.insertVersionIfAbsent(draft(H1));
    const before = totalRows();
    const again = await store.insertVersionIfAbsent(draft(H1));
    assert.equal(again.created, false);
    assert.equal(again.versionId, first.versionId);
    assert.equal(totalRows(), before);
  });

  it("AC-VER-03: document_version への UPDATE はトリガが止める", async () => {
    const r = await store.insertVersionIfAbsent(draft(H1));
    assert.throws(
      () =>
        conn.db
          .prepare("UPDATE document_version SET content_hash=? WHERE version_id=?")
          .run(H2, r.versionId),
      /document_version is immutable/,
    );
  });

  it("blobVerifiedAt が無い版は書けない（#8, #21）", async () => {
    for (const bad of [0, -1, 1.5]) {
      await assert.rejects(
        () => store.insertVersionIfAbsent(draft(H1, { blobVerifiedAt: __unsafeAttestedAt(bad) })),
        (e: unknown) => isStoreError(e, "invalid_argument"),
      );
    }
    assert.equal(count("document_version"), 0);
  });

  it("blobKey が空の版は書けない", async () => {
    await assert.rejects(
      () => store.insertVersionIfAbsent(draft(H1, { blobKey: "" as BlobKey })),
      (e: unknown) => isStoreError(e, "invalid_argument"),
    );
  });

  it("サイズ 0 は正当な内容として通る（#20）", async () => {
    const empty = hashOf("");
    assert.equal(empty, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const r = await store.insertVersionIfAbsent(draft(empty, { sizeBytes: 0 }));
    assert.equal(r.created, true);
  });

  it("負のサイズは拒む", async () => {
    await assert.rejects(
      () => store.insertVersionIfAbsent(draft(H1, { sizeBytes: -1 })),
      (e: unknown) => isStoreError(e, "invalid_argument"),
    );
  });

  it("contentHash が小文字 hex でなければ拒む", async () => {
    await assert.rejects(() =>
      // 正規の鋳造からは出てこない値。逃げ道を通すのはこういう場所だけ
      store.insertVersionIfAbsent(draft(__unsafeAttestContentHash(H1.toUpperCase()))),
    );
  });

  it("同一 document に同一 contentHash の版は2つできない（ACL_DOES_NOT_VERSION）", async () => {
    await store.insertVersionIfAbsent(draft(H1));
    // 別の blobKey でも versionId は同じなので created:false になる
    const again = await store.insertVersionIfAbsent(draft(H1, { blobKey: "other" as BlobKey }));
    assert.equal(again.created, false);
    assert.equal(count("document_version"), 1);
  });
});

describe("setActiveVersion", () => {
  it("初回はポインタが立ち、version_created が残る", async () => {
    const vid = await ingest(H1);
    const row = one<{ active_version_id: string }>(
      "SELECT active_version_id FROM document WHERE document_id=?",
      docId,
    )!;
    assert.equal(row.active_version_id, vid);
    assert.equal(count("observation WHERE kind='version_created' AND version_id=?", vid), 1);
  });

  it("AC-PTR-01: 版が既存でもポインタが古ければ更新する（#15）", async () => {
    // 版だけ入れてクラッシュした状態を作る
    const { versionId, created } = await store.insertVersionIfAbsent(draft(H1));
    assert.equal(created, true);
    assert.equal(
      one<{ active_version_id: string | null }>(
        "SELECT active_version_id FROM document WHERE document_id=?",
        docId,
      )!.active_version_id,
      null,
    );

    // 再実行。insert は created:false を返すが、ポインタは動かなければならない
    const retry = await store.insertVersionIfAbsent(draft(H1));
    assert.equal(retry.created, false, "前提: 再実行では版は作られない");

    const r = await store.setActiveVersion({ documentId: docId, observedHash: H1, versionId, scanId });
    assert.equal(r.updated, true, "created:false を「変更なし」と読むと #15 が再発する");
  });

  it("AC-PTR-02: 現 active と同じ hash なら already_current。1行も書かない", async () => {
    const vid = await ingest(H1);
    const before = totalRows();
    const r = await store.setActiveVersion({ documentId: docId, observedHash: H1, versionId: vid, scanId });
    assert.deepEqual(r, { updated: false, reason: "already_current" });
    assert.equal(totalRows(), before);
  });

  it("AC-PTR-03: running でない走査からの更新は stale_scan（#2）", async () => {
    const vid = await ingest(H1);
    await store.finishScan(scanId, { enumeratedCount: 1, distinctCount: 1, writeFailureCount: 0 });

    // 追い越された走査が遅れてポインタを巻き戻そうとする
    const { versionId: v2 } = await store.insertVersionIfAbsent(draft(H2));
    const r = await store.setActiveVersion({ documentId: docId, observedHash: H2, versionId: v2, scanId });
    assert.deepEqual(r, { updated: false, reason: "stale_scan" });

    assert.equal(
      one<{ active_version_id: string }>(
        "SELECT active_version_id FROM document WHERE document_id=?",
        docId,
      )!.active_version_id,
      vid,
      "ポインタは巻き戻らない",
    );
  });

  it("AC-PTR-04: versionId が documentId + observedHash と食い違えば throw", async () => {
    const wrong = deriveVersionId(docId, H2);
    await assert.rejects(
      () => store.setActiveVersion({ documentId: docId, observedHash: H1, versionId: wrong, scanId }),
      (e: unknown) => isStoreError(e, "invalid_argument"),
    );
  });

  it("AC-PTR-05: 他文書の版は指せない", async () => {
    await ingest(H1);
    const other = await store.recordObservedDocument(scanId, {
      stableKey: "b.txt",
      outcome: { kind: "content", contentHash: H1, sizeBytes: 3 },
    });
    const mine = deriveVersionId(docId, H1);

    // 導出の検査が一次防壁。documentId が違えば versionId も違う
    await assert.rejects(
      () =>
        store.setActiveVersion({
          documentId: other.documentId,
          observedHash: H1,
          versionId: mine,
          scanId,
        }),
      (e: unknown) => isStoreError(e, "invalid_argument"),
    );

    // 検査を迂回しても複合 FK が二次防壁として止める
    assert.throws(
      () =>
        conn.db
          .prepare("UPDATE document SET active_version_id=? WHERE document_id=?")
          .run(mine, other.documentId),
      /FOREIGN KEY|constraint/i,
    );
  });

  /**
   * AC-PTR-06（2026-09-10 の指摘 2）
   *
   * **「running か」は「この文書の走査か」ではありません。** 同一 source の
   * running は高々1件ですが、*別 source* の running 走査はいつでも存在しえます。
   * 修正前は、`AC-PTR-03` が `stale_scan` で拒んだのと同じ更新が、
   * scanId を別 source の running 走査に替えるだけで通りました。
   * 観測にも他所の `scan_id` が載ります（`POINTER_MATCHES_OBSERVATION` は
   * 載った ID の所属を見ていません）。
   *
   * これは競合ではなく取り違えなので、`tombstone` / `#gateForDeletion` と同じく
   * `stale_scan` に畳まず例外にします。
   */
  it("AC-PTR-06: 別 source の running 走査ではポインタを動かせない", async () => {
    const vid = await ingest(H1);
    await store.finishScan(scanId, { enumeratedCount: 1, distinctCount: 1, writeFailureCount: 0 });

    // 別の接続元。こちらの走査は running のまま
    conn.db
      .prepare(
        `INSERT INTO source (source_id, kind, config_hash, display_name,
           key_unicode_form, key_case_fold, key_path_separator, key_trim_slashes)
         VALUES ('src2', 'local-fs', 'cfg', 'src2', 'NFC', 0, 'posix', 1)`,
      )
      .run();
    const foreign = await store.beginScan("src2" as SourceId, BP);

    const { versionId: v2 } = await store.insertVersionIfAbsent(draft(H2));
    const before = totalRows();
    await assert.rejects(
      () =>
        store.setActiveVersion({
          documentId: docId,
          observedHash: H2,
          versionId: v2,
          scanId: foreign.scanId,
        }),
      (e: unknown) => isStoreError(e, "invalid_argument"),
    );

    assert.equal(
      one<{ active_version_id: string }>(
        "SELECT active_version_id FROM document WHERE document_id=?",
        docId,
      )!.active_version_id,
      vid,
      "ポインタは動かない",
    );
    assert.equal(totalRows(), before, "観測も1行も残らない");
  });

  it("AC-PTR-06: source の照合は already_current より先に走る", async () => {
    // 同じ hash を渡すと `already_current` で早期 return する経路。
    // そこで返してしまうと、**別 source からの呼び出しが黙って成功扱いになる**
    const vid = await ingest(H1);
    conn.db
      .prepare(
        `INSERT INTO source (source_id, kind, config_hash, display_name,
           key_unicode_form, key_case_fold, key_path_separator, key_trim_slashes)
         VALUES ('src2', 'local-fs', 'cfg', 'src2', 'NFC', 0, 'posix', 1)`,
      )
      .run();
    const foreign = await store.beginScan("src2" as SourceId, BP);

    await assert.rejects(
      () =>
        store.setActiveVersion({
          documentId: docId,
          observedHash: H1,
          versionId: vid,
          scanId: foreign.scanId,
        }),
      (e: unknown) => isStoreError(e, "invalid_argument"),
    );
  });

  it("内容が変われば新しい版へ進む", async () => {
    await ingest(H1);
    const v2 = await ingest(H2);
    assert.equal(
      one<{ active_version_id: string }>(
        "SELECT active_version_id FROM document WHERE document_id=?",
        docId,
      )!.active_version_id,
      v2,
    );
    assert.equal(count("document_version"), 2);
  });

  it("古い版に戻ると version_reverted になる（#19: 復元で内容が戻る）", async () => {
    const v1 = await ingest(H1);
    await ingest(H2);

    const r = await store.setActiveVersion({ documentId: docId, observedHash: H1, versionId: v1, scanId });
    assert.equal(r.updated, true);
    assert.equal(count("observation WHERE kind='version_reverted' AND version_id=?", v1), 1);
    assert.equal(count("observation WHERE kind='version_created' AND version_id=?", v1), 1);
  });

  it("存在しない document は拒む", async () => {
    await assert.rejects(
      () =>
        store.setActiveVersion({
          documentId: "nope" as DocumentId,
          observedHash: H1,
          versionId: deriveVersionId("nope" as DocumentId, H1),
          scanId,
        }),
      (e: unknown) => isStoreError(e, "invalid_argument"),
    );
  });

  it("POINTER_MATCHES_OBSERVATION が緑のままになる", async () => {
    await ingest(H1);
    await ingest(H2);
    const v1 = deriveVersionId(docId, H1);
    await store.setActiveVersion({ documentId: docId, observedHash: H1, versionId: v1, scanId });

    const report = await checkInvariants({
      reader: { all: (sql) => Promise.resolve(conn.db.prepare(sql).all()) },
    });
    assert.doesNotThrow(() => assertInvariants(report, ["POINTER_MATCHES_OBSERVATION"]));
  });
});

describe("#15 の完全な再現", () => {
  it("版挿入後・ポインタ更新前のクラッシュから再実行して回復する", async () => {
    // 1回目: 版は書けたがポインタ更新前に落ちた
    const { versionId } = await store.insertVersionIfAbsent(draft(H1));
    assert.equal(count("document_version"), 1);
    assert.equal(
      one<{ v: string | null }>("SELECT active_version_id AS v FROM document WHERE document_id=?", docId)!.v,
      null,
    );

    // この時点では不変条件が破れている（版はあるがポインタが無い）
    const reader = { all: (sql: string) => Promise.resolve(conn.db.prepare(sql).all()) };
    const broken = await checkInvariants({ reader });
    assert.throws(
      () => assertInvariants(broken, ["POINTER_MATCHES_OBSERVATION"]),
      /versions_exist_but_no_active_pointer/,
    );

    // 2回目: created:false でも setActiveVersion を呼ぶ契約なので回復する
    const retry = await store.insertVersionIfAbsent(draft(H1));
    assert.equal(retry.created, false);
    await store.setActiveVersion({ documentId: docId, observedHash: H1, versionId, scanId });

    const healed = await checkInvariants({ reader });
    assert.doesNotThrow(() => assertInvariants(healed));
  });
});
