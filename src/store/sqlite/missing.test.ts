/**
 * AC-PRO-01..04 / AC-MIS-01..04
 *
 * 削除判定に進む唯一の経路の検証です。
 * ここが緩むとデータ消失に直結するので、「進めない」ことの検証を厚くしてあります。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { openStore, type StoreConnection } from "./connection.ts";
import { SqliteLineageStore } from "./lineage-store.ts";
import { TestClock } from "../../../test/support/clock.ts";
import { isStoreError } from "../../domain/errors.ts";
import { attestContentHash } from "../../domain/evidence.ts";
import { documentId as deriveDocumentId } from "../../domain/ids.ts";
import { assertInvariants, checkInvariants } from "../../../test/support/invariant-checker.ts";
import type {
  CompletedScanRun,
  Document,
  KeyNormalizationPolicy,
  ScanId,
  SourceId,
} from "../../domain/types.ts";

/** beforeEach が入れる src1 と同じポリシー。documentId をここから導出する */
const POLICY: KeyNormalizationPolicy = {
  unicodeForm: "NFC",
  caseFold: false,
  pathSeparator: "posix",
  trimSlashes: true,
};

let clock: TestClock;
let conn: StoreConnection;
let store: SqliteLineageStore;

const SRC = "src1" as SourceId;
const BP = { countRatioThresholdBp: 9000, missingRatioThresholdBp: 1000 };
// 弁に邪魔されずに欠損集合を作るための緩い閾値
const LOOSE = { countRatioThresholdBp: 0, missingRatioThresholdBp: 10000 };

const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]): T | undefined =>
  conn.db.prepare(sql).get(...(p as never[])) as T | undefined;
const count = (sql: string, ...p: unknown[]): number =>
  (one<{ n: number }>(`SELECT count(*) AS n FROM ${sql}`, ...p) ?? { n: -1 }).n;

function totalRows(): number {
  return ["scan_run", "document", "document_version", "observation", "rename_candidate"].reduce(
    (n, t) => n + count(t),
    0,
  );
}

/** 実バイト列を読み切ってハッシュする。作り物の "h" は使わない */
const content = {
  kind: "content" as const,
  contentHash: attestContentHash(Buffer.from("body", "utf8")),
  sizeBytes: 3,
};

async function collect(it: AsyncIterable<Document>): Promise<Document[]> {
  const out: Document[] = [];
  for await (const d of it) out.push(d);
  return out;
}

/**
 * keys を観測して完了する走査を1本流す。
 *
 * 承認を通しているのは、**閾値では「必ず通す」を表現できない**ためです。
 * 欠損件数は前回 distinct 件数を超えうるので、missingRatioThresholdBp を
 * 上限の 10000 にしても発火します（前回1件・今回4件欠損 = 400%）。
 * ここで検証したいのは弁ではなく promote と findMissingSince なので、
 * 「この縮小は意図的だ」と運用者が証言する正規の経路で通します。
 */
async function runScan(keys: string[], bp = LOOSE): Promise<ScanId> {
  const scan = await store.beginScan(SRC, bp);
  await store.approveScan(scan.scanId, "test fixture: shrink is intentional", count("document WHERE state='active'"));
  for (const key of keys) {
    await store.recordObservedDocument(scan.scanId, { stableKey: key, outcome: content });
  }
  const finished = await store.finishScan(scan.scanId, {
    enumeratedCount: keys.length,
    distinctCount: keys.length,
    writeFailureCount: 0,
  });
  assert.equal(finished.status, "completed", `fixture scan aborted: ${finished.abortReason}`);
  return scan.scanId;
}

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

