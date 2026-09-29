/**
 * AC-RUN-01..08
 *
 * #12 の再現はスレッドやタイミングに頼りません。
 * SQLite のロックが同期的である性質を使い、**文の順序だけ**で決定的に再現します。
 * `node:sqlite` の DatabaseSync が同期 API なので、1プロセス内で2接続を
 * 明示的な順序で駆動でき、「途中で勝手に割り込まれる」ことがありません。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore, type StoreConnection } from "./connection.ts";
import { SqliteLineageStore } from "./lineage-store.ts";
import { TestClock } from "../../../test/support/clock.ts";
import { isStoreError } from "../../domain/errors.ts";
import { attestContentHash, attestPersisted } from "../../domain/evidence.ts";
import { derivationKey as deriveDerivationKey } from "../../domain/ids.ts";
import type {
  DerivationKey,
  DocumentId,
  RunId,
  SourceId,
  VersionId,
  WorkerId,
} from "../../domain/types.ts";
import { __unsafeBlobKey } from "../../../test/support/unsafe-brands.ts";

const SRC = "src1" as SourceId;
const BP = { countRatioThresholdBp: 0, missingRatioThresholdBp: 10000 };
/**
 * 鍵の材料。**鍵そのものは持ちません。**
 *
 * `claimRun` が材料から導出するようになったので、テストが鍵を先に決めて
 * 渡すことはできません。生 SQL で行を作る場面では `keyFor` で
 * 同じ導出を通します（簡略式の鍵を書くと claimRun の導出と一致しません）。
 */
const MATERIALS = { processorName: "echo", processorVersion: "1", configHash: "cfg" };
const keyFor = (v: VersionId): DerivationKey =>
  deriveDerivationKey({ ...MATERIALS, inputIds: [v] });
const W1 = "worker-1" as WorkerId;
const W2 = "worker-2" as WorkerId;
const hashOf = (t: string) => attestContentHash(Buffer.from(t, "utf8"));

let clock: TestClock;
let conn: StoreConnection;
let store: SqliteLineageStore;
let docId: DocumentId;
let versionId: VersionId;

const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]): T | undefined =>
  conn.db.prepare(sql).get(...(p as never[])) as T | undefined;
const count = (sql: string, ...p: unknown[]): number =>
  (one<{ n: number }>(`SELECT count(*) AS n FROM ${sql}`, ...p) ?? { n: -1 }).n;

/** source / document / version を用意する。processing_run の FK を満たすため */
async function seed(target: StoreConnection): Promise<{ docId: DocumentId; versionId: VersionId }> {
  const s = new SqliteLineageStore(target);
  target.db
    .prepare(
      `INSERT INTO source (source_id, kind, config_hash, display_name,
         key_unicode_form, key_case_fold, key_path_separator, key_trim_slashes)
       VALUES ('src1', 'local-fs', 'cfg', 'src1', 'NFC', 0, 'posix', 1)`,
    )
    .run();
  const scan = await s.beginScan(SRC, BP);
  const hash = hashOf("one");
  const observed = await s.recordObservedDocument(scan.scanId, {
    stableKey: "a.txt",
    outcome: { kind: "content", contentHash: hash, sizeBytes: 3 },
  });
  const v = await s.insertVersionIfAbsent({
    documentId: observed.documentId,
    contentHash: hash,
    sizeBytes: 3,
    blobKey: __unsafeBlobKey("b1"),
    blobVerifiedAt: attestPersisted(target.clock.now(), hash),
    mimeType: "text/plain",
    discoveredByScanId: scan.scanId,
    pipelineVersion: "v0.1",
  });
  await s.setActiveVersion({
    documentId: observed.documentId,
    observedHash: hash,
    versionId: v.versionId,
    scanId: scan.scanId,
  });
  return { docId: observed.documentId, versionId: v.versionId };
}

const claimArgs = () => ({
  ...MATERIALS,
  inputIds: [versionId],
  rootVersionId: versionId,
  workerId: W1,
  leaseSeconds: 60,
});

