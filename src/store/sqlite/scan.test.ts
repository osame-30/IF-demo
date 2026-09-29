/**
 * AC-BEG-01..06 / AC-OBS-01..06
 *
 * 受け入れ条件はすべて SQL か等値比較で真偽が決まる形にしてあります。
 * エラーは `code` で判定し、メッセージ文字列を読みません。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { openStore, type StoreConnection } from "./connection.ts";
import { SqliteLineageStore } from "./lineage-store.ts";
import { TestClock } from "../../../test/support/clock.ts";
import { isStoreError } from "../../domain/errors.ts";
import { __unsafeObservationKind } from "../../../test/support/unsafe-brands.ts";
import { documentId as deriveDocumentId } from "../../domain/ids.ts";
import { attestContentHash } from "../../domain/evidence.ts";
import { snapshotState, diffSnapshots, isEmptyDiff } from "../../../test/support/state-snapshot.ts";
import type { SnapshotReader } from "../../../test/support/state-snapshot.ts";
import type { ScanId, SourceId, ObservedEntry } from "../../domain/types.ts";

let clock: TestClock;
let conn: StoreConnection;
let store: SqliteLineageStore;
let reader: SnapshotReader;

const SRC = "src1" as SourceId;
const BP = { countRatioThresholdBp: 9000, missingRatioThresholdBp: 1000 };
const POLICY = {
  unicodeForm: "NFC",
  caseFold: false,
  pathSeparator: "posix",
  trimSlashes: true,
} as const;

const q = <T = Record<string, unknown>>(sql: string, ...p: unknown[]): T[] =>
  conn.db.prepare(sql).all(...(p as never[])) as T[];
const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]): T | undefined =>
  conn.db.prepare(sql).get(...(p as never[])) as T | undefined;
const count = (sql: string, ...p: unknown[]): number =>
  (one<{ n: number }>(`SELECT count(*) AS n FROM ${sql}`, ...p) ?? { n: -1 }).n;

function addSource(id: string, over: Partial<Record<string, unknown>> = {}): void {
  conn.db
    .prepare(
      `INSERT INTO source (source_id, kind, config_hash, display_name,
         key_unicode_form, key_case_fold, key_path_separator, key_trim_slashes)
       VALUES (?, 'local-fs', 'cfg', ?, ?, ?, 'posix', 1)`,
    )
    .run(
      id,
      id,
      String(over["key_unicode_form"] ?? "NFC"),
      Number(over["key_case_fold"] ?? 0),
    );
}

/** 完了済みの走査を1つ作る。基準値の準備用 */
async function completedScan(distinct: number, seq: number): Promise<ScanId> {
  const scan = await store.beginScan(SRC, BP);
  conn.db
    .prepare(
      `UPDATE scan_run SET status='completed', finished_at=?, distinct_count=?,
         enumerated_count=?, completion_seq=?, deletion_state='applied' WHERE scan_id=?`,
    )
    .run(clock.now(), distinct, distinct, seq, scan.scanId);
  return scan.scanId;
}

/**
 * 実在するバイト列のハッシュを使う。**固定文字列を hex に見せかけない。**
 *
 * 以前は `"h1"` をそのまま `contentHash` に入れていました。生 SQL で
 * seed する側も `"h1"` だったので、**作り物どうしが一致していただけ**です。
 * ラベルは残しつつ、値は実バイト列から計算します。
 */
const hashOf = (label: string) => attestContentHash(Buffer.from(label, "utf8"));

const content = (label: string, size = 3): ObservedEntry["outcome"] => ({
  kind: "content",
  contentHash: hashOf(label),
  sizeBytes: size,
});

beforeEach(() => {
  clock = new TestClock(1000);
  conn = openStore({ clock });
  store = new SqliteLineageStore(conn);
  reader = { all: (sql) => Promise.resolve(conn.db.prepare(sql).all()) };
  addSource("src1");
});

afterEach(() => conn.close());

