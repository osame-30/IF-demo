/**
 * STEP 4 — 走査の駆動部。
 *
 * ここまでの各層は単体では検証済みですが、**繋いだ経路は一度も通っていません**
 * でした（`enumerate()` / `fetch()` の呼び出し元が、アダプタ自身のテスト以外に
 * 1件も無かった）。この一式は「実際に繋いだら何が起きるか」だけを見ます。
 *
 * 作り物のハッシュは使いません。バイト列を本当にディスクへ置き、
 * 読み直したハッシュで版を立てます。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, link, readdir, chmod, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { runScan, type ScanDependencies, type ScanThresholds } from "./scan.ts";
import { openStore, type StoreConnection } from "../store/sqlite/connection.ts";
import { SqliteLineageStore } from "../store/sqlite/lineage-store.ts";
import { FileBlobStore } from "../store/blob/file-blob-store.ts";
import { LocalFolderSourceAdapter } from "../source/local-fs/local-folder-adapter.ts";
import { blobPath } from "../store/blob/blob-path.ts";
import { InvalidArgumentError, isStoreError } from "../domain/errors.ts";
import { TestClock } from "../../test/support/clock.ts";
import { assertInvariants, checkInvariants } from "../../test/support/invariant-checker.ts";
import { diffSnapshots, snapshotState } from "../../test/support/state-snapshot.ts";
import { detectFsCapabilities } from "../../test/support/fs-scenario.ts";
import type {
  BlobKey,
  CompletedScanRun,
  Document,
  EnumeratedItem,
  LineageStore,
  ObservedEntry,
  ObservedResult,
  ScanId,
  SourceAdapter,
  SourceDescriptor,
  SourceId,
} from "../domain/types.ts";

const SRC = "local-1" as SourceId;

const DESCRIPTOR: SourceDescriptor = {
  sourceId: SRC,
  kind: "local-fs",
  configHash: "cfg",
  displayName: "local folder",
  keyNormalization: {
    unicodeForm: "NFC",
    caseFold: false,
    pathSeparator: "posix",
    trimSlashes: true,
  },
};

/**
 * 縮小を止めない閾値。
 *
 * 削除検知そのものを見たい検査では弁に邪魔をさせません。弁自体の検査は
 * `finish-scan.test.ts` と `scan/` のフィクスチャが持っています。
 */
const LOOSE: ScanThresholds = { countRatioThresholdBp: 0, missingRatioThresholdBp: 10000 };
/** 実運用に近い値。弁が閉じることを見る検査で使う */
const TIGHT: ScanThresholds = { countRatioThresholdBp: 9000, missingRatioThresholdBp: 1000 };

let clock: TestClock;
let conn: StoreConnection;
let store: SqliteLineageStore;
let blobs: FileBlobStore;
let root: string;
let blobRoot: string;

const reader = { all: (sql: string) => Promise.resolve(conn.db.prepare(sql).all()) };
const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]): T | undefined =>
  conn.db.prepare(sql).get(...(p as never[])) as T | undefined;
const count = (sql: string, ...p: unknown[]): number =>
  (one<{ n: number }>(`SELECT count(*) AS n FROM ${sql}`, ...p) ?? { n: -1 }).n;
const observations = (kind: string): number => count("observation WHERE kind=?", kind);

function depsFor(adapter: SourceAdapter): ScanDependencies {
  return {
    adapter,
    store,
    blobs,
    pipelineVersion: "test-0",
    fallbackMimeType: "application/octet-stream",
  };
}

function localAdapter(at: string = root): SourceAdapter {
  return new LocalFolderSourceAdapter({ root: at, descriptor: DESCRIPTOR });
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (text.length > 0) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/**
 * 好きなものを流す接続元。
 *
 * ローカルFS では作れない状況（列挙とサイズ申告が食い違う、列挙が途中で落ちる）
 * のために使います。**繋がりそのものは実物の `LocalFolderSourceAdapter` で
 * 検証します。** ここでスタブに寄せると、駆動部が実物と噛み合わない形でも
 * 緑になります。
 */
function stubAdapter(options: {
  readonly items: ReadonlyArray<EnumeratedItem>;
  readonly fetch: (stableKey: string) => Promise<ReadableStream<Uint8Array>>;
  /** この件数を流した直後に列挙が落ちる */
  readonly throwAfter?: number;
}): SourceAdapter {
  return {
    descriptor: DESCRIPTOR,
    async *enumerate(): AsyncIterable<EnumeratedItem> {
      let sent = 0;
      for (const item of options.items) {
        if (options.throwAfter === sent) throw new Error("mount went away");
        sent += 1;
        yield item;
      }
      if (options.throwAfter === sent) throw new Error("mount went away");
    },
    fetch: options.fetch,
  };
}

function entryOf(stableKey: string, sizeBytes: number): EnumeratedItem {
  return { kind: "entry", entry: { stableKey, sizeBytes } };
}

/**
 * `recordObservedDocument` が特定の鍵で失敗するストア。
 *
 * **`Proxy` の受け手を target に固定しています。** 既定のままだと `this` が
 * proxy になり、`SqliteLineageStore` の private フィールドが読めません。
 */
function storeFailingOn(stableKey: string, error: unknown): LineageStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === "recordObservedDocument") {
        return async (scanId: ScanId, entry: ObservedEntry): Promise<ObservedResult> => {
          if (entry.stableKey === stableKey) throw error;
          return target.recordObservedDocument(scanId, entry);
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeEach(async () => {
  clock = new TestClock(1000);
  conn = openStore({ clock });
  store = new SqliteLineageStore(conn);
  conn.db
    .prepare(
      `INSERT INTO source (source_id, kind, config_hash, display_name,
         key_unicode_form, key_case_fold, key_path_separator, key_trim_slashes)
       VALUES (?, 'local-fs', 'cfg', 'local folder', 'NFC', 0, 'posix', 1)`,
    )
    .run(SRC);

  root = await mkdtemp(join(tmpdir(), "scan-root-"));
  blobRoot = await mkdtemp(join(tmpdir(), "scan-blob-"));
  blobs = new FileBlobStore({ root: blobRoot, clock });
});

afterEach(async () => {
  if (conn.db.isOpen) conn.close();
  await rm(root, { recursive: true, force: true });
  await rm(blobRoot, { recursive: true, force: true });
});

describe("runScan: 実物を繋いで全系列を作る（LINEAGE_COMPLETE）", () => {
  it("ファイルから document / version / active ポインタ / blob 実体まで揃う", async () => {
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "a.txt"), "alpha");
    await writeFile(join(root, "sub", "b.txt"), "beta");

    const report = await runScan(depsFor(localAdapter()), LOOSE);

    assert.equal(report.status, "completed", report.abortReason);
    assert.equal(report.enumeratedCount, 2);
    assert.equal(report.distinctCount, 2);
    assert.equal(report.discoveredCount, 2);
    assert.equal(report.versionsCreatedCount, 2);
    assert.equal(report.writeFailureCount, 0);

    assert.equal(count("document WHERE state='active'"), 2);
    assert.equal(count("document_version"), 2);
    assert.equal(count("document WHERE active_version_id IS NULL"), 0, "ポインタが立っていない");

    // **バイト列が本当にディスクに在ります。** 行があることは証拠になりません
    const stored = await readdir(blobRoot);
    assert.ok(stored.filter((n) => n !== "tmp").length >= 1, `blob が無い: ${stored.join()}`);

    // blobs を渡すと HASH_MATCHES_BLOB が実際に検証される
    const report2 = await checkInvariants({ reader, blobs, knownSourceIds: [SRC] });
    assert.doesNotThrow(() => assertInvariants(report2));
  });

  it("version は接続元の申告ではなく、読み直したハッシュで立つ", async () => {
    await writeFile(join(root, "a.txt"), "alpha");
    await runScan(depsFor(localAdapter()), LOOSE);

    const row = one<{ content_hash: string; size_bytes: number; pipeline_version: string }>(
      "SELECT content_hash, size_bytes, pipeline_version FROM document_version",
    )!;
    assert.equal(row.size_bytes, 5);
    assert.equal(row.pipeline_version, "test-0");
    // 実体を読み直して一致する
    const key = one<{ blob_key: string }>("SELECT blob_key FROM document_version")!.blob_key;
    assert.equal(String(key), row.content_hash, "blobKey は contentHash から導出される");
  });
});