beforeEach(async () => {
  clock = new TestClock(1000);
  conn = openStore({ clock });
  store = new SqliteLineageStore(conn);
  ({ docId, versionId } = await seed(conn));
});

afterEach(() => conn.close());

describe("claimRun", () => {
  it("AC-RUN-01: 空の状態から leased / attempt=1 / 失効時刻が now + leaseSeconds*1000", async () => {
    const run = await store.claimRun(claimArgs());
    assert.ok(run);
    assert.equal(run.status, "leased");
    assert.equal(run.attempt, 1);
    assert.equal(run.workerId, W1);
    assert.equal(run.startedAt, 1000);
    assert.equal(run.leaseExpiresAt, 1000 + 60 * 1000);
  });

  it("既に leased なら null（書かない）", async () => {
    await store.claimRun(claimArgs());
    const before = count("processing_run");
    assert.equal(await store.claimRun({ ...claimArgs(), workerId: W2 }), null);
    assert.equal(count("processing_run"), before);
  });

  it("AC-RUN-03: succeeded な run があれば null / 1行も書かない", async () => {
    const run = (await store.claimRun(claimArgs()))!;
    await store.completeRun({ runId: run.runId, workerId: W1, status: "succeeded" });
    const before = count("processing_run");
    assert.equal(await store.claimRun(claimArgs()), null);
    assert.equal(count("processing_run"), before);
  });

  it("AC-RUN-04: permanent な failed があれば null", async () => {
    const run = (await store.claimRun(claimArgs()))!;
    await store.completeRun({
      runId: run.runId,
      workerId: W1,
      status: "failed",
      error: { kind: "parse_error", message: "bad", permanent: true },
    });
    assert.equal(await store.claimRun(claimArgs()), null);
  });

  it("一時的な failed なら再試行でき、attempt が増える", async () => {
    const first = (await store.claimRun(claimArgs()))!;
    await store.completeRun({
      runId: first.runId,
      workerId: W1,
      status: "failed",
      error: { kind: "timeout", message: "slow", permanent: false },
    });
    const second = await store.claimRun(claimArgs());
    assert.ok(second);
    assert.equal(second.attempt, 2);
  });

  it("失効したリースは reap を待たずに他のワーカーが取れる", async () => {
    const dead = (await store.claimRun(claimArgs()))!;
    clock.advance(61_000);

    // reapAbandonedRuns をあえて呼ばない。
    // 呼ばないと取れないなら、クラッシュしたワーカーのリースが
    // 誰かが掃除するまでこの鍵を占有し続けることになる
    const taken = await store.claimRun({ ...claimArgs(), workerId: W2 });
    assert.ok(taken, "期限切れのリースは掃除を待たずに引き継げる");
    assert.equal(taken.attempt, 2);
    assert.equal(taken.workerId, W2);

    // 元の行は放置されず abandoned になる（leased が2件並ばない）
    assert.equal(
      one<{ status: string }>("SELECT status FROM processing_run WHERE run_id=?", dead.runId)!.status,
      "abandoned",
    );
    assert.equal(count("processing_run WHERE status='leased'"), 1);
  });

  it("leaseSeconds は正の整数のみ", async () => {
    for (const bad of [0, -1, 1.5]) {
      await assert.rejects(
        () => store.claimRun({ ...claimArgs(), leaseSeconds: bad }),
        (e: unknown) => isStoreError(e, "invalid_argument"),
      );
    }
    assert.equal(count("processing_run"), 0);
  });

  it("別の材料は別の鍵になり、互いに影響しない", async () => {
    await store.claimRun(claimArgs());
    // 鍵を直接渡せないので、材料を1つ変える。これが分解の狙いそのもの
    const other = await store.claimRun({ ...claimArgs(), processorVersion: "2" });
    assert.ok(other);
    assert.equal(count("processing_run WHERE status='leased'"), 2);
  });

  /**
   * 分解の中身。以前は呼び出し側が鍵と documentId を計算して渡していました。
   * どちらもストアが導出するようになったので、**食い違う経路が消えました。**
   */
  describe("鍵と documentId はストアが導出する（AGENTS.md 9節）", () => {
    it("claim が書く鍵は、materials から導出した鍵と一致する", async () => {
      const run = (await store.claimRun(claimArgs()))!;
      const row = one<{ derivation_key: string; document_id: string }>(
        "SELECT derivation_key, document_id FROM processing_run WHERE run_id=?",
        run.runId,
      )!;
      assert.equal(row.derivation_key, keyFor(versionId));
    });

    it("documentId は rootVersionId から引かれる（呼び出し側は渡せない）", async () => {
      const run = (await store.claimRun(claimArgs()))!;
      const row = one<{ document_id: string }>(
        "SELECT document_id FROM processing_run WHERE run_id=?",
        run.runId,
      )!;
      const version = one<{ document_id: string }>(
        "SELECT document_id FROM document_version WHERE version_id=?",
        versionId,
      )!;
      assert.equal(row.document_id, version.document_id);
    });

    it("存在しない rootVersionId は拒む。1行も書かない", async () => {
      await assert.rejects(
        () => store.claimRun({ ...claimArgs(), rootVersionId: "no-such-version" as VersionId }),
        (e: unknown) => isStoreError(e, "invalid_argument"),
      );
      assert.equal(count("processing_run"), 0);
    });

    it("材料そのものが誤っていれば claim の時点で弾かれる。1行も書かない", async () => {
      // 同じ入力を2回渡すのは呼び出し側の誤り。黙って畳むと別の入力集合が
      // 同じ鍵になる（ids.ts の事前条件）。以前は commit まで表面化しなかった
      await assert.rejects(
        () => store.claimRun({ ...claimArgs(), inputIds: [versionId, versionId] }),
        /duplicate inputId/,
      );
      assert.equal(count("processing_run"), 0);
    });
  });
});