describe("beginScan", () => {
  it("AC-BEG-01: running な走査が1件になる", async () => {
    await store.beginScan(SRC, BP);
    assert.equal(count("scan_run WHERE source_id=? AND status='running'", SRC), 1);
  });

  it("AC-BEG-02: 既に running があれば ConcurrentScanError。状態は変わらない", async () => {
    await store.beginScan(SRC, BP);
    const before = await snapshotState(reader);
    const scansBefore = count("scan_run");

    await assert.rejects(
      () => store.beginScan(SRC, BP),
      (e: unknown) => isStoreError(e, "concurrent_scan"),
    );

    assert.equal(count("scan_run"), scansBefore, "走査行が増えていない");
    assert.ok(isEmptyDiff(diffSnapshots(before, await snapshotState(reader))));
  });

  it("AC-BEG-03: 直近の completed 走査を基準にする", async () => {
    const p = await completedScan(120, 1);
    const scan = await store.beginScan(SRC, BP);
    assert.equal(scan.previousCompletedScanId, p);
    assert.equal(scan.previousDistinctCount, 120);
  });

  it("AC-BEG-04: failed は基準値になれない（#3）", async () => {
    const p = await completedScan(10000, 1);
    // マウント半死で120件しか取れずに失敗した走査
    const failed = await store.beginScan(SRC, BP);
    conn.db
      .prepare(
        `UPDATE scan_run SET status='failed', finished_at=?,
           enumerated_count=120, distinct_count=120 WHERE scan_id=?`,
      )
      .run(clock.now(), failed.scanId);

    const scan = await store.beginScan(SRC, BP);
    assert.equal(scan.previousCompletedScanId, p, "failed ではなく completed を基準にする");
    assert.equal(scan.previousDistinctCount, 10000, "120 を基準にすると 9880 件が誤 tombstone される");
  });

  it("AC-BEG-05: completed が1件もなければ基準は NULL / 0", async () => {
    const scan = await store.beginScan(SRC, BP);
    assert.equal(scan.previousCompletedScanId, undefined);
    assert.equal(scan.previousDistinctCount, 0);
  });

  it("AC-BEG-06: 別 source なら同時に開始できる（排他は source 単位）", async () => {
    addSource("src2");
    await store.beginScan(SRC, BP);
    await store.beginScan("src2" as SourceId, BP);
    assert.equal(count("scan_run WHERE status='running'"), 2);
  });

  it("最新完了は completion_seq で選ぶ（finished_at が同値でも一意に決まる）", async () => {
    // 固定時計なので finished_at は全部同じ。seq だけが順序を持つ
    await completedScan(100, 1);
    const later = await completedScan(200, 2);
    const scan = await store.beginScan(SRC, BP);
    assert.equal(scan.previousCompletedScanId, later);
    assert.equal(scan.previousDistinctCount, 200);
    assert.equal(count("scan_run WHERE finished_at=?", clock.now()), 2, "前提: 完了時刻は同値");
  });

  it("走査は running かつ未完了で始まる", async () => {
    const scan = await store.beginScan(SRC, BP);
    assert.equal(scan.status, "running");
    assert.equal(scan.finishedAt, undefined);
    assert.equal(scan.completionSeq, undefined);
    assert.equal(scan.writeFailureCount, 0);
    assert.equal(scan.startedAt, 1000);
  });

  it("閾値は bp 整数のみ。小数と範囲外を拒む（B-6）", async () => {
    for (const bad of [0.9, -1, 10001, Number.NaN]) {
      await assert.rejects(
        () => store.beginScan(SRC, { ...BP, countRatioThresholdBp: bad }),
        (e: unknown) => isStoreError(e, "invalid_argument"),
      );
    }
    assert.equal(count("scan_run"), 0, "拒否時に1行も書かない");
  });

  it("未知の source を拒む", async () => {
    await assert.rejects(
      () => store.beginScan("nope" as SourceId, BP),
      (e: unknown) => isStoreError(e, "invalid_argument"),
    );
  });
});

/**
 * AC-FAIL-01..05
 *
 * `failScan` が無かった頃、クラッシュした走査は `running` のまま残り、
 * `idx_one_running_scan` によってその source では二度と `beginScan` できませんでした。
 * 「安全に閉じる手段が無い」のは fail-closed ではなく、ただの閉塞です。
 */