describe("runScan: 同じものを2回投げても副作用が出ない（IDEMPOTENT_REPLAY）", () => {
  it("2回目は版を作らず、状態が一致する", async () => {
    await writeFile(join(root, "a.txt"), "alpha");
    await writeFile(join(root, "b.txt"), "beta");
    await runScan(depsFor(localAdapter()), LOOSE);

    clock.advance(1000);
    const before = await snapshotState(reader);
    const second = await runScan(depsFor(localAdapter()), LOOSE);
    const after = await snapshotState(reader);

    assert.equal(second.status, "completed", second.abortReason);
    assert.equal(second.versionsCreatedCount, 0, "同じ内容で版が増えている");
    assert.equal(second.discoveredCount, 0);
    assert.equal(second.tombstonedCount, 0);
    assert.equal(second.missingCount, 0);

    const report = await checkInvariants({
      reader,
      blobs,
      replay: { before, after },
      knownSourceIds: [SRC],
    });
    assert.doesNotThrow(() => assertInvariants(report));
  });

  it("内容が変われば版が増え、ポインタが動く（差分検知）", async () => {
    await writeFile(join(root, "a.txt"), "alpha");
    const first = await runScan(depsFor(localAdapter()), LOOSE);
    const firstPointer = one<{ active_version_id: string }>(
      "SELECT active_version_id FROM document",
    )!.active_version_id;

    clock.advance(1000);
    await writeFile(join(root, "a.txt"), "ALPHA CHANGED");
    const second = await runScan(depsFor(localAdapter()), LOOSE);

    assert.equal(first.versionsCreatedCount, 1);
    assert.equal(second.versionsCreatedCount, 1, "内容が変わったのに版が増えていない");
    assert.equal(count("document_version"), 2);

    const movedTo = one<{ active_version_id: string }>(
      "SELECT active_version_id FROM document",
    )!.active_version_id;
    assert.notEqual(movedTo, firstPointer, "ポインタが古い版のまま");
    assert.equal(count("document"), 1, "同じ鍵なのに document が増えている");
  });
});

describe("runScan: 消えたものだけを墓標にする（削除検知）", () => {
  it("消えた1件に document_missing と墓標が立つ", async () => {
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      await writeFile(join(root, name), `body of ${name}`);
    }
    await runScan(depsFor(localAdapter()), LOOSE);

    clock.advance(1000);
    await rm(join(root, "b.txt"));
    const second = await runScan(depsFor(localAdapter()), LOOSE);

    assert.equal(second.status, "completed", second.abortReason);
    assert.equal(second.missingCount, 1);
    assert.equal(second.tombstonedCount, 1);
    assert.equal(observations("document_missing"), 1);
    assert.equal(observations("document_tombstoned"), 1);

    const gone = one<{ state: string }>("SELECT state FROM document WHERE stable_key='b.txt'")!;
    assert.equal(gone.state, "tombstoned");
    assert.equal(count("document WHERE state='active'"), 2, "残った2件まで消えている");
  });

  it("接続元がまるごと見えなくなっても全件墓標にしない", async () => {
    // **これが弁の存在理由です。** マウントが外れた走査は「全件消えた」に見えます
    for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(root, name), "x");
    await runScan(depsFor(localAdapter()), LOOSE);

    clock.advance(1000);
    const blind = await runScan(depsFor(localAdapter(join(root, "gone"))), TIGHT);

    assert.equal(blind.status, "aborted_safety");
    assert.equal(blind.unlistableSubtreeCount, 1, "部分木の報告が届いていない");
    assert.equal(blind.enumeratedCount, 0);
    assert.equal(blind.tombstonedCount, 0);
    assert.equal(blind.missingCount, 0, "削除判定に進んでいる");
    assert.equal(count("document WHERE state='active'"), 3, "3件とも墓標になった");
    assert.equal(observations("document_tombstoned"), 0);

    // 弁の理由に unlistable_subtree が含まれる。**承認では免除されない側**
    const reason = one<{ abort_reason: string }>(
      "SELECT abort_reason FROM scan_run WHERE scan_id=?",
      blind.scanId,
    )!.abort_reason;
    assert.ok(
      reason.split(",").includes("unlistable_subtree"),
      `理由に部分木が入っていない: ${reason}`,
    );
  });

  it("読めなかった1件は欠損ではない（#17）", async () => {
    // 列挙はできたが取得が失敗する。**last_seen が進まないと墓標になります**
    const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const adapter = stubAdapter({
      items: [entryOf("a.txt", 5), entryOf("locked.txt", 9)],
      fetch: (key) =>
        key === "locked.txt" ? Promise.reject(denied) : Promise.resolve(streamOf("alpha")),
    });

    const report = await runScan(depsFor(adapter), LOOSE);

    assert.equal(report.status, "completed", report.abortReason);
    assert.equal(report.enumeratedCount, 2);
    assert.equal(report.distinctCount, 2, "読めなかった1件が観測に入っていない");
    assert.equal(report.versionsCreatedCount, 1, "読めない1件が版になっている");
    assert.equal(report.tombstonedCount, 0, "読めなかったことを消えたことにしている");
    assert.equal(observations("document_unreadable"), 1);

    const locked = one<{ state: string; active_version_id: string | null }>(
      "SELECT state, active_version_id FROM document WHERE stable_key='locked.txt'",
    )!;
    assert.equal(locked.state, "active");
    assert.equal(locked.active_version_id, null, "読めていないのにポインタが立っている");
  });
});

describe("runScan: 版・ポインタ・件数の受け渡し", () => {
  it("既にある版へ戻ってもポインタが動く（#15）", async () => {
    // **`insertVersionIfAbsent` の `created` を「変更なし」と読むと落ちる形です。**
    // alpha -> beta -> alpha と戻すと、3回目の created は false になります。
    // そこで打ち切ると、ポインタは beta の版を指したまま二度と直りません
    await writeFile(join(root, "a.txt"), "alpha");
    await runScan(depsFor(localAdapter()), LOOSE);
    const atAlpha = one<{ active_version_id: string }>(
      "SELECT active_version_id FROM document",
    )!.active_version_id;

    clock.advance(1000);
    await writeFile(join(root, "a.txt"), "beta");
    await runScan(depsFor(localAdapter()), LOOSE);

    clock.advance(1000);
    await writeFile(join(root, "a.txt"), "alpha");
    const third = await runScan(depsFor(localAdapter()), LOOSE);

    assert.equal(third.versionsCreatedCount, 0, "前提: 3回目は版を作らない（created=false）");
    assert.equal(count("document_version"), 2);
    assert.equal(
      one<{ active_version_id: string }>("SELECT active_version_id FROM document")!
        .active_version_id,
      atAlpha,
      "created が false だからとポインタを置き去りにしている",
    );
    assert.equal(observations("version_reverted"), 1);
  });

  it("同じ鍵が2回列挙されても distinct は増えない（#27）", async () => {
    // bind マウントで同じ鍵が2回出る。**弁が見るのは distinct 側だけです。**
    // enumerated をそのまま渡すと基準値が倍になり、次の正常な走査が誤停止します
    const adapter = stubAdapter({
      items: [entryOf("a.txt", 5), entryOf("a.txt", 5), entryOf("b.txt", 5)],
      fetch: () => Promise.resolve(streamOf("alpha")),
    });

    const report = await runScan(depsFor(adapter), LOOSE);

    assert.equal(report.enumeratedCount, 3, "重複を含む件数はそのまま数える");
    assert.equal(report.distinctCount, 2, "重複が基準値を膨らませている");
    assert.equal(count("document"), 2);
    assert.equal(
      one<{ distinct_count: number }>(
        "SELECT distinct_count FROM scan_run WHERE scan_id=?",
        report.scanId,
      )!.distinct_count,
      2,
      "ストアに渡した件数が重複込みになっている",
    );
  });

  it("blob が壊れていたら走査を止める（無言のスキップにしない）", async () => {
    await writeFile(join(root, "a.txt"), "alpha");
    await runScan(depsFor(localAdapter()), LOOSE);

    // 実体だけを別内容に差し替える。行はそのまま。**次の put は分岐を見つけます**
    const key = one<{ blob_key: string }>("SELECT blob_key FROM document_version")!.blob_key;
    await writeFile(blobPath(blobRoot, key as BlobKey), "tampered");

    clock.advance(1000);
    await assert.rejects(
      () => runScan(depsFor(localAdapter()), LOOSE),
      (error: unknown) => isStoreError(error, "blob_divergence"),
      "分岐を unreadable に写して走査を完了させている",
    );
    // 完了していたら last_seen が進み、記録上は健全なまま実体だけが壊れている
    assert.equal(count("scan_run WHERE status='failed'"), 1);
    assert.equal(count("scan_run WHERE status='completed'"), 1);

    // **監査には分岐の種類が残る。** 以前は一律 `enumeration_failed` で、
    // 「列挙が落ちた」と「実体が壊れていた」が同じ1語だった（S4-9）。
    // 分岐は observation に書けない（`put` は観測より前に落ちる）ので、
    // `abort_reason` が唯一の痕跡になる
    assert.equal(
      one<{ abort_reason: string }>("SELECT abort_reason FROM scan_run WHERE status='failed'")!
        .abort_reason,
      "blob_divergence",
    );
    assert.equal(observations("blob_reference_broken"), 0, "前提: 分岐は観測に残らない");
  });
});