describe("heartbeat / completeRun", () => {
  it("所有者の heartbeat はリースを延長する", async () => {
    const run = (await store.claimRun(claimArgs()))!;
    clock.advance(30_000);
    assert.deepEqual(await store.heartbeat(run.runId, W1), { ok: true });

    const row = one<{ heartbeat_at: number; lease_expires_at: number }>(
      "SELECT heartbeat_at, lease_expires_at FROM processing_run WHERE run_id=?",
      run.runId,
    )!;
    assert.equal(row.heartbeat_at, 31_000);
    assert.equal(row.lease_expires_at, 31_000 + 60_000);
  });

  it("AC-RUN-05: 別ワーカーの heartbeat は拒否し stale_worker_rejected を残す", async () => {
    const run = (await store.claimRun(claimArgs()))!;
    assert.deepEqual(await store.heartbeat(run.runId, W2), { ok: false, reason: "stale_worker" });
    assert.equal(count("observation WHERE kind='stale_worker_rejected' AND run_id=?", run.runId), 1);
  });

  it("AC-RUN-06: 失効後は正当な所有者でも延長できない（自己延長させない）", async () => {
    const run = (await store.claimRun(claimArgs()))!;
    clock.advance(61_000);
    assert.deepEqual(await store.heartbeat(run.runId, W1), { ok: false, reason: "stale_worker" });
    assert.equal(count("observation WHERE kind='stale_worker_rejected'"), 1);
  });

  it("存在しない run への heartbeat も拒否して記録する", async () => {
    const r = await store.heartbeat("nope" as RunId, W1);
    assert.deepEqual(r, { ok: false, reason: "stale_worker" });
    // run_id 列には入れられない（FK が無い相手）ので detail に残る
    const row = one<{ run_id: string | null; detail: string }>(
      "SELECT run_id, detail FROM observation WHERE kind='stale_worker_rejected'",
    )!;
    assert.equal(row.run_id, null);
    assert.equal(JSON.parse(row.detail).runId, "nope");
    assert.equal(JSON.parse(row.detail).status, "missing");
  });

  it("completeRun は succeeded と finished_at を書く", async () => {
    const run = (await store.claimRun(claimArgs()))!;
    clock.advance(5000);
    assert.deepEqual(await store.completeRun({ runId: run.runId, workerId: W1, status: "succeeded" }), {
      ok: true,
    });
    const row = one<{ status: string; finished_at: number }>(
      "SELECT status, finished_at FROM processing_run WHERE run_id=?",
      run.runId,
    )!;
    assert.equal(row.status, "succeeded");
    assert.equal(row.finished_at, 6000);
  });

  it("failed は run_failed を残し、permanent を記録する", async () => {
    const run = (await store.claimRun(claimArgs()))!;
    await store.completeRun({
      runId: run.runId,
      workerId: W1,
      status: "failed",
      error: { kind: "oom", message: "out of memory", permanent: false },
    });
    const row = one<{ error_kind: string; permanent: number }>(
      "SELECT error_kind, permanent FROM processing_run WHERE run_id=?",
      run.runId,
    )!;
    assert.equal(row.error_kind, "oom");
    assert.equal(row.permanent, 0);
    assert.equal(count("observation WHERE kind='run_failed' AND run_id=?", run.runId), 1);
  });

  it("失効後に復活したワーカーは完了させられない（#13）", async () => {
    const run = (await store.claimRun(claimArgs()))!;
    clock.advance(61_000);
    const r = await store.completeRun({ runId: run.runId, workerId: W1, status: "succeeded" });
    assert.deepEqual(r, { ok: false, reason: "stale_worker" });
    assert.equal(
      one<{ status: string }>("SELECT status FROM processing_run WHERE run_id=?", run.runId)!.status,
      "leased",
      "拒否された操作は状態を変えない",
    );
  });
});

