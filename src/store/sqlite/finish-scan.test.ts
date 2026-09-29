/**
 * AC-FIN-01..12 — 安全弁の全分岐。
 *
 * 弁の発火はエラーではなく状態です。status で判定し、例外は使いません。
 * abort_reason は正準トークンの昇順カンマ連結なので完全一致で比較します。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { openStore, type StoreConnection } from "./connection.ts";
import { SqliteLineageStore } from "./lineage-store.ts";
import { TestClock } from "../../../test/support/clock.ts";
import { isStoreError } from "../../domain/errors.ts";
import { attestContentHash } from "../../domain/evidence.ts";
import type { ScanId, SourceId } from "../../domain/types.ts";

let clock: TestClock;
let conn: StoreConnection;
let store: SqliteLineageStore;

const SRC = "src1" as SourceId;
const BP = { countRatioThresholdBp: 9000, missingRatioThresholdBp: 1000 };

const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]): T | undefined =>
  conn.db.prepare(sql).get(...(p as never[])) as T | undefined;
const count = (sql: string, ...p: unknown[]): number =>
  (one<{ n: number }>(`SELECT count(*) AS n FROM ${sql}`, ...p) ?? { n: -1 }).n;

/** 書き込み計数。WRITES() == 0 を判定するために総行数を数える */
function totalRows(): number {
  const tables = ["scan_run", "document", "document_version", "observation", "derivation", "artifact"];
  return tables.reduce((n, t) => n + count(t), 0);
}

/** ラベルを実バイト列として読み切ってハッシュする。作り物の "h" は使わない */
const content = (label: string) => ({
  kind: "content" as const,
  contentHash: attestContentHash(Buffer.from(label, "utf8")),
  sizeBytes: 3,
});

beforeEach(() => {
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
});

afterEach(() => conn.close());

/**
 * 前回 completed の走査を作り、n 件の active 文書を残す。
 * 安全弁の基準値（previous_distinct_count）を用意するための下ごしらえ。
 */
async function seedBaseline(n: number): Promise<void> {
  const scan = await store.beginScan(SRC, BP);
  for (let i = 0; i < n; i += 1) {
    await store.recordObservedDocument(scan.scanId, { stableKey: `f${i}.txt`, outcome: content("h") });
  }
  await store.finishScan(scan.scanId, { enumeratedCount: n, distinctCount: n, writeFailureCount: 0 });
}

/** 今回の走査で m 件だけ観測して完了させる */
async function scanSeeing(m: number, writeFailureCount = 0): Promise<ScanId> {
  const scan = await store.beginScan(SRC, BP);
  for (let i = 0; i < m; i += 1) {
    await store.recordObservedDocument(scan.scanId, { stableKey: `f${i}.txt`, outcome: content("h") });
  }
  await store.finishScan(scan.scanId, {
    enumeratedCount: m,
    distinctCount: m,
    writeFailureCount,
  });
  return scan.scanId;
}

const statusOf = (scanId: ScanId) =>
  one<{ status: string; abort_reason: string | null; completion_seq: number | null; finished_at: number | null }>(
    "SELECT status, abort_reason, completion_seq, finished_at FROM scan_run WHERE scan_id=?",
    scanId,
  )!;