describe("promoteToCompleted", () => {
  it("AC-PRO-01: completed / wf=0 / 最新 なら CompletedScanRun を返す", async () => {
    const scanId = await runScan(["a.txt"]);
    const promoted = await store.promoteToCompleted(scanId);
    assert.ok(promoted);
    assert.equal(promoted.status, "completed");
    assert.equal(promoted.writeFailureCount, 0);
    assert.equal(promoted.isLatestCompleted, true);
    assert.notEqual(promoted.finishedAt, undefined);
  });

  it("AC-PRO-02: 後により大きい completion_seq の completed があれば null（#1, #2）", async () => {
    const first = await runScan(["a.txt"]);
    assert.ok(await store.promoteToCompleted(first), "前提: この時点では最新");

    await runScan(["a.txt"]);
    assert.equal(await store.promoteToCompleted(first), null);
  });

  it("AC-PRO-03: aborted_safety は null", async () => {
    await runScan(["a.txt", "b.txt", "c.txt"], BP);
    const scan = await store.beginScan(SRC, BP);
    const finished = await store.finishScan(scan.scanId, {
      enumeratedCount: 0,
      distinctCount: 0,
      writeFailureCount: 0,
    });
    assert.equal(finished.status, "aborted_safety");
    assert.equal(await store.promoteToCompleted(scan.scanId), null);
  });

  it("running な走査は null", async () => {
    const scan = await store.beginScan(SRC, BP);
    assert.equal(await store.promoteToCompleted(scan.scanId), null);
  });

  it("failed な走査は null", async () => {
    const scan = await store.beginScan(SRC, BP);
    conn.db
      .prepare("UPDATE scan_run SET status='failed', finished_at=? WHERE scan_id=?")
      .run(clock.now(), scan.scanId);
    assert.equal(await store.promoteToCompleted(scan.scanId), null);
  });

  it("書き込み失敗のある completed は null（#16）", async () => {
    const scanId = await runScan(["a.txt"]);
    // finishScan は wf>0 を aborted_safety にするので、直接注入して防壁を確かめる
    conn.db.prepare("UPDATE scan_run SET write_failure_count=1 WHERE scan_id=?").run(scanId);
    assert.equal(await store.promoteToCompleted(scanId), null);
  });

  it("存在しない scanId は null", async () => {
    assert.equal(await store.promoteToCompleted("nope" as ScanId), null);
  });

  it("AC-PRO-04: 1行も書かない（判定は書かない）", async () => {
    const scanId = await runScan(["a.txt"]);
    const before = totalRows();
    await store.promoteToCompleted(scanId);
    await store.promoteToCompleted("nope" as ScanId);
    assert.equal(totalRows(), before);
  });

  it("何度呼んでも同じ答えを返す", async () => {
    const scanId = await runScan(["a.txt"]);
    const a = await store.promoteToCompleted(scanId);
    const b = await store.promoteToCompleted(scanId);
    assert.deepEqual(a, b);
  });
});

/**
 * AC-MIS-05..09 — 墓標を立てる唯一の口。
 *
 * `findMissingSince` は1行も書きません。書くのはこちらで、**同じ
 * `CompletedScanRun` を要求します。**`ScanId` を裸で受け取る削除系 API は
 * 作りません（AGENTS.md 6節の禁止事項）。
 *
 * 状態と観測は同一トランザクションで動きます。`document_tombstoned` の
 * 観測が墓標の出所そのものなので（`DELETION_ONLY_FROM_COMPLETED_SCAN` は
 * `observation.scan_id` で辿ります）、片方だけが残ると出所の辿れない墓標に
 * なります。
 */