describe("reapAbandonedRuns", () => {
  it("AC-RUN-07: 失効した leased を abandoned にし、変更行数を返す", async () => {
    const run = (await store.claimRun(claimArgs()))!;
    assert.equal(await store.reapAbandonedRuns(), 0, "まだ失効していない");

    clock.advance(61_000);
    assert.equal(await store.reapAbandonedRuns(), 1);
    assert.equal(
      one<{ status: string }>("SELECT status FROM processing_run WHERE run_id=?", run.runId)!.status,
      "abandoned",
    );
  });

  it("AC-RUN-08 / #14: ストアの時計だけを見る。呼び出し側の時計を巻き戻しても結果が変わらない", async () => {
    const storeClock = new TestClock(1000);
    const c = openStore({ clock: storeClock });
    const s = new SqliteLineageStore(c);
    const seeded = await seed(c);
    await s.claimRun({
      ...MATERIALS,
      inputIds: [seeded.versionId],
      rootVersionId: seeded.versionId,
      workerId: W1,
      leaseSeconds: 60,
    });

    // ワーカー側の時計は独立していて、しかも巻き戻っている
    const workerClock = new TestClock(1000);
    workerClock.rewindTo(0);
    assert.equal(workerClock.now(), 0);

    storeClock.advance(61_000);
    // reap にはワーカーの時計を渡す口がない。ストアの時計で失効している
    assert.equal(await s.reapAbandonedRuns(), 1);
    c.close();
  });

  it("succeeded や failed は回収しない", async () => {
    const run = (await store.claimRun(claimArgs()))!;
    await store.completeRun({ runId: run.runId, workerId: W1, status: "succeeded" });
    clock.advance(999_999);
    assert.equal(await store.reapAbandonedRuns(), 0);
  });
});