describe("finishScan: 通過と停止", () => {
  it("AC-FIN-01: 全門通過で completed / finishedAt / completionSeq が入る", async () => {
    const scan = await store.beginScan(SRC, BP);
    const result = await store.finishScan(scan.scanId, {
      enumeratedCount: 0,
      distinctCount: 0,
      writeFailureCount: 0,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.finishedAt, 1000);
    assert.equal(result.completionSeq, 1);
  });

  it("AC-FIN-09: 初回走査（prevDistinct=0）は通過する。0除算も NaN も起きない", async () => {
    const scan = await store.beginScan(SRC, BP);
    const r = await store.finishScan(scan.scanId, {
      enumeratedCount: 0,
      distinctCount: 0,
      writeFailureCount: 0,
    });
    assert.equal(r.status, "completed");
    assert.equal(r.abortReason, undefined);
  });

  it("AC-FIN-03: prevDistinct=1000, distinct=899 で count_ratio が立つ", async () => {
    await seedBaseline(1000);
    const scanId = await scanSeeing(899);
    const row = statusOf(scanId);
    assert.equal(row.status, "aborted_safety");
    assert.ok(row.abort_reason!.includes("count_ratio"));
  });

  it("AC-FIN-04: 境界 distinct=900 は通過する（900*10000 < 1000*9000 は false）", async () => {
    await seedBaseline(1000);
    const scan = await store.beginScan(SRC, BP);
    // 件数は境界ちょうど。欠損率は別途通す必要があるので 900 件を実際に観測する
    for (let i = 0; i < 900; i += 1) {
      await store.recordObservedDocument(scan.scanId, { stableKey: `f${i}.txt`, outcome: content("h") });
    }
    // 欠損 100 件は missing_ratio の境界ちょうど（100*10000 > 1000*1000 は false）
    const r = await store.finishScan(scan.scanId, {
      enumeratedCount: 900,
      distinctCount: 900,
      writeFailureCount: 0,
    });
    assert.equal(r.status, "completed", `abort_reason=${r.abortReason}`);
  });

  it("AC-FIN-06: 件数比と欠損率が同時発火すると昇順カンマ連結になる", async () => {
    await seedBaseline(1000);
    const scanId = await scanSeeing(500);
    const row = statusOf(scanId);
    assert.equal(row.status, "aborted_safety");
    assert.equal(row.abort_reason, "count_ratio,missing_ratio");
  });

  it("aborted_safety には completion_seq が入らない（promote の対象にならない）", async () => {
    await seedBaseline(1000);
    const scanId = await scanSeeing(500);
    const row = statusOf(scanId);
    assert.equal(row.completion_seq, null);
    assert.notEqual(row.finished_at, null);
  });

  it("AC-FIN-08: 弁が作動した走査からの tombstone は0件", async () => {
    await seedBaseline(1000);
    const scanId = await scanSeeing(500);
    assert.equal(count("document WHERE state='tombstoned' AND last_seen_scan_id=?", scanId), 0);
    assert.equal(count("document WHERE state='tombstoned'"), 0);
  });

  it("AC-FIN-07: completed になった走査で観測された文書は必ずその走査を last_seen に持つ", async () => {
    const scan = await store.beginScan(SRC, BP);
    for (let i = 0; i < 50; i += 1) {
      await store.recordObservedDocument(scan.scanId, { stableKey: `f${i}.txt`, outcome: content("h") });
    }
    await store.finishScan(scan.scanId, { enumeratedCount: 50, distinctCount: 50, writeFailureCount: 0 });

    // lastSeen が更新されないまま completed になると、その文書は次回で欠損に見える。
    // DELETION_ONLY_FROM_COMPLETED_SCAN は tombstone の「出所」しか見ないので
    // この不具合は素通りする。鮮度そのものを見る検査はここに置く
    const stale = count(
      `document WHERE source_id=? AND state='active' AND last_seen_scan_id<>?
         AND document_id IN (SELECT document_id FROM observation
                              WHERE scan_id=? AND kind='document_discovered')`,
      SRC,
      scan.scanId,
      scan.scanId,
    );
    assert.equal(stale, 0);
  });

  it("弁が作動したら scan_aborted_safety を必ず残す", async () => {
    await seedBaseline(1000);
    const scanId = await scanSeeing(500);
    assert.equal(count("observation WHERE kind='scan_aborted_safety' AND scan_id=?", scanId), 1);
    const detail = JSON.parse(
      one<{ detail: string }>("SELECT detail FROM observation WHERE kind='scan_aborted_safety'")!.detail,
    );
    assert.equal(detail.reason, "count_ratio,missing_ratio");
    assert.equal(detail.previousDistinctCount, 1000);
    assert.equal(detail.missing, 500);
  });
});

describe("finishScan: G1（書き込み失敗）は承認で免除しない（#16）", () => {
  it("AC-FIN-02: writeFailureCount>0 は承認があっても aborted_safety", async () => {
    const scan = await store.beginScan(SRC, BP);
    await store.approveScan(scan.scanId, "operator confirmed the source really shrank", 0);
    const r = await store.finishScan(scan.scanId, {
      enumeratedCount: 0,
      distinctCount: 0,
      writeFailureCount: 1,
    });
    assert.equal(r.status, "aborted_safety");
    assert.equal(r.abortReason, "write_failures");
    // promote の対象にならない（2.5 で promoteToCompleted が null を返す根拠）
    assert.equal(r.completionSeq, undefined);
  });

  it("G1 が立ったら G2/G3 は評価しない（誤った理由を提示しない）", async () => {
    await seedBaseline(1000);
    const scanId = await scanSeeing(0, 1);
    // 件数比も欠損率も本来は発火する状況だが、理由は write_failures だけ
    assert.equal(statusOf(scanId).abort_reason, "write_failures");
  });

  it("ストアが持つ既存の失敗数と渡された値の大きいほうを採る", async () => {
    const scan = await store.beginScan(SRC, BP);
    conn.db.prepare("UPDATE scan_run SET write_failure_count=5 WHERE scan_id=?").run(scan.scanId);
    const r = await store.finishScan(scan.scanId, {
      enumeratedCount: 0,
      distinctCount: 0,
      writeFailureCount: 1,
    });
    assert.equal(r.writeFailureCount, 5);
    assert.equal(r.status, "aborted_safety");
  });
});

describe("approveScan: 1回限りの承認（#28）", () => {
  it("AC-FIN-05: 件数比と欠損率が同時発火しても承認があれば通過する", async () => {
    await seedBaseline(1000);
    const scan = await store.beginScan(SRC, BP);
    await store.approveScan(scan.scanId, "decommissioned the share on purpose", 1000);
    const r = await store.finishScan(scan.scanId, {
      enumeratedCount: 0,
      distinctCount: 0,
      writeFailureCount: 0,
    });
    assert.equal(r.status, "completed");
    assert.equal(count("observation WHERE kind='scan_approved_by_operator' AND scan_id=?", scan.scanId), 1);
  });

  it("承認は両方の門に等しく効く（片方だけだと #28 が再発する）", async () => {
    await seedBaseline(1000);
    const scan = await store.beginScan(SRC, BP);
    await store.approveScan(scan.scanId, "genuinely empty now", 1000);
    await store.finishScan(scan.scanId, { enumeratedCount: 0, distinctCount: 0, writeFailureCount: 0 });
    const detail = JSON.parse(
      one<{ detail: string }>("SELECT detail FROM observation WHERE kind='scan_approved_by_operator'")!.detail,
    );
    assert.deepEqual(detail.excused, ["count_ratio", "missing_ratio"]);
  });

  it("閾値そのものは書き換わらない", async () => {
    const scan = await store.beginScan(SRC, BP);
    await store.approveScan(scan.scanId, "note", 0);
    const row = one<{ c: number; m: number }>(
      "SELECT count_ratio_threshold_bp AS c, missing_ratio_threshold_bp AS m FROM scan_run WHERE scan_id=?",
      scan.scanId,
    )!;
    assert.equal(row.c, 9000);
    assert.equal(row.m, 1000);
  });

  it("承認は次の走査には引き継がれない（1回限り）", async () => {
    await seedBaseline(1000);
    const approved = await store.beginScan(SRC, BP);
    await store.approveScan(approved.scanId, "one-off", 1000);
    await store.finishScan(approved.scanId, { enumeratedCount: 0, distinctCount: 0, writeFailureCount: 0 });

    // 次の走査には承認が無い。基準は前回の 0 件なので prevDistinct=0 で通過してしまう。
    // 承認が引き継がれないことを approved_at で直接確かめる
    const next = await store.beginScan(SRC, BP);
    const row = one<{ approved_at: number | null }>(
      "SELECT approved_at FROM scan_run WHERE scan_id=?",
      next.scanId,
    )!;
    assert.equal(row.approved_at, null);
  });

  it("通過した走査では承認の観測を書かない（弁が立っていないため）", async () => {
    const scan = await store.beginScan(SRC, BP);
    await store.approveScan(scan.scanId, "just in case", 0);
    await store.finishScan(scan.scanId, { enumeratedCount: 0, distinctCount: 0, writeFailureCount: 0 });
    assert.equal(count("observation WHERE kind='scan_approved_by_operator'"), 0);
  });

  it("running でない走査は承認できない", async () => {
    const scan = await store.beginScan(SRC, BP);
    await store.finishScan(scan.scanId, { enumeratedCount: 0, distinctCount: 0, writeFailureCount: 0 });
    await assert.rejects(
      () => store.approveScan(scan.scanId, "too late", 0),
      (e: unknown) => isStoreError(e, "scan_not_running"),
    );
  });

  it("空の理由では承認できない（監査に使えない記録を残さない）", async () => {
    const scan = await store.beginScan(SRC, BP);
    await assert.rejects(
      () => store.approveScan(scan.scanId, "   ", 0),
      (e: unknown) => isStoreError(e, "invalid_argument"),
    );
  });
});

describe("finishScan: 入力検証と順序", () => {
  it("AC-FIN-10: distinct > enumerated は throw。1行も書かない", async () => {
    const scan = await store.beginScan(SRC, BP);
    const before = totalRows();
    await assert.rejects(
      () => store.finishScan(scan.scanId, { enumeratedCount: 5, distinctCount: 6, writeFailureCount: 0 }),
      (e: unknown) => isStoreError(e, "invalid_counts"),
    );
    assert.equal(totalRows(), before);
    assert.equal(statusOf(scan.scanId).status, "running");
  });

  it("負の件数と小数を拒む", async () => {
    const scan = await store.beginScan(SRC, BP);
    for (const bad of [-1, 1.5, Number.NaN]) {
      await assert.rejects(
        () => store.finishScan(scan.scanId, { enumeratedCount: bad, distinctCount: 0, writeFailureCount: 0 }),
        (e: unknown) => isStoreError(e, "invalid_counts"),
      );
    }
    assert.equal(statusOf(scan.scanId).status, "running");
  });

  it("AC-FIN-11: running でない走査は ScanNotRunningError", async () => {
    const scan = await store.beginScan(SRC, BP);
    await store.finishScan(scan.scanId, { enumeratedCount: 0, distinctCount: 0, writeFailureCount: 0 });
    await assert.rejects(
      () => store.finishScan(scan.scanId, { enumeratedCount: 0, distinctCount: 0, writeFailureCount: 0 }),
      (e: unknown) => isStoreError(e, "scan_not_running"),
    );
  });

  it("AC-FIN-12: 固定時計で2走査を完了させても completion_seq は相異なる", async () => {
    const a = await store.beginScan(SRC, BP);
    await store.finishScan(a.scanId, { enumeratedCount: 0, distinctCount: 0, writeFailureCount: 0 });
    const b = await store.beginScan(SRC, BP);
    const rb = await store.finishScan(b.scanId, {
      enumeratedCount: 0,
      distinctCount: 0,
      writeFailureCount: 0,
    });

    assert.equal(statusOf(a.scanId).finished_at, statusOf(b.scanId).finished_at, "前提: 完了時刻は同値");
    assert.equal(statusOf(a.scanId).completion_seq, 1);
    assert.equal(rb.completionSeq, 2);
  });

  it("completion_seq は source ごとに独立して採番される", async () => {
    conn.db
      .prepare(
        `INSERT INTO source (source_id, kind, config_hash, display_name,
           key_unicode_form, key_case_fold, key_path_separator, key_trim_slashes)
         VALUES ('src2', 'local-fs', 'cfg', 'src2', 'NFC', 0, 'posix', 1)`,
      )
      .run();
    const a = await store.beginScan(SRC, BP);
    await store.finishScan(a.scanId, { enumeratedCount: 0, distinctCount: 0, writeFailureCount: 0 });
    const b = await store.beginScan("src2" as SourceId, BP);
    const rb = await store.finishScan(b.scanId, {
      enumeratedCount: 0,
      distinctCount: 0,
      writeFailureCount: 0,
    });
    assert.equal(rb.completionSeq, 1);
  });
});

describe("finishScan: 欠損率の分母（#5）", () => {
  it("今回新規発見された文書は分母を膨らませない", async () => {
    await seedBaseline(1000);
    // 別ボリュームがマウントされ、同件数だが全部別のファイルになった
    const scan = await store.beginScan(SRC, BP);
    for (let i = 0; i < 1000; i += 1) {
      await store.recordObservedDocument(scan.scanId, { stableKey: `other${i}.txt`, outcome: content("h") });
    }
    const r = await store.finishScan(scan.scanId, {
      enumeratedCount: 1000,
      distinctCount: 1000,
      writeFailureCount: 0,
    });

    // 件数比は通過する（1000/1000）。欠損率だけが 1000 件の消失を捉える
    assert.equal(r.status, "aborted_safety");
    assert.equal(r.abortReason, "missing_ratio", "件数一致は安全の証明にならない");
  });

  it("欠損率の境界: missing=100, prevDistinct=1000, bp=1000 は通過する", async () => {
    await seedBaseline(1000);
    const scan = await store.beginScan(SRC, BP);
    for (let i = 0; i < 900; i += 1) {
      await store.recordObservedDocument(scan.scanId, { stableKey: `f${i}.txt`, outcome: content("h") });
    }
    const r = await store.finishScan(scan.scanId, {
      enumeratedCount: 900,
      distinctCount: 900,
      writeFailureCount: 0,
    });
    assert.equal(r.status, "completed");
  });

  it("欠損率の境界+1: missing=101 は発火する", async () => {
    await seedBaseline(1000);
    const scan = await store.beginScan(SRC, BP);
    for (let i = 0; i < 899; i += 1) {
      await store.recordObservedDocument(scan.scanId, { stableKey: `f${i}.txt`, outcome: content("h") });
    }
    const r = await store.finishScan(scan.scanId, {
      enumeratedCount: 899,
      distinctCount: 899,
      writeFailureCount: 0,
    });
    assert.ok(r.abortReason!.includes("missing_ratio"));
  });

  it("読めなかった文書は欠損に数えない（#17 が弁を誤発火させない）", async () => {
    await seedBaseline(1000);
    const scan = await store.beginScan(SRC, BP);
    for (let i = 0; i < 1000; i += 1) {
      // 全件が権限喪失で読めなくなった。しかし「見えている」
      await store.recordObservedDocument(scan.scanId, {
        stableKey: `f${i}.txt`,
        outcome: { kind: "unreadable", errorKind: "EACCES" },
      });
    }
    const r = await store.finishScan(scan.scanId, {
      enumeratedCount: 1000,
      distinctCount: 1000,
      writeFailureCount: 0,
    });
    assert.equal(r.status, "completed", "読めない は 欠損 ではない");
    assert.equal(count("observation WHERE kind='document_unreadable'"), 1000);
  });
});

describe("承認上限: 確定する行に有限の上限が残る", () => {
  it("上限は確定時に再計数し、承認時の欠損件数を信じない", async () => {
    await seedBaseline(10);
    const scan = await store.beginScan(SRC, BP);
    await store.approveScan(scan.scanId, "up to one", 1);
    const finished = await store.finishScan(scan.scanId, { enumeratedCount: 0, distinctCount: 0, writeFailureCount: 0 });
    assert.equal(finished.status, "aborted_safety");
    assert.ok(finished.abortReason?.includes("approval_missing_limit"));
    assert.equal(finished.approvedByOperator?.maxMissingCount, 1);
    assert.equal(await store.promoteToCompleted(scan.scanId), null);
  });

  it("比率が通っても、上限を超えた欠損は承認に反するので止める", async () => {
    await seedBaseline(10);
    const scan = await store.beginScan(SRC, { countRatioThresholdBp: 0, missingRatioThresholdBp: 10000 });
    await store.approveScan(scan.scanId, "no deletion authorized", 0);
    const finished = await store.finishScan(scan.scanId, { enumeratedCount: 0, distinctCount: 0, writeFailureCount: 0 });
    assert.equal(finished.abortReason, "approval_missing_limit");
  });

  it("無限・負数・端数の上限と、同じ走査の承認の差し替えを拒む", async () => {
    const scan = await store.beginScan(SRC, BP);
    for (const bound of [NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(() => store.approveScan(scan.scanId, "invalid bound", bound));
    }
    const approved = await store.approveScan(scan.scanId, "one", 1);
    assert.equal(approved.approvedByOperator?.approvedAt, clock.now());
    await assert.rejects(() => store.approveScan(scan.scanId, "widen", 10));
    assert.equal((await store.findRunningScan(SRC))?.approvedByOperator?.maxMissingCount, 1);
  });
});