describe("failScan", () => {
  it("AC-FAIL-01: running を failed にする。完了順には並ばない", async () => {
    const scan = await store.beginScan(SRC, BP);
    clock.advance(500);
    const failed = await store.failScan(scan.scanId, "mount_lost");

    assert.equal(failed.status, "failed");
    assert.equal(failed.finishedAt, 1500);
    assert.equal(failed.completionSeq, undefined, "失敗した走査は完了順に並ばない");
    assert.equal(failed.abortReason, "mount_lost");
  });

  it("AC-FAIL-02: failed は次回の基準値にならない（#3）", async () => {
    await completedScan(120, 1);
    const halfDead = await store.beginScan(SRC, BP);
    await store.recordObservedDocument(halfDead.scanId, { stableKey: "a.txt", outcome: content("h1") });
    await store.failScan(halfDead.scanId, "mount_lost");

    const next = await store.beginScan(SRC, BP);
    assert.equal(next.previousDistinctCount, 120, "半死の走査の件数を基準にしない");
  });

  it("AC-FAIL-03: failed にすれば次の走査を開始できる（閉塞が解ける）", async () => {
    const stuck = await store.beginScan(SRC, BP);
    await assert.rejects(
      () => store.beginScan(SRC, BP),
      (e: unknown) => isStoreError(e, "concurrent_scan"),
      "前提: running が残っている間は開始できない",
    );

    await store.failScan(stuck.scanId, "process_crashed");
    const next = await store.beginScan(SRC, BP);
    assert.equal(next.status, "running");
    assert.equal(count("scan_run WHERE status='running'"), 1);
  });

  it("AC-FAIL-04: failed の走査からは削除判定に進めない", async () => {
    const scan = await store.beginScan(SRC, BP);
    await store.failScan(scan.scanId, "mount_lost");
    assert.equal(await store.promoteToCompleted(scan.scanId), null);
    assert.equal(count("observation WHERE kind='document_tombstoned'"), 0);
  });

  it("AC-FAIL-05: 理由のない失敗と、running でない走査を拒む。1行も書かない", async () => {
    const scan = await store.beginScan(SRC, BP);
    const before = await snapshotState(reader);

    for (const bad of ["", "   "]) {
      await assert.rejects(
        () => store.failScan(scan.scanId, bad),
        (e: unknown) => isStoreError(e, "invalid_argument"),
      );
    }
    assert.equal(
      one<{ status: string }>("SELECT status FROM scan_run WHERE scan_id=?", scan.scanId)!.status,
      "running",
      "拒否時に状態が変わっていない",
    );
    assert.ok(isEmptyDiff(diffSnapshots(before, await snapshotState(reader))));

    await store.failScan(scan.scanId, "mount_lost");
    await assert.rejects(
      () => store.failScan(scan.scanId, "again"),
      (e: unknown) => isStoreError(e, "scan_not_running"),
      "終わった走査を二度と閉じ直せない",
    );
    await assert.rejects(
      () => store.failScan("nope" as ScanId, "mount_lost"),
      (e: unknown) => isStoreError(e, "scan_not_running"),
    );
  });

  it("完了した走査を failed に書き換えられない（完了の取り消しではない）", async () => {
    const scan = await store.beginScan(SRC, BP);
    await store.finishScan(scan.scanId, {
      enumeratedCount: 0,
      distinctCount: 0,
      writeFailureCount: 0,
    });
    await assert.rejects(
      () => store.failScan(scan.scanId, "changed my mind"),
      (e: unknown) => isStoreError(e, "scan_not_running"),
    );
  });
});

/**
 * AC-BEG-07 — 一覧できなかった部分木は、削除判定への門を閉じる。
 *
 * `enumerate` が返せるのは「見えたファイル1件」だけです。ディレクトリを
 * 開けなかったという事実には型の上に置き場所がなく、実装者に残されていたのは
 * 「例外で走査全体を止める」か「黙って飛ばす」の二択でした。
 * 後者を選ぶと、**消えていない文書が閾値以下の欠損として tombstone になります。**
 *
 * `write_failure_count` と同じ側に置きます。どちらも「観測そのものが欠けている」
 * ので、比率を計算しても意味がありません。
 */