describe("runScan: Office の一時ファイル（~$）", () => {
  it("文書にならず entry_skipped に残り、Office を閉じて消えても欠損にならない", async () => {
    await writeFile(join(root, "report.docx"), "body");
    await writeFile(join(root, "~$report.docx"), "owner-file");

    const first = await runScan(depsFor(localAdapter()), TIGHT);
    assert.equal(first.status, "completed", first.abortReason);
    assert.equal(count("document"), 1, "一時ファイルが文書になっている");
    assert.equal(first.skippedCount, 1);
    assert.equal(first.enumeratedCount, 1, "観測に通さないものを列挙に数えている");
    assert.equal(observations("entry_skipped"), 1);
    assert.equal(observations("document_unreadable"), 0, "観測に通している（listedAndKeyable に入れていないこと）");
    const detail = JSON.parse(
      one<{ detail: string }>("SELECT detail FROM observation WHERE kind='entry_skipped'")!.detail,
    ) as Record<string, unknown>;
    assert.deepEqual(detail, { kind: "office_temporary_file", stableKey: "~$report.docx", sizeBytes: 10 });

    clock.advance(1000);
    await rm(join(root, "~$report.docx"));
    let reviewed: number | undefined;
    const second = await runScan(depsFor(localAdapter()), TIGHT, {
      reviewSafety: async (review) => { reviewed = review.missingCount; return undefined; },
    });
    assert.equal(second.status, "completed", second.abortReason);
    assert.equal(reviewed, 0, "閉じただけで削除確認に回っている");
    assert.equal(second.tombstonedCount, 0);
  });

  it("規則の前に文書になった ~$ は、次の走査で1回だけ欠損になる（DF-5 の移行経路）", async () => {
    const fetch = () => Promise.resolve(streamOf("alpha"));
    await runScan(depsFor(stubAdapter({ items: [entryOf("a.docx", 5), entryOf("~$a.docx", 5)], fetch })), LOOSE);
    assert.equal(count("document WHERE state='active'"), 2);

    const afterRule = stubAdapter({
      items: [entryOf("a.docx", 5), { kind: "office_temporary_file", stableKey: "~$a.docx", sizeBytes: 5 }],
      fetch,
    });
    clock.advance(1000);
    const migrated = await runScan(depsFor(afterRule), LOOSE);
    assert.equal(migrated.missingCount, 1);
    assert.equal(migrated.tombstonedCount, 1);
    assert.equal(one<{ state: string }>("SELECT state FROM document WHERE stable_key='~$a.docx'")!.state, "tombstoned");

    clock.advance(1000);
    const next = await runScan(depsFor(afterRule), LOOSE);
    assert.equal(next.missingCount, 0, "同じ一時ファイルが毎回欠損に数えられる");
    assert.equal(count("document"), 2, "墓標の後に一時ファイルが文書として戻っている");
  });
});

describe("runScan: 鍵にできなかったものを黙って捨てない", () => {
  it("hardlink は entry_skipped に残り、走査は続く", async () => {
    await writeFile(join(root, "a.txt"), "alpha");
    await writeFile(join(root, "h1.txt"), "linked");
    await link(join(root, "h1.txt"), join(root, "h2.txt"));

    const report = await runScan(depsFor(localAdapter()), LOOSE);

    assert.equal(report.skippedCount, 2, "hardlink の対が両方報告されていない");
    assert.equal(report.unlistableSubtreeCount, 0, "弁を閉じる側に出している");
    assert.equal(report.versionsCreatedCount, 1, "hardlink が版になっている");
    assert.equal(observations("entry_skipped"), 2);
    assert.equal(observations("document_unreadable"), 2);

    // **実在は確かめられたので、観測には通ります。** 版は立ちません
    assert.equal(count("document"), 3);
    assert.equal(count("document WHERE active_version_id IS NULL"), 2);
    // 観測に通した分は列挙にも入る。入れないと finishScan が件数矛盾で弾く
    assert.equal(report.enumeratedCount, 3);
    assert.equal(report.distinctCount, 3);

    // detail に理由が残る。件数だけでは「何を落としたか」が追えない
    const detail = one<{ detail: string }>(
      "SELECT detail FROM observation WHERE kind='entry_skipped' LIMIT 1",
    )!.detail;
    assert.match(detail, /hard_linked/);

    // **観測側にも理由が渡る。** 定数を入れていたら、運用者は
    // 「読めなかった」としか分からず、hardlink だったことが消える
    const unreadable = one<{ detail: string }>(
      "SELECT detail FROM observation WHERE kind='document_unreadable' LIMIT 1",
    )!.detail;
    assert.equal((JSON.parse(unreadable) as Record<string, unknown>)["errorKind"], "hard_linked");
  });

  it("実在するファイルは、落としても墓標にならない", async () => {
    // **私が開けた穴の回帰検査です。** 走査の間に hardlink を1本張られると、
    // アダプタはそのファイルを落とします。落としただけで観測に通さないと
    // `last_seen` が進まず、**ディスク上に在るファイルが欠損に見えます。**
    //
    // 実測（この直しの前）: 60件のうち1件に hardlink を張ると、既定に近い
    // 閾値（9000 / 1000）でも走査は completed で終わり、その1件が
    // tombstone されました。欠損比 1.7% は弁を通ります。
    for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(root, name), `x ${name}`);
    await runScan(depsFor(localAdapter()), LOOSE);
    assert.equal(count("document WHERE state='active'"), 3);

    clock.advance(1000);
    await link(join(root, "a.txt"), join(root, "a-link.txt"));
    const second = await runScan(depsFor(localAdapter()), LOOSE);

    assert.equal(second.status, "completed", second.abortReason);
    assert.equal(second.tombstonedCount, 0, "実在するファイルに墓標が立っている");
    assert.equal(second.missingCount, 0, "実在するファイルが欠損に見えている");
    assert.equal(
      one<{ state: string }>("SELECT state FROM document WHERE stable_key='a.txt'")!.state,
      "active",
    );
  });

  it("消えた1件も観測に通す（墓標は1走査ぶん遅れる）", async () => {
    // **v0.1 で向きを変えました。** 以前は「`lstat` が失敗した枝は本当に
    // 消えている」として観測に通していませんでした。それが偽で、`EACCES` で
    // 落ちた実在ファイルが墓標になっていました（実測: WSL / ext4）。
    //
    // 列挙に出たものは今回は墓標にしない、と決めたので、`ENOENT` もここを
    // 通ります。errno で枝を分けないための代償が、この1走査の遅れです。
    // 走査と走査の**間**に消えたものは `readdir` に出ないので遅れません。
    const first = stubAdapter({
      items: [entryOf("a.txt", 5), entryOf("gone.txt", 5)],
      fetch: () => Promise.resolve(streamOf("alpha")),
    });
    await runScan(depsFor(first), LOOSE);
    assert.equal(count("document WHERE state='active'"), 2);

    clock.advance(1000);
    const second = stubAdapter({
      items: [
        entryOf("a.txt", 5),
        { kind: "vanished_during_scan", stableKey: "gone.txt", errorKind: "ENOENT" },
      ],
      fetch: () => Promise.resolve(streamOf("alpha")),
    });
    const report = await runScan(depsFor(second), LOOSE);

    assert.equal(report.skippedCount, 1);
    assert.equal(report.enumeratedCount, 2, "消えた1件を列挙に数えていない");
    assert.equal(observations("entry_skipped"), 1);
    // 落ちた理由は `kind` に潰さず errno のまま残す
    assert.equal(
      one<{ detail: string }>(
        "SELECT detail FROM observation WHERE kind='document_unreadable'",
      )!.detail,
      JSON.stringify({ errorKind: "ENOENT" }),
    );
    assert.equal(report.tombstonedCount, 0, "列挙に出た1件に墓標が立っている");
    assert.equal(
      one<{ state: string }>("SELECT state FROM document WHERE stable_key='gone.txt'")!.state,
      "active",
    );

    // 次の走査で `readdir` から消えれば、そこで墓標になる
    clock.advance(1000);
    const third = stubAdapter({
      items: [entryOf("a.txt", 5)],
      fetch: () => Promise.resolve(streamOf("alpha")),
    });
    const later = await runScan(depsFor(third), LOOSE);
    assert.equal(later.tombstonedCount, 1, "列挙から消えたのに墓標が立たない");
    assert.equal(
      one<{ state: string }>("SELECT state FROM document WHERE stable_key='gone.txt'")!.state,
      "tombstoned",
    );
  });

  it("申告と食い違うサイズは版にならず、記録に残る（#7, #20）", async () => {
    // 列挙が 99 バイトと言ったのに 5 バイトしか読めない
    const adapter = stubAdapter({
      items: [entryOf("torn.txt", 99)],
      fetch: () => Promise.resolve(streamOf("alpha")),
    });

    const report = await runScan(depsFor(adapter), LOOSE);

    assert.equal(report.status, "completed", report.abortReason);
    assert.equal(report.versionsCreatedCount, 0, "食い違うサイズが版になっている");
    assert.equal(report.distinctCount, 1, "観測そのものは成立している");
    assert.equal(observations("size_mismatch_rejected"), 1);
    assert.equal(count("document_version"), 0);

    // 2つの数が欄で残る。メッセージから取り出していたら数字が化ける
    const detail = one<{ detail: string }>(
      "SELECT detail FROM observation WHERE kind='size_mismatch_rejected'",
    )!.detail;
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    assert.equal(parsed["declaredSizeBytes"], 99);
    assert.equal(parsed["actualSizeBytes"], 5);
  });
});