describe("tombstone（AC-MIS-05..09）", () => {
  async function baselineThenSee(seen: string[]): Promise<CompletedScanRun> {
    await runScan(["a.txt", "b.txt", "c.txt"]);
    const scanId = await runScan(seen);
    const promoted = await store.promoteToCompleted(scanId);
    assert.ok(promoted);
    return promoted;
  }

  it("AC-MIS-05: 欠損した文書に墓標を立て、出所が観測に残る", async () => {
    const scan = await baselineThenSee(["a.txt"]);
    const missing = await collect(store.findMissingSince(scan));
    assert.equal(missing.length, 2, "前提: b.txt と c.txt が欠損");

    assert.equal(await store.tombstone(scan, missing[0]!.documentId), true);

    const row = one<{ state: string; tombstoned_at: number | null }>(
      "SELECT state, tombstoned_at FROM document WHERE document_id=?",
      missing[0]!.documentId,
    )!;
    assert.equal(row.state, "tombstoned");
    assert.equal(row.tombstoned_at, clock.now());

    // 出所は observation.scan_id で辿る。列は増やしていない
    const obs = one<{ scan_id: string }>(
      "SELECT scan_id FROM observation WHERE kind='document_tombstoned' AND document_id=?",
      missing[0]!.documentId,
    );
    assert.ok(obs, "document_tombstoned の観測が無い");
    assert.equal(obs.scan_id, scan.scanId);
  });

  it("AC-MIS-06: 状態と観測は同時に動く（片方だけ残らない）", async () => {
    // 状態だけ動くと tombstoned_without_observation、
    // 観測だけ残ると出所のある墓標が無い状態になる
    const scan = await baselineThenSee(["a.txt"]);
    for (const d of await collect(store.findMissingSince(scan))) {
      await store.tombstone(scan, d.documentId);
    }
    assert.equal(count("document WHERE state='tombstoned'"), 2);
    assert.equal(count("observation WHERE kind='document_tombstoned'"), 2);

    const report = await checkInvariants({
      reader: { all: (sql) => Promise.resolve(conn.db.prepare(sql).all()) },
    });
    assertInvariants(report, ["DELETION_ONLY_FROM_COMPLETED_SCAN"]);
  });

  it("AC-MIS-07: 今回見えている文書には立たない（false を返すだけ）", async () => {
    // 列挙と書き込みの間に観測が入るのは正常。呼び出し側の誤りではない
    const scan = await baselineThenSee(["a.txt"]);
    assert.equal(await store.tombstone(scan, deriveDocumentId(SRC, "a.txt", POLICY)), false);
    assert.equal(count("document WHERE state='tombstoned'"), 0);
    assert.equal(count("observation WHERE kind='document_tombstoned'"), 0);
  });

  it("AC-MIS-07b: 後から始まった走査が見ている文書にも立たない（攻撃 #1）", async () => {
    // AC-MIS-07 の門は `last_seen_scan_id === scan.scanId`、つまり
    // 「**この走査が**見た」だけを弾きます。「まだ完了していない後続の走査が
    // 見た」は last_seen が別の値になるので、同じ門を素通りします。
    //
    // types.ts:325 の攻撃 #1（「走査AとBが重なり、Bが全件 lastSeen を更新した
    // 後に遅れてAが完了して findMissingSince(A) を呼び、全件が欠損に見えた」）
    // を、`CompletedScanRun` が防げていることをこの向きからも固定します。
    // completionSeq による追い越し判定（AC-PRO-02）は後続が **completed** に
    // なってはじめて効くので、running のあいだは効きません。
    const scan = await baselineThenSee(["a.txt", "b.txt"]);
    assert.equal(
      (await collect(store.findMissingSince(scan))).length,
      1,
      "前提: c.txt だけが正当な欠損",
    );

    const later = await store.beginScan(SRC, LOOSE);
    for (const key of ["a.txt", "b.txt", "c.txt"]) {
      await store.recordObservedDocument(later.scanId, { stableKey: key, outcome: content });
    }

    // **この走査自身が観測した a.txt** を狙う。後続の観測で last_seen が
    // 動いているだけで、a.txt が見えなかった事実はどこにもありません
    const target = deriveDocumentId(SRC, "a.txt", POLICY);
    const outcome: unknown = await store.tombstone(scan, target).then(
      (v) => v,
      (e: unknown) => e,
    );

    // **直し方は問いません。** false を返しても StaleScanError を投げても
    // 構いませんが、生きている文書が墓標になってはいけません
    assert.equal(
      one<{ state: string }>("SELECT state FROM document WHERE document_id=?", target)?.state,
      "active",
      `自分で観測した文書に墓標が立った（tombstone の結果: ${String(outcome)}）`,
    );
    assert.notEqual(outcome, true);
  });

  it("AC-MIS-07c: aborted で終わった後続走査が見た文書にも立たない", async () => {
    // **開始順は status に依存させていません。** 後続が aborted_safety や
    // failed で終わっても、観測の時点では last_seen_scan_id を動かしています。
    // 「running か completion_seq が大きい走査」で代用すると、この形が漏れます。
    const scan = await baselineThenSee(["a.txt", "b.txt"]);
    assert.equal(
      (await collect(store.findMissingSince(scan))).length,
      1,
      "前提: c.txt だけが欠損",
    );

    // 後続の走査が c.txt を観測してから、安全弁で止まる
    const later = await store.beginScan(SRC, BP);
    await store.recordObservedDocument(later.scanId, { stableKey: "c.txt", outcome: content });
    const aborted = await store.finishScan(later.scanId, {
      enumeratedCount: 1,
      distinctCount: 1,
      writeFailureCount: 0,
    });
    assert.equal(aborted.status, "aborted_safety", "前提: 後続は完了していない");
    // 完了していないので追い越し判定は発火しない。ここが分かれ目
    assert.ok(await store.promoteToCompleted(scan.scanId), "前提: N はまだ最新の完了走査");

    const target = deriveDocumentId(SRC, "c.txt", POLICY);
    assert.equal(
      (await collect(store.findMissingSince(scan))).length,
      0,
      "後続が観測済みの文書が欠損集合に残っている",
    );
    const outcome: unknown = await store.tombstone(scan, target).then(
      (v) => v,
      (e: unknown) => e,
    );
    assert.equal(
      one<{ state: string }>("SELECT state FROM document WHERE document_id=?", target)?.state,
      "active",
      `aborted な後続が観測した文書に墓標が立った（tombstone の結果: ${String(outcome)}）`,
    );
  });

  it("AC-MIS-07d: 後続が居るだけで欠損集合が空にならない", async () => {
    // 攻撃 #1 を塞ぐときに**行き過ぎる**と、削除検知そのものが止まります。
    // 「誰も見なかった文書」は今までどおり墓標になること、
    // 「この走査自身が見た文書」は欠損に**入らない**ことを同時に固定します。
    // 開始順の比較を `<` から `<=` に緩めると、後者が壊れてここが落ちます。
    const scan = await baselineThenSee(["a.txt", "b.txt"]);

    const missing = await collect(store.findMissingSince(scan));
    assert.deepEqual(
      missing.map((d) => d.stableKey),
      ["c.txt"],
      "自分で観測した文書まで欠損に入っている（比較が緩い）",
    );

    assert.equal(await store.tombstone(scan, missing[0]!.documentId), true);
    assert.equal(count("document WHERE state='tombstoned'"), 1);
    assert.equal(
      count("document WHERE state='active'"),
      2,
      "自分で観測した a.txt / b.txt まで墓標になっている",
    );
  });

  it("AC-MIS-08: 二度目は false。冪等で、観測も増えない", async () => {
    const scan = await baselineThenSee(["a.txt"]);
    const target = (await collect(store.findMissingSince(scan)))[0]!;
    assert.equal(await store.tombstone(scan, target.documentId), true);
    assert.equal(await store.tombstone(scan, target.documentId), false);
    assert.equal(count("observation WHERE kind='document_tombstoned'"), 1);
  });

  it("AC-MIS-09: 追い越された走査からは立てられない。1行も書かない（#1, #2）", async () => {
    // 列挙の時点で最新でも、書く時点で最新とは限らない
    const scan = await baselineThenSee(["a.txt"]);
    const target = (await collect(store.findMissingSince(scan)))[0]!;
    await runScan(["a.txt", "b.txt", "c.txt"]);

    const before = totalRows();
    await assert.rejects(
      () => store.tombstone(scan, target.documentId),
      (error: unknown) => isStoreError(error, "stale_scan"),
    );
    assert.equal(totalRows(), before, "拒否したのに行が動いている");
    assert.equal(count("document WHERE state='tombstoned'"), 0);
  });

  it("AC-MIS-10: promoteToCompleted を通らずに組んだ値では削除判定に入れない", async () => {
    // `CompletedScanRun` は構造的部分型です。`promoteToCompleted` が返した値で
    // なくても、口の形さえ合えば組めます — **`as` すら要りません**
    // （`tsc --noEmit` が exit 0 になることを実測済み）。
    // だから門は型ではなく `scan_run` の行のほうに置いています。
    await runScan(["a.txt", "b.txt", "c.txt"], BP);
    const later = await store.beginScan(SRC, BP);
    const finished = await store.finishScan(later.scanId, {
      enumeratedCount: 0,
      distinctCount: 0,
      writeFailureCount: 0,
    });
    assert.equal(finished.status, "aborted_safety", "前提: 弁が閉じている");
    assert.equal(
      await store.promoteToCompleted(finished.scanId),
      null,
      "前提: 正規の経路では手に入らない",
    );
    assert.ok(finished.finishedAt !== undefined);

    const forged: CompletedScanRun = {
      ...finished,
      status: "completed",
      finishedAt: finished.finishedAt,
      writeFailureCount: 0,
      isLatestCompleted: true,
      completionSeq: 999_999,
    };

    const before = totalRows();
    await assert.rejects(
      () => collect(store.findMissingSince(forged)),
      (error: unknown) => isStoreError(error, "stale_scan"),
    );
    await assert.rejects(
      () => store.tombstone(forged, deriveDocumentId(SRC, "a.txt", POLICY)),
      (error: unknown) => isStoreError(error, "stale_scan"),
    );
    assert.equal(count("document WHERE state='tombstoned'"), 0);
    assert.equal(totalRows(), before, "拒否したのに行が動いている");
  });

  it("AC-MIS-10b: 完了走査が1本も無い source でも、偽造した値では入れない", async () => {
    // AC-MIS-10 だけでは足りません。あちらは**追い越し判定**（行の
    // completion_seq）でも弾かれるので、「status を行から読んでいること」を
    // 単独では固定できていませんでした（変異 M3 が生き延びた、実測）。
    //
    // 完了走査が1本も無ければ追い越し判定は発火しません。そこに
    // failed な走査を2本置くと、渡された status を信じる実装では
    // **実在する文書が消えます。**
    const first = await store.beginScan(SRC, LOOSE);
    for (const key of ["a.txt", "b.txt"]) {
      await store.recordObservedDocument(first.scanId, { stableKey: key, outcome: content });
    }
    await store.failScan(first.scanId, "mount went away");

    const second = await store.beginScan(SRC, LOOSE);
    const failed = await store.failScan(second.scanId, "mount went away again");
    assert.equal(failed.status, "failed");
    assert.equal(count("scan_run WHERE status='completed'"), 0, "前提: 完了走査は1本も無い");
    assert.ok(failed.finishedAt !== undefined);

    const forged: CompletedScanRun = {
      ...failed,
      status: "completed",
      finishedAt: failed.finishedAt,
      writeFailureCount: 0,
      isLatestCompleted: true,
    };

    const before = totalRows();
    await assert.rejects(
      () => collect(store.findMissingSince(forged)),
      (error: unknown) => isStoreError(error, "stale_scan"),
    );
    await assert.rejects(
      () => store.tombstone(forged, deriveDocumentId(SRC, "a.txt", POLICY)),
      (error: unknown) => isStoreError(error, "stale_scan"),
    );
    assert.equal(count("document WHERE state='tombstoned'"), 0);
    assert.equal(totalRows(), before, "拒否したのに行が動いている");
  });

  it("別 source の文書は、この走査の権限では消せない", async () => {
    const scan = await baselineThenSee(["a.txt"]);
    conn.db
      .prepare(
        `INSERT INTO source (source_id, kind, config_hash, display_name,
           key_unicode_form, key_case_fold, key_path_separator, key_trim_slashes)
         VALUES ('src2', 'local-fs', 'cfg', 'src2', 'NFC', 0, 'posix', 1)`,
      )
      .run();
    const foreign = deriveDocumentId("src2" as SourceId, "x.txt", POLICY);
    conn.db
      .prepare(
        `INSERT INTO document (document_id, source_id, stable_key, state,
           first_seen_at, last_seen_at, last_seen_scan_id)
         VALUES (?, 'src2', 'x.txt', 'active', 1, 1, ?)`,
      )
      .run(foreign, scan.scanId);

    await assert.rejects(
      () => store.tombstone(scan, foreign),
      (error: unknown) => isStoreError(error, "invalid_argument"),
    );
    assert.equal(count("document WHERE state='tombstoned'"), 0);
  });

  it("存在しない文書は呼び出し側の誤り", async () => {
    const scan = await baselineThenSee(["a.txt"]);
    // 一度も取り込んでいない鍵から導出する。作り物の文字列は使わない
    await assert.rejects(
      () => store.tombstone(scan, deriveDocumentId(SRC, "never-ingested.txt", POLICY)),
      (error: unknown) => isStoreError(error, "invalid_argument"),
    );
  });
});