describe("recordUnlistableSubtree（AC-BEG-07）", () => {
  it("記録すると件数が積まれ、どこが見えなかったかが observation に残る", async () => {
    const scan = await store.beginScan(SRC, BP);
    await store.recordUnlistableSubtree(scan.scanId, {
      subtreeKey: "restricted/inner",
      errorKind: "EPERM",
    });

    assert.equal(
      one<{ n: number }>("SELECT unlistable_subtree_count AS n FROM scan_run WHERE scan_id=?", scan.scanId)!.n,
      1,
    );
    // 件数だけでは「どこを見ていないのか」が残らない
    const rows = q<{ detail: string }>("SELECT detail FROM observation WHERE kind='subtree_unlistable'");
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0]!.detail), {
      subtreeKey: "restricted/inner",
      errorKind: "EPERM",
    });
  });

  it("1件でもあれば安全弁が通らない。理由は名前で残る", async () => {
    await completedScan(10, 1);
    const scan = await store.beginScan(SRC, BP);
    await store.recordUnlistableSubtree(scan.scanId, { subtreeKey: "sub", errorKind: "EACCES" });

    // 件数だけ見れば健全。10件中10件を数えており、欠損もゼロ
    const finished = await store.finishScan(scan.scanId, {
      enumeratedCount: 10,
      distinctCount: 10,
      writeFailureCount: 0,
    });
    assert.equal(finished.status, "aborted_safety");
    const reasons = one<{ abort_reason: string }>(
      "SELECT abort_reason FROM scan_run WHERE scan_id=?",
      scan.scanId,
    )!.abort_reason.split(",");
    assert.ok(reasons.includes("unlistable_subtree"), `理由: ${reasons.join(",")}`);
    // 比率の理由は立てない。見えなかった範囲について比率は述べられない
    assert.ok(!reasons.includes("count_ratio"));
    assert.ok(!reasons.includes("missing_ratio"));
  });

  it("**承認では免除されない。** 見えなかった範囲は運用者の確信では埋まらない", async () => {
    await completedScan(10, 1);
    const scan = await store.beginScan(SRC, BP);
    await store.recordUnlistableSubtree(scan.scanId, { subtreeKey: "sub", errorKind: "EACCES" });
    await store.approveScan(scan.scanId, "operator checked the directory by hand", 10);

    const finished = await store.finishScan(scan.scanId, {
      enumeratedCount: 10,
      distinctCount: 10,
      writeFailureCount: 0,
    });
    assert.equal(finished.status, "aborted_safety", "承認で通ってしまっている");
    // 承認が「効いた」ことの記録も残らない
    assert.equal(count("observation WHERE kind='scan_approved_by_operator'"), 0);
  });

  it("削除判定へ進めない", async () => {
    await completedScan(10, 1);
    const scan = await store.beginScan(SRC, BP);
    await store.recordUnlistableSubtree(scan.scanId, { subtreeKey: "sub", errorKind: "EPERM" });
    await store.finishScan(scan.scanId, {
      enumeratedCount: 10,
      distinctCount: 10,
      writeFailureCount: 0,
    });
    assert.equal(await store.promoteToCompleted(scan.scanId), null);
  });

  it("記録が無ければ従来どおり completed になる（この検査が空振りしていない）", async () => {
    // 上の3件は「finishScan が常に aborted になる」でも緑になります
    await completedScan(10, 1);
    const scan = await store.beginScan(SRC, BP);
    const finished = await store.finishScan(scan.scanId, {
      enumeratedCount: 10,
      distinctCount: 10,
      writeFailureCount: 0,
    });
    assert.equal(finished.status, "completed");
  });

  it("どこが・なぜ が空の記録は拒む。1行も書かない", async () => {
    const scan = await store.beginScan(SRC, BP);
    const before = await snapshotState(reader);
    for (const bad of [
      { subtreeKey: "  ", errorKind: "EPERM" },
      { subtreeKey: "sub", errorKind: "" },
    ]) {
      await assert.rejects(
        () => store.recordUnlistableSubtree(scan.scanId, bad),
        (error: unknown) => isStoreError(error, "invalid_argument"),
      );
    }
    assert.ok(isEmptyDiff(diffSnapshots(before, await snapshotState(reader))));
    assert.equal(
      one<{ n: number }>("SELECT unlistable_subtree_count AS n FROM scan_run WHERE scan_id=?", scan.scanId)!.n,
      0,
    );
  });

  it("running でない走査への記録は throw する", async () => {
    const scan = await store.beginScan(SRC, BP);
    await store.failScan(scan.scanId, "aborted by operator");
    await assert.rejects(
      () => store.recordUnlistableSubtree(scan.scanId, { subtreeKey: "sub", errorKind: "EPERM" }),
      (error: unknown) => isStoreError(error, "scan_not_running"),
    );
  });
});