describe("runScan: 観測の書き込みが失敗したとき（#16）", () => {
  it("数えて、削除判定に進まない", async () => {
    // **1件の書き込み失敗が、実在するファイルを消す形です。**
    // その1件だけ last_seen が進まないまま走査が「成功」で終わると、
    // 次の削除判定でそれが欠損に見えます
    for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(root, name), `x ${name}`);
    await runScan(depsFor(localAdapter()), LOOSE);

    clock.advance(1000);
    // **これは `SQLITE_BUSY` の模型ではありません。** 以前は "database is busy" と
    // 名乗っていましたが、本物の busy は `StoreError` ではなく、この枝に
    // 入りません（下の describe で実測。S4-11）。ここで数えているのは
    // 「ストアが1件の記録を拒んだ」ことで、拒む理由は問いません
    const failing = storeFailingOn("b.txt", new InvalidArgumentError("store rejected one record"));
    const report = await runScan({ ...depsFor(localAdapter()), store: failing }, LOOSE);

    assert.equal(report.writeFailureCount, 1, "失敗を数えていない");
    assert.equal(report.status, "aborted_safety");
    assert.equal(report.tombstonedCount, 0, "書き込み失敗のある走査が削除判定に進んでいる");
    assert.equal(report.missingCount, 0);
    assert.equal(count("document WHERE state='active'"), 3, "書けなかった1件が消えている");
    assert.equal(observations("document_tombstoned"), 0);
  });

  it("自分のコードの誤りは、書き込み失敗に化けない", async () => {
    // `StoreError` でないものまで数に入れると、**バグが「一時的な書き込み失敗」に
    // 見えます。** 走査は aborted_safety で終わり、原因はどこにも残りません
    await writeFile(join(root, "a.txt"), "alpha");
    const broken = storeFailingOn("a.txt", new TypeError("bug in my own code"));

    await assert.rejects(
      () => runScan({ ...depsFor(localAdapter()), store: broken }, LOOSE),
      /bug in my own code/,
    );
    assert.equal(count("scan_run WHERE status='running'"), 0, "running のまま塞いでいる");
    assert.equal(count("scan_run WHERE status='failed'"), 1);
  });
});

describe("runScan: 列挙そのものが続けられなくなったら閉じる", () => {
  it("走査は failed で閉じ、running のまま残らない", async () => {
    const adapter = stubAdapter({
      items: [entryOf("a.txt", 5), entryOf("b.txt", 5)],
      fetch: () => Promise.resolve(streamOf("alpha")),
      throwAfter: 1,
    });

    await assert.rejects(() => runScan(depsFor(adapter), LOOSE), /mount went away/);

    assert.equal(count("scan_run WHERE status='running'"), 0, "running のまま塞いでいる");
    assert.equal(count("scan_run WHERE status='failed'"), 1);
    // failed の走査は基準値にならず、削除判定にも進めない（#3）
    assert.equal(observations("document_tombstoned"), 0);
  });

  it("閉じられたので、次の走査が始められる", async () => {
    const broken = stubAdapter({
      items: [entryOf("a.txt", 5)],
      fetch: () => Promise.resolve(streamOf("alpha")),
      throwAfter: 0,
    });
    await assert.rejects(() => runScan(depsFor(broken), LOOSE));

    clock.advance(1000);
    await writeFile(join(root, "a.txt"), "alpha");
    const recovered = await runScan(depsFor(localAdapter()), LOOSE);
    assert.equal(recovered.status, "completed", recovered.abortReason);
    assert.equal(recovered.versionsCreatedCount, 1);
  });
});