describe("findMissingSince", () => {
  /** a..e の5件を基準として作り、その後 seen だけを観測した走査を promote する */
  async function baselineThenSee(seen: string[]): Promise<CompletedScanRun> {
    await runScan(["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]);
    const scanId = await runScan(seen);
    const promoted = await store.promoteToCompleted(scanId);
    assert.ok(promoted);
    return promoted;
  }

  it("今回見なかった active 文書だけを返す", async () => {
    const scan = await baselineThenSee(["a.txt", "b.txt"]);
    const missing = await collect(store.findMissingSince(scan));
    assert.deepEqual(missing.map((d) => d.stableKey).sort(), ["c.txt", "d.txt", "e.txt"]);
  });

  it("今回観測した文書は返さない", async () => {
    const scan = await baselineThenSee(["a.txt", "b.txt"]);
    const missing = await collect(store.findMissingSince(scan));
    assert.ok(!missing.some((d) => d.stableKey === "a.txt"));
  });

  it("今回新規に見つかった文書も返さない", async () => {
    await runScan(["a.txt"]);
    const scanId = await runScan(["a.txt", "new.txt"]);
    const scan = (await store.promoteToCompleted(scanId))!;
    assert.deepEqual(await collect(store.findMissingSince(scan)), []);
  });

  it("既に tombstoned な文書は候補にしない", async () => {
    const scan = await baselineThenSee(["a.txt", "b.txt"]);
    const target = (await collect(store.findMissingSince(scan)))[0]!;
    conn.db
      .prepare("UPDATE document SET state='tombstoned', tombstoned_at=? WHERE document_id=?")
      .run(clock.now(), target.documentId);

    const missing = await collect(store.findMissingSince(scan));
    assert.equal(missing.length, 2);
    assert.ok(!missing.some((d) => d.documentId === target.documentId));
  });

  it("AC-MIS-01: 反復中に1行も書かない", async () => {
    const scan = await baselineThenSee(["a.txt"]);
    const before = totalRows();
    const missing = await collect(store.findMissingSince(scan));
    assert.equal(missing.length, 4);
    assert.equal(totalRows(), before);
  });

  it("AC-MIS-02: 反復開始後に新しい走査が完了しても集合は変わらない（#4）", async () => {
    const scan = await baselineThenSee(["a.txt"]);

    const iterator = store.findMissingSince(scan)[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.done, false);

    // 反復の途中で別の走査が全件を観測して完了する
    await runScan(["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]);

    const rest: Document[] = [];
    for (let n = await iterator.next(); n.done !== true; n = await iterator.next()) rest.push(n.value);

    const keys = [first.value.stableKey, ...rest.map((d) => d.stableKey)].sort();
    assert.deepEqual(keys, ["b.txt", "c.txt", "d.txt", "e.txt"], "materialize 済みの集合は変質しない");
  });

  it("AC-MIS-03: 反復件数は finishScan が G3 で数えた missing と一致する", async () => {
    await runScan(["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]);
    const scan = await store.beginScan(SRC, LOOSE);
    await store.recordObservedDocument(scan.scanId, { stableKey: "a.txt", outcome: content });
    const finished = await store.finishScan(scan.scanId, {
      enumeratedCount: 1,
      distinctCount: 1,
      writeFailureCount: 0,
    });
    assert.equal(finished.status, "completed");

    // finishScan は弁の判定で missing を数え、通過時は observation を書かないので
    // 同じ述語を直接評価して突き合わせる
    const countedByValve = count(
      "document WHERE source_id=? AND state='active' AND last_seen_scan_id<>?",
      SRC,
      scan.scanId,
    );
    const promoted = (await store.promoteToCompleted(scan.scanId))!;
    const iterated = (await collect(store.findMissingSince(promoted))).length;

    assert.equal(iterated, countedByValve, "弁が判断した対象と実際に削除される対象は同じでなければならない");
    assert.equal(iterated, 4);
  });

  it("AC-MIS-04: 最新でなくなった走査の token は StaleScanError", async () => {
    const scan = await baselineThenSee(["a.txt"]);
    // promote 後、tombstone を書いている最中に別の走査が完了した
    await runScan(["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"]);

    await assert.rejects(
      () => collect(store.findMissingSince(scan)),
      (e: unknown) => isStoreError(e, "stale_scan"),
    );
  });

  it("StaleScanError でも1行も書かない", async () => {
    const scan = await baselineThenSee(["a.txt"]);
    await runScan(["a.txt"]);
    const before = totalRows();
    await assert.rejects(() => collect(store.findMissingSince(scan)));
    assert.equal(totalRows(), before);
  });

  it("別 source の文書は混ざらない", async () => {
    conn.db
      .prepare(
        `INSERT INTO source (source_id, kind, config_hash, display_name,
           key_unicode_form, key_case_fold, key_path_separator, key_trim_slashes)
         VALUES ('src2', 'local-fs', 'cfg', 'src2', 'NFC', 0, 'posix', 1)`,
      )
      .run();
    const other = await store.beginScan("src2" as SourceId, LOOSE);
    await store.recordObservedDocument(other.scanId, { stableKey: "z.txt", outcome: content });
    await store.finishScan(other.scanId, {
      enumeratedCount: 1,
      distinctCount: 1,
      writeFailureCount: 0,
    });

    const scan = await baselineThenSee(["a.txt"]);
    const missing = await collect(store.findMissingSince(scan));
    assert.ok(!missing.some((d) => d.sourceId !== SRC));
    assert.equal(missing.length, 4);
  });

  it("ストアが書いた状態が不変条件を満たす", async () => {
    // checker はストアの関数を通さず生の表を読むので、これは独立した検証になる
    await runScan(["a.txt", "b.txt", "c.txt"]);
    const scanId = await runScan(["a.txt"]);
    const promoted = (await store.promoteToCompleted(scanId))!;
    await collect(store.findMissingSince(promoted));

    const report = await checkInvariants({
      reader: { all: (sql) => Promise.resolve(conn.db.prepare(sql).all()) },
      knownSourceIds: [SRC],
    });
    assert.doesNotThrow(() => assertInvariants(report));
  });

  it("返す Document は列を落とさず組み立てられる", async () => {
    await runScan(["a.txt"]);
    const scan2 = await store.beginScan(SRC, LOOSE);
    await store.finishScan(scan2.scanId, {
      enumeratedCount: 0,
      distinctCount: 0,
      writeFailureCount: 0,
    });
    const promoted = (await store.promoteToCompleted(scan2.scanId))!;
    const [doc] = await collect(store.findMissingSince(promoted));

    assert.ok(doc);
    assert.equal(doc.sourceId, SRC);
    assert.equal(doc.stableKey, "a.txt");
    assert.equal(doc.state, "active");
    assert.equal(doc.firstSeenAt, 1000);
    assert.equal(doc.activeVersionId, undefined);
    assert.equal(doc.tombstonedAt, undefined);
  });
});