describe("recordObservedDocument", () => {
  let scanId: ScanId;
  beforeEach(async () => {
    scanId = (await store.beginScan(SRC, BP)).scanId;
  });

  const lastSeen = (id: string) =>
    one<{ last_seen_scan_id: string; last_seen_at: number; state: string; tombstoned_at: number | null }>(
      "SELECT last_seen_scan_id, last_seen_at, state, tombstoned_at FROM document WHERE document_id=?",
      id,
    )!;

  it("AC-OBS-01: 新規観測は firstSeen == lastSeen、scanId が入る", async () => {
    const r = await store.recordObservedDocument(scanId, {
      stableKey: "a.txt",
      outcome: content("h1"),
    });
    assert.equal(r.created, true);
    assert.equal(r.revived, false);

    const row = one<{ first_seen_at: number; last_seen_at: number; last_seen_scan_id: string }>(
      "SELECT first_seen_at, last_seen_at, last_seen_scan_id FROM document WHERE document_id=?",
      r.documentId,
    )!;
    assert.equal(row.first_seen_at, 1000);
    assert.equal(row.last_seen_at, 1000);
    assert.equal(row.last_seen_scan_id, scanId);
  });

  it("documentId はストアが導出する（呼び出し側は渡せない / #23）", async () => {
    const r = await store.recordObservedDocument(scanId, {
      stableKey: "/a.txt/",
      outcome: content("h1"),
    });
    // trimSlashes ポリシーが適用された鍵から導出される（#6）
    assert.equal(r.documentId, deriveDocumentId(SRC, "a.txt", POLICY));
  });

  it("AC-OBS-02: 再観測で firstSeen は不変、lastSeen だけ進む", async () => {
    const r = await store.recordObservedDocument(scanId, { stableKey: "a.txt", outcome: content("h1") });

    conn.db.prepare("UPDATE scan_run SET status='completed', finished_at=?, completion_seq=1, deletion_state='applied' WHERE scan_id=?")
      .run(clock.now(), scanId);
    clock.advance(5000);
    const scan2 = await store.beginScan(SRC, BP);
    const r2 = await store.recordObservedDocument(scan2.scanId, { stableKey: "a.txt", outcome: content("h1") });

    assert.equal(r2.documentId, r.documentId);
    assert.equal(r2.created, false);
    const row = one<{ first_seen_at: number; last_seen_at: number; last_seen_scan_id: string }>(
      "SELECT first_seen_at, last_seen_at, last_seen_scan_id FROM document WHERE document_id=?",
      r.documentId,
    )!;
    assert.equal(row.first_seen_at, 1000);
    assert.equal(row.last_seen_at, 6000);
    assert.equal(row.last_seen_scan_id, scan2.scanId);
  });

  it("同じ走査で別の鍵が同じ documentId に潰れたら記録する（S-17）", async () => {
    // 正規化は単射ではない。#23 の防御（同じ物理ファイルを1つの ID にする）が、
    // そのまま「別ファイルが1つの ID になる」形を作る。どちらが勝つかは
    // 列挙順で決まるので、勝者を決めるのではなく潰れたことを残す
    addSource("cf", { key_case_fold: 1 });
    const scan = await store.beginScan("cf" as SourceId, BP);
    const first = await store.recordObservedDocument(scan.scanId, {
      stableKey: "Report.txt",
      outcome: content("a"),
    });
    assert.equal(count("observation WHERE kind='stable_key_collision'"), 0, "1件目では鳴らない");

    const second = await store.recordObservedDocument(scan.scanId, {
      stableKey: "REPORT.TXT",
      outcome: content("b"),
    });
    assert.equal(second.documentId, first.documentId, "前提: 同じ documentId に潰れている");

    const rows = q<{ detail: string }>(
      "SELECT detail FROM observation WHERE kind='stable_key_collision'",
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(JSON.parse(rows[0]!.detail), {
      existingStableKey: "Report.txt",
      incomingStableKey: "REPORT.TXT",
    });
    // document は1行のまま。潰れていること自体は変えない
    assert.equal(count("document WHERE source_id='cf'"), 1);
  });

  it("走査をまたいだ改名は衝突ではない（S-18 と混ざらない）", async () => {
    // 別々の走査で Report.txt -> report.txt と改名されただけなら、
    // 同時に2つ在ったわけではないので衝突ではない
    addSource("cf", { key_case_fold: 1 });
    const scan1 = await store.beginScan("cf" as SourceId, BP);
    await store.recordObservedDocument(scan1.scanId, {
      stableKey: "Report.txt",
      outcome: content("a"),
    });
    await store.finishScan(scan1.scanId, {
      enumeratedCount: 1,
      distinctCount: 1,
      writeFailureCount: 0,
    });

    clock.advance(1000);
    const scan2 = await store.beginScan("cf" as SourceId, BP);
    await store.recordObservedDocument(scan2.scanId, {
      stableKey: "report.txt",
      outcome: content("a"),
    });
    assert.equal(count("observation WHERE kind='stable_key_collision'"), 0);
  });

  it("stable_key は観測ごとに上書きされる（接続元が報告した生の鍵であり続ける）", async () => {
    // caseFold:true の source では Report.txt と report.txt が同じ documentId に
    // なる。以前は INSERT 時にしか stable_key を書いていなかったので、改名後も
    // 古い値が残り、Document.stableKey が「接続元が報告した鍵」でなくなっていた
    addSource("cf", { key_case_fold: 1 });
    const scan1 = await store.beginScan("cf" as SourceId, BP);
    const first = await store.recordObservedDocument(scan1.scanId, {
      stableKey: "Report.txt",
      outcome: content("report body"),
    });
    assert.equal(
      one<{ stable_key: string }>("SELECT stable_key FROM document WHERE document_id=?", first.documentId)!
        .stable_key,
      "Report.txt",
    );
    await store.finishScan(scan1.scanId, {
      enumeratedCount: 1,
      distinctCount: 1,
      writeFailureCount: 0,
    });

    // 改名。同じ物理ファイルなので documentId は動かない
    clock.advance(1000);
    const scan2 = await store.beginScan("cf" as SourceId, BP);
    const second = await store.recordObservedDocument(scan2.scanId, {
      stableKey: "report.txt",
      outcome: content("report body"),
    });
    assert.equal(second.documentId, first.documentId, "documentId は正規化値から導くので動かない");
    assert.equal(
      one<{ stable_key: string }>("SELECT stable_key FROM document WHERE document_id=?", first.documentId)!
        .stable_key,
      "report.txt",
      "古い鍵が残っている",
    );
    // 行は増えていない。UNIQUE (source_id, stable_key) とも衝突しない
    assert.equal(count("document WHERE source_id='cf'"), 1);
  });

  it("AC-OBS-03: running でない走査への記録は throw。状態は変わらない", async () => {
    conn.db.prepare("UPDATE scan_run SET status='completed', finished_at=?, completion_seq=1, deletion_state='applied' WHERE scan_id=?")
      .run(clock.now(), scanId);
    const before = await snapshotState(reader);

    await assert.rejects(
      () => store.recordObservedDocument(scanId, { stableKey: "a.txt", outcome: content("h1") }),
      (e: unknown) => isStoreError(e, "scan_not_running"),
    );
    assert.ok(isEmptyDiff(diffSnapshots(before, await snapshotState(reader))));
    assert.equal(count("document"), 0);
  });

  it("存在しない走査への記録も throw", async () => {
    await assert.rejects(
      () => store.recordObservedDocument("nope" as ScanId, { stableKey: "a.txt", outcome: content("h1") }),
      (e: unknown) => isStoreError(e, "scan_not_running"),
    );
  });

  it("AC-OBS-04: 書き込みが失敗したら throw する（戻り値で表さない / #16）", async () => {
    // kind の CHECK に触れる形で書き込みを失敗させる
    await assert.rejects(() =>
      store.appendObservation({ kind: __unsafeObservationKind("bogus"), detail: {} }),
    );
    // 観測そのものも、DB を読み取り専用にすれば throw する
    conn.db.exec("PRAGMA query_only = ON");
    await assert.rejects(() =>
      store.recordObservedDocument(scanId, { stableKey: "a.txt", outcome: content("h1") }),
    );
    conn.db.exec("PRAGMA query_only = OFF");
    assert.equal(count("document"), 0);
  });

  it("AC-OBS-05: tombstone された文書の再観測で復活し、tombstonedAt が消える（#25）", async () => {
    const r = await store.recordObservedDocument(scanId, { stableKey: "a.txt", outcome: content("h1") });
    conn.db
      .prepare("UPDATE document SET state='tombstoned', tombstoned_at=? WHERE document_id=?")
      .run(clock.now(), r.documentId);

    clock.advance(1000);
    const again = await store.recordObservedDocument(scanId, { stableKey: "a.txt", outcome: content("h1") });

    assert.equal(again.revived, true);
    const row = lastSeen(r.documentId);
    assert.equal(row.state, "active");
    assert.equal(row.tombstoned_at, null);
    assert.equal(count("observation WHERE kind='document_revived' AND document_id=?", r.documentId), 1);

    // detail は構造化された値だけ。人間可読の文だと機械判定できない
    const detail = one<{ detail: string }>(
      "SELECT detail FROM observation WHERE kind='document_revived'",
    )!.detail;
    assert.deepEqual(JSON.parse(detail), {});

    // 順序は observation_seq。occurred_at は固定時計だと同値になりうるし、
    // observation_id は UUIDv4 で整列できない
    const order = q<{ kind: string }>("SELECT kind FROM observation ORDER BY observation_seq").map(
      (o) => o.kind,
    );
    assert.deepEqual(order, ["document_discovered", "document_revived"], "発見が先、復活が後");
  });

  it("AC-OBS-06: 復活すると confirmed_rename が needs_recheck に戻る（#25）", async () => {
    const a = await store.recordObservedDocument(scanId, { stableKey: "a.txt", outcome: content("h1") });
    const b = await store.recordObservedDocument(scanId, { stableKey: "b.txt", outcome: content("h1") });
    conn.db
      .prepare(
        `INSERT INTO rename_candidate
           (disappeared_document_id, appeared_document_id, content_hash, observed_at, resolution)
         VALUES (?, ?, 'h1', ?, 'confirmed_rename')`,
      )
      .run(a.documentId, b.documentId, clock.now());
    conn.db
      .prepare("UPDATE document SET state='tombstoned', tombstoned_at=? WHERE document_id=?")
      .run(clock.now(), a.documentId);

    await store.recordObservedDocument(scanId, { stableKey: "a.txt", outcome: content("h1") });

    const row = one<{ resolution: string }>("SELECT resolution FROM rename_candidate")!;
    assert.equal(row.resolution, "needs_recheck");
    assert.equal(count("observation WHERE kind='rename_needs_recheck'"), 1);

    // 差し戻した件数だけを持つ。理由の文章は入れない
    const detail = JSON.parse(
      one<{ detail: string }>("SELECT detail FROM observation WHERE kind='rename_needs_recheck'")!
        .detail,
    );
    assert.deepEqual(detail, { candidates: 1 });

    // 復活が先、差し戻しが後。同一トランザクション内なので occurred_at は同値になる
    const seq = q<{ kind: string; occurred_at: number }>(
      "SELECT kind, occurred_at FROM observation WHERE kind IN ('document_revived','rename_needs_recheck') ORDER BY observation_seq",
    );
    assert.deepEqual(
      seq.map((o) => o.kind),
      ["document_revived", "rename_needs_recheck"],
    );
    assert.equal(seq[0]!.occurred_at, seq[1]!.occurred_at, "前提: occurred_at では順序が決まらない");
  });
});

describe("recordObservedDocument: 観測したが版にならない枝（根本原因 #6）", () => {
  let scanId: ScanId;
  beforeEach(async () => {
    scanId = (await store.beginScan(SRC, BP)).scanId;
  });

  it("読めなくても lastSeen が進む（#17: 読めない は 欠損 ではない）", async () => {
    const r = await store.recordObservedDocument(scanId, {
      stableKey: "secret.txt",
      outcome: { kind: "unreadable", errorKind: "EACCES" },
    });

    const row = one<{ last_seen_scan_id: string; state: string }>(
      "SELECT last_seen_scan_id, state FROM document WHERE document_id=?",
      r.documentId,
    )!;
    assert.equal(row.last_seen_scan_id, scanId, "lastSeen が進まないと次回 tombstone される");
    assert.equal(row.state, "active");
    assert.equal(count("observation WHERE kind='document_unreadable'"), 1);
    assert.equal(count("document_version"), 0, "版は作られない");
  });

  it("サイズ不一致でも lastSeen が進む（#7, #20）", async () => {
    const r = await store.recordObservedDocument(scanId, {
      stableKey: "growing.txt",
      outcome: { kind: "size_mismatch", declaredSizeBytes: 100, actualSizeBytes: 40 },
    });
    assert.equal(lastSeenScan(r.documentId), scanId);
    assert.equal(count("observation WHERE kind='size_mismatch_rejected'"), 1);
    assert.equal(count("document_version"), 0);

    const detail = JSON.parse(
      one<{ detail: string }>("SELECT detail FROM observation WHERE kind='size_mismatch_rejected'")!.detail,
    );
    assert.deepEqual(detail, { declaredSizeBytes: 100, actualSizeBytes: 40 });
  });

  it("サイズ 0 は正当な内容であって「値なし」ではない（#20）", async () => {
    const r = await store.recordObservedDocument(scanId, {
      stableKey: "empty.txt",
      // 空ファイルの sha256
      outcome: content("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", 0),
    });
    assert.equal(lastSeenScan(r.documentId), scanId);
    assert.equal(count("observation WHERE kind='size_mismatch_rejected'"), 0);
  });

  it("content の枝は余計な観測を書かない（無変更の再実行を静かにするため）", async () => {
    await store.recordObservedDocument(scanId, { stableKey: "a.txt", outcome: content("h1") });
    const kinds = q<{ kind: string }>("SELECT kind FROM observation").map((r) => r.kind);
    assert.deepEqual(kinds, ["document_discovered"]);
  });

  it("同 fingerprint で別 hash なら記録する（#18。自動対処はしない）", async () => {
    const r = await store.recordObservedDocument(scanId, {
      stableKey: "a.txt",
      quickFingerprint: "mtime:100,size:3",
      outcome: content("h1"),
    });
    // active ポインタを立てる（衝突判定は現 active の hash と比べる）
    conn.db
      .prepare(
        `INSERT INTO document_version (version_id, document_id, content_hash, size_bytes, blob_key,
           blob_verified_at, mime_type, ingested_at, discovered_by_scan_id, pipeline_version)
         VALUES ('v1', ?, ?, 3, 'b1', ?, 'text/plain', ?, ?, 'v0.1')`,
      )
      .run(r.documentId, hashOf("h1"), clock.now(), clock.now(), scanId);
    conn.db.prepare("UPDATE document SET active_version_id='v1' WHERE document_id=?").run(r.documentId);

    // cp -p が mtime と size を保ったまま内容を変えた
    await store.recordObservedDocument(scanId, {
      stableKey: "a.txt",
      quickFingerprint: "mtime:100,size:3",
      outcome: content("h2"),
    });

    assert.equal(count("observation WHERE kind='fingerprint_collision'"), 1);
    const detail = JSON.parse(
      one<{ detail: string }>("SELECT detail FROM observation WHERE kind='fingerprint_collision'")!.detail,
    );
    assert.equal(detail.knownHash, hashOf("h1"));
    assert.equal(detail.observedHash, hashOf("h2"));
  });

  it("fingerprint が同じで hash も同じなら衝突ではない", async () => {
    const r = await store.recordObservedDocument(scanId, {
      stableKey: "a.txt",
      quickFingerprint: "fp",
      outcome: content("h1"),
    });
    conn.db
      .prepare(
        `INSERT INTO document_version (version_id, document_id, content_hash, size_bytes, blob_key,
           blob_verified_at, mime_type, ingested_at, discovered_by_scan_id, pipeline_version)
         VALUES ('v1', ?, ?, 3, 'b1', ?, 'text/plain', ?, ?, 'v0.1')`,
      )
      .run(r.documentId, hashOf("h1"), clock.now(), clock.now(), scanId);
    conn.db.prepare("UPDATE document SET active_version_id='v1' WHERE document_id=?").run(r.documentId);

    await store.recordObservedDocument(scanId, {
      stableKey: "a.txt",
      quickFingerprint: "fp",
      outcome: content("h1"),
    });
    assert.equal(count("observation WHERE kind='fingerprint_collision'"), 0);
  });

  it("正規化で衝突する鍵は同じ document になる（#23）", async () => {
    addSource("src-fold", { key_case_fold: 1 });
    const scan = await store.beginScan("src-fold" as SourceId, BP);
    const a = await store.recordObservedDocument(scan.scanId, { stableKey: "A.TXT", outcome: content("h1") });
    const b = await store.recordObservedDocument(scan.scanId, { stableKey: "a.txt", outcome: content("h1") });
    assert.equal(a.documentId, b.documentId);
    assert.equal(count("document WHERE source_id='src-fold'"), 1);
  });
});

function lastSeenScan(id: string): string {
  return (
    conn.db
      .prepare("SELECT last_seen_scan_id FROM document WHERE document_id=?")
      .get(id) as { last_seen_scan_id: string }
  ).last_seen_scan_id;
}