describe("runScan: 走査が重なったとき（攻撃 #1）", () => {
  /**
   * `CompletedScanRun` はこの攻撃を防ぐために存在します（types.ts:325）。
   *
   *   「走査AとBが重なり、Bが全件 lastSeen を更新した後に遅れてAが完了して
   *    findMissingSince(A) を呼び、全件が欠損に見えた」
   *
   * 追い越しの判定は `completionSeq` で行われ、**B が completed になっていれば
   * 効きます**（AC-PRO-02 / AC-MIS-09 が固定済み）。ここで見るのは B がまだ
   * running の場合です。観測は last_seen_scan_id を動かしますが、A から見た
   * 「最新の完了走査」は A のままなので、追い越し判定は発火しません。
   */

  function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
    let open!: () => void;
    const wait = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { wait, open };
  }

  /** 削除判定の**開始だけ**を遅らせる。判定そのものには触らない */
  function pausingBeforeDeletion(reached: () => void, release: Promise<void>): LineageStore {
    return new Proxy(store, {
      get(target, property) {
        if (property === "findMissingSince") {
          return (scan: CompletedScanRun): AsyncIterable<Document> => {
            async function* paused(): AsyncIterable<Document> {
              reached();
              await release;
              for await (const document of target.findMissingSince(scan)) yield document;
            }
            return paused();
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** 観測は済ませたまま running に留める */
  function pausingBeforeFinish(reached: () => void, release: Promise<void>): LineageStore {
    return new Proxy(store, {
      get(target, property) {
        if (property === "finishScan") {
          return async (
            scanId: ScanId,
            counts: Parameters<LineageStore["finishScan"]>[1],
          ): ReturnType<LineageStore["finishScan"]> => {
            reached();
            await release;
            return target.finishScan(scanId, counts);
          };
        }
        const value = Reflect.get(target, property) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  function depsWith(adapter: SourceAdapter, using: LineageStore): ScanDependencies {
    return {
      adapter,
      store: using,
      blobs,
      pipelineVersion: "test-0",
      fallbackMimeType: "application/octet-stream",
    };
  }

  it("後から始まった走査が観測した実在ファイルを、前の走査が墓標にしない", async () => {
    await writeFile(join(root, "a.txt"), "alpha");
    await writeFile(join(root, "b.txt"), "bravo");
    await writeFile(join(root, "c.txt"), "charlie");
    const baseline = await runScan(depsFor(localAdapter()), LOOSE);
    assert.equal(baseline.status, "completed", baseline.abortReason);

    // c を消す。走査 N はこれを**正当な**欠損として見る
    await rm(join(root, "c.txt"));

    const atDeletion = gate();
    const releaseFirst = gate();
    const firstRun = runScan(
      depsWith(localAdapter(), pausingBeforeDeletion(atDeletion.open, releaseFirst.wait)),
      LOOSE,
    );
    await atDeletion.wait; // N は完了・promote 済み。削除判定の直前で止まっている

    // c が戻る。走査 N+1 が a, b, c を観測する。**completed にはしない**
    await writeFile(join(root, "c.txt"), "charlie");
    const atFinish = gate();
    const releaseSecond = gate();
    const secondRun = runScan(
      depsWith(localAdapter(), pausingBeforeFinish(atFinish.open, releaseSecond.wait)),
      LOOSE,
    );
    await atFinish.wait; // N+1 の観測は済み、last_seen は N+1。ただし running

    releaseFirst.open();
    const first = await firstRun;
    releaseSecond.open();
    const second = await secondRun;

    assert.equal(second.status, "completed", second.abortReason);
    assert.deepEqual(
      (await readdir(root)).sort(),
      ["a.txt", "b.txt", "c.txt"],
      "前提: 3件ともディスクに在る",
    );

    // **直し方は問いません。** 在るものが墓標になっていなければ通ります
    assert.equal(
      count("document WHERE state='tombstoned'"),
      0,
      `実在するファイルが墓標になった（走査Nの missing=${String(first.missingCount)} tomb=${String(first.tombstonedCount)}）`,
    );
  });
});

describe("runScan: lstat が権限で落ちたとき（POSIX）", () => {
  /**
   * `x` の無いディレクトリの中は、`readdir` は通るのに `lstat` が EACCES で
   * 落ちます。commit 6c6dac2 で塞いだ「実在するファイルを墓標にする」と同じ族で、
   * 経路が違うだけです。
   *
   * **この形は Windows では作れません**（実測: 排他ロック中のファイルも
   * ACL で拒否したファイルも `lstat` は成功する）。root でも作れません。
   * 作れるかどうかを**測ってから**進みます。推測で分岐すると、経路に
   * 入っていないことが「緑」に見えます。
   *
   * 採った扱い（commit f14f758）: **列挙に出たものは今回は墓標にしない。**
   * errno で枝を分ける案（ENOENT だけを「消えた」とする）は採りませんでした。
   * 分けると、同じ事象が「どの syscall が先に気づいたか」で観測に通るかどうかが
   * 変わります（S4-16）。ディレクトリは今のまま弁を閉じます。
   */
  it("読めないディレクトリの中の実在ファイルを、消えたものとして扱わない", async (t) => {
    await mkdir(join(root, "locked"), { recursive: true });
    await writeFile(join(root, "locked", "x.txt"), "x");
    await writeFile(join(root, "plain.txt"), "p");

    const baseline = await runScan(depsFor(localAdapter()), LOOSE);
    assert.equal(baseline.status, "completed", baseline.abortReason);
    assert.equal(baseline.distinctCount, 2, "前提: 2件とも観測できている");

    await chmod(join(root, "locked"), 0o600);
    try {
      const listable = await readdir(join(root, "locked")).then(
        (names) => names.length === 1,
        () => false,
      );
      const lstatCode = await lstat(join(root, "locked", "x.txt")).then(
        () => "ok",
        (error: unknown) => (error as NodeJS.ErrnoException).code ?? "unknown",
      );
      if (!listable || lstatCode !== "EACCES") {
        t.skip(`この環境では作れない形（readdir=${String(listable)} lstat=${lstatCode}）`);
        return;
      }

      const report = await runScan(depsFor(localAdapter()), LOOSE);

      // **主張はここ。** ディスクに在るファイルが墓標になってはいけない
      assert.equal(
        count("document WHERE state='tombstoned'"),
        0,
        `実在するファイルが墓標になった（missing=${String(report.missingCount)} tomb=${String(report.tombstonedCount)}）`,
      );
      // 「見えなかった」ではないので、弁は閉じない
      assert.equal(report.unlistableSubtreeCount, 0, "一覧はできているのに弁を閉じている");
      // 黙って落とさない。在ったが読めなかったこととして残る
      assert.equal(
        observations("document_unreadable"),
        1,
        "読めなかった事実が観測に残っていない",
      );
    } finally {
      await chmod(join(root, "locked"), 0o700);
    }
  });
});

describe("runScan: DB そのものが書けないとき（本物の SQLITE_BUSY、S4-11）", () => {
  /**
   * #16 の弁（G1）が数えるのは `StoreError` だけです。`node:sqlite` の
   * `database is locked` は `StoreError` ではないので、その枝には入りません。
   * **入らないのが正しい。** DB が書けない状態で走査を続けても、次の観測も
   * `finishScan` も同じ理由で落ちます。数えて進む相手ではありません。
   *
   * 代わりに起きるのは fail-closed の閉塞です。`failScan` も同じ理由で落ち、
   * 走査は `running` のまま残り、次の `runScan` は `concurrent_scan` で
   * 始まれません。出口はストアの `failScan` にあって、`runScan` にはありません
   * （KNOWN_LIMITATIONS 12節 #2）。ここではその形を**そのまま**固定します。
   * 形が変わったら（busy を数えるようになった、running が自動で解けるようになった）
   * 12節の記述が嘘になるので、ここで気づきます。
   */
  it("走査は running のまま残り、G1 には数えられず、次の runScan は始まれない", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scan-busy-"));
    const location = join(dir, "lineage.sqlite");
    const fileClock = new TestClock(1000);
    // busy_timeout 0 は競合再現の検査だけに許される（connection.ts）
    const fileConn = openStore({ clock: fileClock, location, busyTimeoutMs: 0 });
    const other = new DatabaseSync(location);
    try {
      other.exec("PRAGMA busy_timeout = 0");
      const fileStore = new SqliteLineageStore(fileConn);
      fileConn.db
        .prepare(
          `INSERT INTO source (source_id, kind, config_hash, display_name,
             key_unicode_form, key_case_fold, key_path_separator, key_trim_slashes)
           VALUES (?, 'local-fs', 'cfg', 'local folder', 'NFC', 0, 'posix', 1)`,
        )
        .run(SRC);
      const fileBlobs = new FileBlobStore({ root: blobRoot, clock: fileClock });
      const scanRow = () =>
        fileConn.db.prepare("SELECT scan_id, status, write_failure_count AS w FROM scan_run").get() as
          | { scan_id: string; status: string; w: number }
          | undefined;

      await writeFile(join(root, "a.txt"), "alpha");
      await writeFile(join(root, "b.txt"), "beta");

      // b.txt の fetch の直前に、別の接続が書き込みロックを握る
      const locking = (inner: SourceAdapter): SourceAdapter => ({
        descriptor: inner.descriptor,
        enumerate: () => inner.enumerate(),
        fetch: (stableKey) => {
          if (stableKey === "b.txt") other.exec("BEGIN IMMEDIATE");
          return inner.fetch(stableKey);
        },
      });
      const deps: ScanDependencies = {
        adapter: locking(localAdapter()),
        store: fileStore,
        blobs: fileBlobs,
        pipelineVersion: "test-0",
        fallbackMimeType: "application/octet-stream",
      };

      // 記録が落ち、閉じるのも落ちる。元の失敗は隠されない
      await assert.rejects(
        () => runScan(deps, LOOSE),
        (error: unknown) =>
          error instanceof AggregateError &&
          error.errors.length === 2 &&
          error.errors.every((e) => !isStoreError(e)),
        "本物の busy が StoreError に化けたか、閉じられなかった事実が隠れている",
      );

      const left = scanRow();
      assert.ok(left !== undefined);
      assert.equal(left.status, "running", "閉じられないはずの走査が閉じている");
      assert.equal(left.w, 0, "本物の busy が G1 に数えられている");
      // ロックの前に何件取り込めたかは列挙順（readdir）で決まる。数えて後で使う
      const ingestedBeforeLock = (
        fileConn.db.prepare("SELECT count(*) AS n FROM document_version").get() as { n: number }
      ).n;

      // ロックが解けても、runScan からは戻れない
      other.exec("ROLLBACK");
      await assert.rejects(
        () => runScan({ ...deps, adapter: localAdapter() }, LOOSE),
        (error: unknown) => isStoreError(error, "concurrent_scan"),
      );

      // 出口はストアにある。scanId は運用者が scan_run を引いて手に入れる
      await fileStore.failScan(
        left.scan_id as ScanId,
        "operator closed a scan left running by a locked database",
      );
      const recovered = await runScan({ ...deps, adapter: localAdapter() }, LOOSE);
      assert.equal(recovered.status, "completed", recovered.abortReason);
      assert.equal(
        recovered.versionsCreatedCount,
        2 - ingestedBeforeLock,
        "ロック前に取り込めた分まで作り直している",
      );
    } finally {
      other.close();
      fileConn.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("runScan: 2つの名前が同じ documentId に潰れるとき（stable_key_collision、S4-12）", () => {
  /**
   * NFC の `café.txt` と NFD の `café.txt` が同じディレクトリに共存する
   * （macOS/SMB 経由の NFD 名と Windows の NFC 名。S-7）。`unicodeForm: "NFC"` の
   * 下では同じ documentId です。**どちらが正かはシステムには言えません**
   * （`ObservationKind.stable_key_collision`）。
   *
   * ここで固定するのは、その入力に対して `IDEMPOTENT_REPLAY` が**何を主張し、
   * 何を主張しないか**です（KNOWN_LIMITATIONS 16節）:
   *   - 状態の表（document / document_version / active ポインタ）は一致する
   *   - 観測の種類の集合は、**初回→2回目だけ** `version_reverted` が加わる。
   *     2回目→3回目は一致する
   *
   * 1走査の中でポインタが2回動くので、2走査目は「既に `version_created` の
   * ある版」へ戻る形になり、`version_reverted` が書かれます。これは事実の
   * 記録として正しく、消すべき行ではありません。**チェッカーが違反として
   * 報告するのも正しく、ここで隠しません。**
   *
   * 両方の形を別名として保つ FS でしか作れません（APFS は畳む）。
   * 作れるかを測ってから進みます。
   */
  it("状態は一致し、観測の語彙は初回→2回目だけ version_reverted を足す", async (t) => {
    const caps = await detectFsCapabilities();
    if (!caps.preservesUnicodeForm || caps.unicodeFormsCollide) {
      t.skip("この FS は NFC と NFD を別名として保たない");
      return;
    }
    const nfc = "café.txt";
    const nfd = "café.txt";
    await writeFile(join(root, nfc), "composed");
    await writeFile(join(root, nfd), "decomposed");
    assert.equal((await readdir(root)).length, 2, "前提: 2つの名前が共存している");

    const pointer = (): string =>
      one<{ v: string | null }>("SELECT active_version_id AS v FROM document")!.v ?? "(null)";
    const kindOf = (tag: string): string => tag.split("\x00")[0] ?? tag;

    const first = await runScan(depsFor(localAdapter()), LOOSE);
    assert.equal(first.status, "completed", first.abortReason);
    assert.equal(first.enumeratedCount, 2);
    assert.equal(first.distinctCount, 1, "前提: 同じ documentId に潰れている");
    assert.equal(first.versionsCreatedCount, 2, "前提: 版は2本立つ");
    assert.equal(observations("stable_key_collision"), 1);
    const settled = pointer();

    clock.advance(1000);
    const s1 = await snapshotState(reader);
    const second = await runScan(depsFor(localAdapter()), LOOSE);
    const s2 = await snapshotState(reader);
    assert.equal(second.status, "completed", second.abortReason);
    assert.equal(second.versionsCreatedCount, 0, "同じ内容で版が増えている");
    assert.equal(pointer(), settled, "ポインタの最終位置が走査ごとに変わっている");

    // **状態は冪等。観測の語彙だけが 1→2 で増える**
    const diff12 = diffSnapshots(s1, s2);
    assert.deepEqual(diff12.rows, [], "状態の表が一致していない");
    assert.deepEqual(diff12.observationKindsAdded.map(kindOf), ["version_reverted"]);
    assert.deepEqual(diff12.observationKindsRemoved, []);
    assert.equal(observations("version_reverted"), 2, "ポインタは走査内で2回動く");

    // 本物のチェッカーはこれを違反として報告する。それ以外は緑
    const report12 = await checkInvariants({
      reader,
      blobs,
      replay: { before: s1, after: s2 },
      knownSourceIds: [SRC],
    });
    const replay12 = report12.results.find((r) => r.name === "IDEMPOTENT_REPLAY");
    assert.ok(replay12 !== undefined);
    assert.equal(replay12.status, "violated", "チェッカーが観測の語彙の差を見ていない");
    assert.deepEqual(
      replay12.findings.map((f) => f.problem),
      ["replay_state_diff_not_empty"],
    );
    assert.doesNotThrow(
      () =>
        assertInvariants(report12, [], [
          { invariant: "IDEMPOTENT_REPLAY", problem: "replay_state_diff_not_empty" },
        ]),
      "IDEMPOTENT_REPLAY 以外にも違反がある",
    );

    // 2→3 は語彙も一致する
    clock.advance(1000);
    const third = await runScan(depsFor(localAdapter()), LOOSE);
    const s3 = await snapshotState(reader);
    assert.equal(third.status, "completed", third.abortReason);
    assert.equal(pointer(), settled);
    const report23 = await checkInvariants({
      reader,
      blobs,
      replay: { before: s2, after: s3 },
      knownSourceIds: [SRC],
    });
    assert.doesNotThrow(() => assertInvariants(report23));
    assert.equal(observations("stable_key_collision"), 3, "衝突は走査ごとに1件ずつ積まれる");
  });
});

describe("runScan: 無変更の再実行で観測表だけが増える（S4-13）", () => {
  /**
   * `NO_WORK_WITHOUT_CHANGE` が数えるのは内容3表の追加行だけです
   * （`invariant-checker.ts`）。観測表は追記専用で対象外です。
   * 落としたもの（`entry_skipped`）と読めなかったもの（`document_unreadable`）は
   * **走査ごとに1行ずつ**残ります。無変更でも「その走査でも落とした・読めなかった」は
   * 新しい事実だからです。内容の枝が無変更で観測を書かないのは、版と `last_seen` が
   * 事実を運ぶからで、こちらにはそれがありません。
   *
   * ここで固定するのは増え方の上限です。鍵にできず観測に通した1件につき
   * 2行、それ以外は 0行。増え続ける形を KNOWN_LIMITATIONS 16節に載せた以上、
   * 増え方が変わったら気づきたい。
   */
  it("hardlink の対は走査ごとに +4 行。内容の表は増えず、不変条件は緑のまま", async () => {
    await writeFile(join(root, "a.txt"), "alpha");
    await writeFile(join(root, "h1.txt"), "linked");
    await link(join(root, "h1.txt"), join(root, "h2.txt"));

    const first = await runScan(depsFor(localAdapter()), LOOSE);
    assert.equal(first.status, "completed", first.abortReason);
    assert.equal(first.skippedCount, 2, "前提: hardlink の対が両方落ちている");

    const rows = (): number => count("observation");
    const baseline = rows();
    const before = await snapshotState(reader);

    for (let n = 1; n <= 3; n++) {
      clock.advance(1000);
      const report = await runScan(depsFor(localAdapter()), LOOSE);
      assert.equal(report.status, "completed", report.abortReason);
      assert.equal(report.versionsCreatedCount, 0, "無変更で版が増えている");
      assert.equal(
        rows() - baseline,
        4 * n,
        `走査 ${String(n)} 回で観測が ${String(rows() - baseline)} 行増えた（1件につき2行の上限を超えている）`,
      );
    }

    const after = await snapshotState(reader);
    assert.equal(observations("entry_skipped"), 2 * 4);
    assert.equal(observations("document_unreadable"), 2 * 4);
    assert.equal(count("document_version"), 1, "内容の表が増えている");

    // 主張どおり、内容3表だけを見る2項目は緑のまま。**緑だから増えていない、ではない**
    const report = await checkInvariants({
      reader,
      blobs,
      replay: { before, after },
      knownSourceIds: [SRC],
    });
    assert.doesNotThrow(() => assertInvariants(report));
  });
});

/**
 * C1（2026-09-11）— 削除の反映が終わらないまま `completed` になった走査。
 *
 * **`completed` は「列挙と安全弁を通った」であって「削除を反映した」ではない。**
 * `finishScan` の後、削除記録と `tombstone` は別々の書き込みとして起きるので、
 * その間の失敗で**基準値だけが進み、削除は未反映**という状態が残る。
 * 次の走査はその基準値で欠損率を測るため、入力を静止させても同じ理由で
 * `aborted_safety` になり続ける（実測: 20件中2件削除、閾値 9000/1000 で
 * 2/18 ≒ 11.1% > 10%）。ストアの口からは出られるが、`runScan` がそこへ行かない。
 *
 * 偽の例外は投げない。**本物の SQLite ロック**で書き込みを失敗させる。
 */
describe("C1: 未反映の削除は、次の走査の前に再開される", () => {
  /** 本物のロックを取る第2接続。`finishScan` が成功した直後に掛ける */
  function lockAfterFinish(dbPath: string): { store: LineageStore; release: () => void } {
    const locker = new DatabaseSync(dbPath);
    locker.exec("PRAGMA busy_timeout = 0");
    let held = false;

    const proxied = new Proxy(store, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (property !== "finishScan" || typeof value !== "function") {
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (...args: unknown[]) => {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          locker.exec("BEGIN IMMEDIATE"); // 以降の書き込みは本当に失敗する
          held = true;
          return result;
        };
      },
    });

    return {
      store: proxied,
      release: () => {
        if (held) locker.exec("ROLLBACK");
        locker.close();
      },
    };
  }

  /** ファイル DB の一式。プロセス再起動を再現するために接続を捨てられる */
  async function fileBacked(): Promise<{ dbPath: string; dispose: () => Promise<void> }> {
    const dbDir = await mkdtemp(join(tmpdir(), "scan-db-"));
    const dbPath = join(dbDir, "lineage.db");
    conn.close();
    conn = openStore({ clock, location: dbPath });
    store = new SqliteLineageStore(conn);
    conn.db
      .prepare(
        `INSERT INTO source (source_id, kind, config_hash, display_name,
           key_unicode_form, key_case_fold, key_path_separator, key_trim_slashes)
         VALUES (?, 'local-fs', 'cfg', 'local folder', 'NFC', 0, 'posix', 1)`,
      )
      .run(SRC);
    return { dbPath, dispose: async () => {
      // Windows は開いた DB を unlink できない。接続の寿命を一時領域より短くする。
      conn.close();
      await rm(dbDir, { recursive: true, force: true });
    } };
  }

  const activeCount = () => count("document WHERE state='active'");
  const deletionStates = (): string[] =>
    (
      conn.db
        .prepare("SELECT deletion_state FROM scan_run WHERE status='completed' ORDER BY completion_seq")
        .all() as Array<{ deletion_state: string }>
    ).map((r) => r.deletion_state);

  /** 20件取り込み、2件削除し、finishScan 直後にロックして走査を落とす */
  async function stickAtPendingDeletion(dbPath: string): Promise<void> {
    for (let i = 0; i < 20; i += 1) await writeFile(join(root, `f${String(i)}.txt`), `content ${String(i)}`);
    const first = await runScan(depsFor(localAdapter()), TIGHT);
    assert.equal(first.status, "completed");
    assert.equal(first.distinctCount, 20);

    await rm(join(root, "f0.txt"));
    await rm(join(root, "f1.txt"));
    clock.advance(1000);

    const lock = lockAfterFinish(dbPath);
    await assert.rejects(
      () => runScan({ ...depsFor(localAdapter()), store: lock.store }, TIGHT),
      (e: unknown) => (e as { errcode?: number }).errcode === 5, // SQLITE_BUSY
    );
    lock.release();

    assert.deepEqual(deletionStates(), ["applied", "pending"], "弁は通ったが反映が終わっていない");
    assert.equal(activeCount(), 20, "消えた2件はまだ active");
  }

  it("同じ入力の次の走査が、前回の未反映の削除を片付けてから進む", async () => {
    const db = await fileBacked();
    try {
      await stickAtPendingDeletion(db.dbPath);

      clock.advance(1000);
      const next = await runScan(depsFor(localAdapter()), TIGHT);

      // **修正前はここが aborted_safety / missing_ratio だった（2/18 > 10%）**
      assert.equal(next.status, "completed", next.abortReason);
      assert.equal(next.resumed?.applied, true);
      assert.equal(next.resumed?.tombstonedCount, 2, "前回の欠損が反映された");
      assert.equal(next.missingCount, 0, "今回の走査から見れば欠損はもう無い");
      assert.equal(activeCount(), 18);
      assert.deepEqual(deletionStates(), ["applied", "applied", "applied"]);
    } finally {
      await db.dispose();
    }
  });

  it("プロセスが落ちても再開できる。検査点は行であって変数ではない", async () => {
    const db = await fileBacked();
    try {
      await stickAtPendingDeletion(db.dbPath);

      // 接続を捨てて開き直す。**同じプロセスの続きではない**
      conn.close();
      conn = openStore({ clock, location: db.dbPath, applySchema: false });
      store = new SqliteLineageStore(conn);
      blobs = new FileBlobStore({ root: blobRoot, clock });

      clock.advance(1000);
      const next = await runScan(depsFor(localAdapter()), TIGHT);
      assert.equal(next.status, "completed", next.abortReason);
      assert.equal(next.resumed?.tombstonedCount, 2);
      assert.equal(activeCount(), 18);
    } finally {
      await db.dispose();
    }
  });

  it("再開しても、実在する文書には墓標を立てない", async () => {
    const db = await fileBacked();
    try {
      await stickAtPendingDeletion(db.dbPath);

      // 反映前に1件が戻ってくる。**戻った分は欠損ではない**
      await writeFile(join(root, "f0.txt"), "content 0");
      clock.advance(1000);

      const next = await runScan(depsFor(localAdapter()), TIGHT);
      assert.equal(next.status, "completed", next.abortReason);
      assert.equal(activeCount(), 19, "戻った1件は active のまま");
      assert.equal(
        one<{ state: string }>(
          "SELECT state FROM document WHERE stable_key='f0.txt'",
        )!.state,
        "active",
      );
      assert.equal(
        one<{ state: string }>(
          "SELECT state FROM document WHERE stable_key='f1.txt'",
        )!.state,
        "tombstoned",
        "本当に消えた1件だけが墓標になる",
      );
    } finally {
      await db.dispose();
    }
  });

  it("中断した実行と、中断しなかった実行が同じ文書状態に収束する", async () => {
    const db = await fileBacked();
    try {
      await stickAtPendingDeletion(db.dbPath);
      clock.advance(1000);
      await runScan(depsFor(localAdapter()), TIGHT);

      const interrupted = (
        conn.db
          .prepare("SELECT stable_key, state FROM document ORDER BY stable_key")
          .all() as Array<{ stable_key: string; state: string }>
      ).map((r) => `${r.stable_key}:${r.state}`);

      // 同じ入力を、一度も中断させずに最初から流した場合
      const fresh = openStore({ clock });
      const freshStore = new SqliteLineageStore(fresh);
      fresh.db
        .prepare(
          `INSERT INTO source (source_id, kind, config_hash, display_name,
             key_unicode_form, key_case_fold, key_path_separator, key_trim_slashes)
           VALUES (?, 'local-fs', 'cfg', 'local folder', 'NFC', 0, 'posix', 1)`,
        )
        .run(SRC);
      const freshRoot = await mkdtemp(join(tmpdir(), "scan-fresh-"));
      const freshBlobRoot = await mkdtemp(join(tmpdir(), "scan-fresh-blob-"));
      try {
        for (let i = 0; i < 20; i += 1) {
          await writeFile(join(freshRoot, `f${String(i)}.txt`), `content ${String(i)}`);
        }
        const freshDeps = {
          adapter: new LocalFolderSourceAdapter({ root: freshRoot, descriptor: DESCRIPTOR }),
          store: freshStore,
          blobs: new FileBlobStore({ root: freshBlobRoot, clock }),
          pipelineVersion: "test-0",
          fallbackMimeType: "application/octet-stream",
        };
        await runScan(freshDeps, TIGHT);
        await rm(join(freshRoot, "f0.txt"));
        await rm(join(freshRoot, "f1.txt"));
        clock.advance(1000);
        await runScan(freshDeps, TIGHT);

        const uninterrupted = (
          fresh.db
            .prepare("SELECT stable_key, state FROM document ORDER BY stable_key")
            .all() as Array<{ stable_key: string; state: string }>
        ).map((r) => `${r.stable_key}:${r.state}`);

        assert.deepEqual(interrupted, uninterrupted);
      } finally {
        fresh.close();
        await rm(freshRoot, { recursive: true, force: true });
        await rm(freshBlobRoot, { recursive: true, force: true });
      }
    } finally {
      await db.dispose();
    }
  });
});

/** 条件2: 運用者が DB の列や SQL を知らずに runScan から復旧する。 */
describe("条件2: 運用者の復旧指定が実際の出口へ届く", () => {
  it("走査中の別プロセスを強制終了しても、DB を開き直し公開経路で復旧できる", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scan-process-"));
    const location = join(dir, "lineage.db");
    const seed = openStore({ clock, location });
    seed.db.prepare(`INSERT INTO source (source_id, kind, config_hash, display_name,
      key_unicode_form, key_case_fold, key_path_separator, key_trim_slashes)
      VALUES (?, 'local-fs', 'cfg', 'local folder', 'NFC', 0, 'posix', 1)`).run(SRC);
    seed.close();
    const child = spawn(process.execPath, ["--import", "tsx", "--disable-warning=ExperimentalWarning",
      "--input-type=module", "-e", `
        import { openStore } from './src/store/sqlite/connection.ts';
        import { SqliteLineageStore } from './src/store/sqlite/lineage-store.ts';
        import { TestClock } from './test/support/clock.ts';
        const conn = openStore({ location: process.argv[1], clock: new TestClock(1000), applySchema: false });
        await new SqliteLineageStore(conn).beginScan(process.argv[2], { countRatioThresholdBp: 9000, missingRatioThresholdBp: 1000 });
        process.stdout.write('running');
        setInterval(() => undefined, 1000);
      `, location, SRC], { cwd: fileURLToPath(new URL("../../", import.meta.url)), stdio: ["ignore", "pipe", "pipe"] });
    try {
      const ready = once(child.stdout, "data");
      const exited = once(child, "exit");
      await Promise.race([ready, exited.then(() => { throw new Error("child exited before starting scan"); })]);
      child.kill();
      await exited;
      const reopened = openStore({ clock, location, applySchema: false });
      try {
        const restoredStore = new SqliteLineageStore(reopened);
        const running = await restoredStore.findRunningScan(SRC);
        assert.ok(running);
        const report = await runScan({ ...depsFor(localAdapter()), store: restoredStore }, TIGHT, {
          interruptedScan: { scanId: running.scanId, reason: "operator_confirmed_process_killed" },
        });
        assert.equal(report.status, "completed");
        assert.equal(await restoredStore.findRunningScan(SRC), null);
      } finally { reopened.close(); }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
  it("残留 running を source から取得し、指定した世代だけを閉じて再走査する", async () => {
    await writeFile(join(root, "a.txt"), "alpha");
    const interrupted = await store.beginScan(SRC, TIGHT);
    await assert.rejects(() => runScan(depsFor(localAdapter()), TIGHT),
      (e: unknown) => isStoreError(e, "concurrent_scan"));
    const found = await store.findRunningScan(SRC);
    assert.equal(found?.scanId, interrupted.scanId);
    assert.ok(found);
    const report = await runScan(depsFor(localAdapter()), TIGHT, {
      interruptedScan: { scanId: found.scanId, reason: "operator_confirmed_process_stopped" },
    });
    assert.equal(report.status, "completed");
    assert.equal(report.recoveredScanId, interrupted.scanId);
    assert.equal(await store.findRunningScan(SRC), null);
    assert.equal(await store.promoteToCompleted(interrupted.scanId), null);
    const state = await snapshotState(reader);
    await runScan(depsFor(localAdapter()), TIGHT);
    assert.deepEqual(await snapshotState(reader), state);
  });

  it("古い復旧指定は新しい running を閉じない", async () => {
    const old = await store.beginScan(SRC, TIGHT);
    await store.failScan(old.scanId, "stopped");
    const current = await store.beginScan(SRC, TIGHT);
    await assert.rejects(() => runScan(depsFor(localAdapter()), TIGHT, {
      interruptedScan: { scanId: old.scanId, reason: "stale_operator_view" },
    }), (e: unknown) => isStoreError(e, "invalid_argument"));
    assert.equal((await store.findRunningScan(SRC))?.scanId, current.scanId);
  });

  it("壊れた blob は明示した再走査で検証付き修復され、内容の表は変わらない", async () => {
    await writeFile(join(root, "a.txt"), "alpha");
    await runScan(depsFor(localAdapter()), TIGHT);
    const before = await snapshotState(reader);
    const version = one<{ blob_key: BlobKey }>("SELECT blob_key FROM document_version")!;
    await writeFile(blobPath(blobRoot, version.blob_key), "broken");
    await assert.rejects(() => runScan(depsFor(localAdapter()), TIGHT),
      (e: unknown) => isStoreError(e, "blob_divergence"));
    const repaired = await runScan(depsFor(localAdapter()), TIGHT, { repairCorruptBlobs: true });
    assert.equal(repaired.status, "completed");
    assert.equal(repaired.repairedBlobCount, 1);
    assert.equal(repaired.versionsCreatedCount, 0);
    assert.deepEqual(await snapshotState(reader), before);
    assertInvariants(await checkInvariants({ reader, blobs, knownSourceIds: [SRC] }));
    assert.equal((await runScan(depsFor(localAdapter()), TIGHT)).repairedBlobCount, 0);
  });

  it("修復の再取得で内容が変われば、その鍵への上書きを拒む", async () => {
    await writeFile(join(root, "a.txt"), "alpha");
    await runScan(depsFor(localAdapter()), TIGHT);
    const version = one<{ blob_key: BlobKey }>("SELECT blob_key FROM document_version")!;
    await writeFile(blobPath(blobRoot, version.blob_key), "broken");
    let fetches = 0;
    const changing = stubAdapter({ items: [entryOf("a.txt", 5)],
      fetch: async () => streamOf(++fetches === 1 ? "alpha" : "other") });
    await assert.rejects(() => runScan(depsFor(changing), TIGHT, { repairCorruptBlobs: true }),
      (e: unknown) => isStoreError(e, "invalid_argument"));
    assert.equal(fetches, 2);
    assert.equal(count("document_version"), 1);
  });

  async function shrink(): Promise<void> {
    for (let i = 0; i < 4; i++) await writeFile(join(root, `${i}.txt`), `body${i}`);
    await runScan(depsFor(localAdapter()), TIGHT);
    await rm(join(root, "0.txt"));
    assert.equal((await runScan(depsFor(localAdapter()), TIGHT)).status, "aborted_safety");
  }

  it("弁が正当に鳴った source は、列挙結果を確認して欠損1件まで承認できる", async () => {
    await shrink();
    let reviewed = false;
    const report = await runScan(depsFor(localAdapter()), TIGHT, {
      reviewSafety: async (review) => {
        assert.equal(review.distinctCount, 3);
        assert.equal(review.previousDistinctCount, 4);
        assert.equal(review.missingCount, 1);
        reviewed = true;
        return { note: "operator_checked_one_removal", maxMissingCount: 1 };
      },
    });
    assert.equal(reviewed, true);
    assert.equal(report.status, "completed");
    assert.equal(report.tombstonedCount, 1);
    assert.equal(count("document WHERE state='active'"), 3);
    assert.equal((await runScan(depsFor(localAdapter()), TIGHT)).status, "completed");
  });

  it("承認の欠損上限を超える空 source は止まり、墓標を1件も立てない", async () => {
    await shrink();
    for (let i = 1; i < 4; i++) await rm(join(root, `${i}.txt`));
    const report = await runScan(depsFor(localAdapter()), TIGHT, {
      reviewSafety: async (review) => {
        assert.equal(review.missingCount, 4);
        return { note: "only_one_removal_authorized", maxMissingCount: 1 };
      },
    });
    assert.equal(report.status, "aborted_safety");
    assert.ok(report.abortReason?.includes("approval_missing_limit"));
    assert.equal(report.tombstonedCount, 0);
    assert.equal(count("document WHERE state='active'"), 4);
  });

  it("一覧不能は承認の callback でも免除されない", async () => {
    await shrink();
    const adapter = stubAdapter({ items: [{ kind: "unlistable_subtree", subtreeKey: "locked", errorKind: "EACCES" }],
      fetch: async () => streamOf("") });
    const report = await runScan(depsFor(adapter), TIGHT, {
      reviewSafety: async () => ({ note: "cannot_override_unlistable", maxMissingCount: 4 }),
    });
    assert.equal(report.status, "aborted_safety");
    assert.equal(report.abortReason, "unlistable_subtree");
    assert.equal(report.tombstonedCount, 0);
  });

  it("書き込み失敗は承認の callback でも免除されない", async () => {
    await writeFile(join(root, "a.txt"), "alpha");
    const report = await runScan({ ...depsFor(localAdapter()),
      store: storeFailingOn("a.txt", new InvalidArgumentError("record rejected")) }, TIGHT, {
      reviewSafety: async (review) => {
        assert.equal(review.writeFailureCount, 1);
        return { note: "cannot_override_missing_write", maxMissingCount: 1 };
      },
    });
    assert.equal(report.status, "aborted_safety");
    assert.equal(report.abortReason, "write_failures");
  });

  it("承認の callback が失敗しても走査は failed で閉じ、次の走査を塞がない", async () => {
    await assert.rejects(() => runScan(depsFor(localAdapter()), TIGHT, {
      reviewSafety: async () => { throw new Error("operator disconnected"); },
    }), /operator disconnected/);
    assert.equal(await store.findRunningScan(SRC), null);
    assert.equal((await runScan(depsFor(localAdapter()), TIGHT)).status, "completed");
  });
});

describe("条件4: 保存先の失敗の表示", () => {
  it("本物の SQLITE_BUSY は enumeration_failed と記録されない", async () => {
    const dir = await mkdtemp(join(tmpdir(), "scan-reason-"));
    const location = join(dir, "lineage.db");
    const fileConn = openStore({ clock, location, busyTimeoutMs: 0 });
    const locker = new DatabaseSync(location);
    try {
      fileConn.db.prepare(`INSERT INTO source (source_id, kind, config_hash, display_name,
        key_unicode_form, key_case_fold, key_path_separator, key_trim_slashes)
        VALUES (?, 'local-fs', 'cfg', 'local folder', 'NFC', 0, 'posix', 1)`).run(SRC);
      const target = new SqliteLineageStore(fileConn);
      const locked = new Proxy(target, { get(object, property) {
        if (property === "recordObservedDocument") return async (id: ScanId, entry: ObservedEntry) => {
          locker.exec("BEGIN IMMEDIATE");
          try { return await object.recordObservedDocument(id, entry); }
          finally { locker.exec("ROLLBACK"); }
        };
        const value = Reflect.get(object, property) as unknown;
        return typeof value === "function" ? value.bind(object) : value;
      } });
      await writeFile(join(root, "a.txt"), "alpha");
      await assert.rejects(() => runScan({ ...depsFor(localAdapter()), store: locked }, TIGHT),
        (e: unknown) => (e as { errcode?: number }).errcode === 5);
      assert.equal(fileConn.db.prepare("SELECT abort_reason FROM scan_run").get()?.abort_reason, "ERR_SQLITE_ERROR");
    } finally {
      locker.close(); fileConn.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