describe("#12: 同一 derivationKey への並行 claim（2接続・決定的）", () => {
  let dir: string;
  let a: StoreConnection;
  let b: StoreConnection;

  beforeEach(async () => {
    // :memory: は接続ごとに別 DB になるので、必ずファイル DB を使う
    dir = mkdtempSync(join(tmpdir(), "ingestion-frame-lease-"));
    const file = join(dir, "lineage.db");
    const shared = new TestClock(1000);

    a = openStore({ location: file, clock: shared });
    ({ docId, versionId } = await seed(a));

    // 待たずに即 BUSY を返させる。競合を決定的にするための唯一の用途
    b = openStore({ location: file, clock: shared, busyTimeoutMs: 0, applySchema: false });
  });

  afterEach(() => {
    a.close();
    b.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("勝者だけが leased を持ち、敗者は null を受け取る", async () => {
    const storeA = new SqliteLineageStore(a);
    const storeB = new SqliteLineageStore(b);
    const args = {
      ...MATERIALS,
      inputIds: [versionId],
      rootVersionId: versionId,
      leaseSeconds: 60,
    };

    // 1. A が RESERVED を保持したまま止まる
    a.db.exec("BEGIN IMMEDIATE");
    a.db.prepare("SELECT count(*) AS n FROM processing_run WHERE derivation_key = ?").get(keyFor(versionId));

    // 2. B は待たずに BUSY を受ける。これは「既にリースされている」ではないので
    //    null に翻訳してはいけない
    let busy = false;
    try {
      await storeB.claimRun({ ...args, workerId: W2 });
    } catch (error) {
      busy = /busy|locked/i.test((error as Error).message);
    }
    assert.ok(busy, "競合は BUSY として表面化する（null ではない）");

    // 3. A が書いてコミットする
    a.db
      .prepare(
        `INSERT INTO processing_run
           (run_id, derivation_key, document_id, root_version_id, status, attempt,
            worker_id, started_at, heartbeat_at, lease_expires_at, lease_seconds)
         VALUES ('run-a', ?, ?, ?, 'leased', 1, ?, 1000, 1000, 61000, 60)`,
      )
      .run(keyFor(versionId), docId, versionId, W1);
    a.db.exec("COMMIT");

    // 4. B が再試行すると、今度は状態を読んで null を返す
    assert.equal(await storeB.claimRun({ ...args, workerId: W2 }), null);

    // 5. leased は1件だけ
    const leased = b.db
      .prepare("SELECT count(*) AS n FROM processing_run WHERE derivation_key=? AND status='leased'")
      .get(keyFor(versionId)) as { n: number };
    assert.equal(leased.n, 1);
    void storeA;
  });

  it("AC-RUN-02: 部分ユニークインデックスが2件目の leased を拒む", () => {
    const insert = (runId: string, worker: string) =>
      a.db
        .prepare(
          `INSERT INTO processing_run
             (run_id, derivation_key, document_id, root_version_id, status, attempt,
              worker_id, started_at, heartbeat_at, lease_expires_at, lease_seconds)
           VALUES (?, ?, ?, ?, 'leased', 1, ?, 1000, 1000, 61000, 60)`,
        )
        .run(runId, keyFor(versionId), docId, versionId, worker);

    insert("run-a", W1);
    assert.throws(() => insert("run-b", W2), /UNIQUE|constraint/i);
  });

  it("BEGIN IMMEDIATE が無ければ競合が検出されないことを示す", () => {
    // BEGIN DEFERRED は読み取りロックしか取らないので、2接続が同時に
    // 「leased は無い」と読める。claimRun が IMMEDIATE を使う理由がこれ
    a.db.exec("BEGIN DEFERRED");
    b.db.exec("BEGIN DEFERRED");
    const readA = a.db.prepare("SELECT count(*) AS n FROM processing_run").get() as { n: number };
    const readB = b.db.prepare("SELECT count(*) AS n FROM processing_run").get() as { n: number };
    assert.equal(readA.n, readB.n, "両者が同じ「空」を見てから書きに行こうとする");
    a.db.exec("ROLLBACK");
    b.db.exec("ROLLBACK");
  });
});
