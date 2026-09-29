/**
 * AC-CMT-01..05 / AC-ACL-01..02
 *
 * v0.1 に Parser は無いので、実運用で通るのは **Artifact 0件の枝だけ**です
 * （KNOWN_LIMITATIONS 2節）。空配列の outputsHash = sha256("out:") が
 * 最初の検査対象になります。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { openStore, type StoreConnection } from "./connection.ts";
import { SqliteLineageStore } from "./lineage-store.ts";
import { TestClock } from "../../../test/support/clock.ts";
import { isStoreError } from "../../domain/errors.ts";
import { __unsafeArtifactId } from "../../../test/support/unsafe-brands.ts";
import { attestContentHash, attestPersisted } from "../../domain/evidence.ts";
import { artifactId as deriveArtifactId, derivationKey as deriveDerivationKey } from "../../domain/ids.ts";
import { assertInvariants, checkInvariants } from "../../../test/support/invariant-checker.ts";
import { expectedOutputsHash } from "../../../test/support/echo-processor.ts";
import { injectCrash, isInjectedCrash } from "../../../test/support/crash-injecting-store.ts";
import type {
  BlobKey,
  BlobReference,
  ContentHash,
  ArtifactDraft,
  DerivationDraft,
  DocumentId,
  RunId,
  ScanId,
  SourceId,
  VersionId,
  WorkerId,
} from "../../domain/types.ts";
import { __unsafeBlobKey } from "../../../test/support/unsafe-brands.ts";

const SRC = "src1" as SourceId;
const BP = { countRatioThresholdBp: 0, missingRatioThresholdBp: 10000 };
const W1 = "worker-1" as WorkerId;
const W2 = "worker-2" as WorkerId;
const hashOf = (t: string) => attestContentHash(Buffer.from(t, "utf8"));
const EMPTY_OUTPUTS = "7d33c9d029ac7d770c5ede79a2ae0989c9df1bd8b8ce5784e61ad7a8f0317ebe";

let clock: TestClock;
let conn: StoreConnection;
let store: SqliteLineageStore;
let docId: DocumentId;
let versionId: VersionId;
let runId: RunId;
/** beforeEach が開いた走査。同一 source の running は1件だけ（#1）なので使い回す */
let openScanId: ScanId;

const one = <T = Record<string, unknown>>(sql: string, ...p: unknown[]): T | undefined =>
  conn.db.prepare(sql).get(...(p as never[])) as T | undefined;
const count = (sql: string, ...p: unknown[]): number =>
  (one<{ n: number }>(`SELECT count(*) AS n FROM ${sql}`, ...p) ?? { n: -1 }).n;

/** 内容を持つ表の行数。NO_WORK_WITHOUT_CHANGE の判定に使う */
const contentRows = () => count("derivation") + count("artifact") + count("document_version");

const reader = { all: (sql: string) => Promise.resolve(conn.db.prepare(sql).all()) };

/** EchoProcessor 相当。v0.1 の唯一の経路である Artifact 0件を既定にする */
function derivation(over: Partial<DerivationDraft> = {}): DerivationDraft {
  return {
    processorName: "echo",
    processorVersion: "1",
    configHash: hashOf("{}"),
    inputIds: [versionId],
    ...over,
  };
}

/** inline の枝。本文だけを渡す。hash と size はストアが導出する（AC-CMT-07） */
const chunk = (ordinal: number, text: string): ArtifactDraft => ({
  ordinal,
  type: "chunk",
  kind: "inline",
  content: text,
});

/** その draft からストアが導出するのと同じ鍵 */
const keyOf = (draft: DerivationDraft = derivation()) =>
  deriveDerivationKey({
    processorName: draft.processorName,
    processorVersion: draft.processorVersion,
    configHash: draft.configHash,
    inputIds: draft.inputIds,
  });

/**
 * **その派生の鍵で**リースを取る。
 *
 * `commitDerivation` は runId とその鍵の一致を要求します。返り値の runId を
 * 使わずに別の run を渡すと `stale_worker`（mismatch: "key_mismatch"）で拒まれます。
 */
async function newLease(worker: WorkerId = W1, draft: DerivationDraft = derivation()): Promise<RunId> {
  const run = await store.claimRun({
    // 鍵ではなく材料を渡す。claim と commit が同じ関数で導出する
    processorName: draft.processorName,
    processorVersion: draft.processorVersion,
    configHash: draft.configHash,
    inputIds: draft.inputIds,
    rootVersionId: versionId,
    workerId: worker,
    leaseSeconds: 60,
  });
  assert.ok(run);
  return run.runId;
}

/**
 * 派生は残したまま、その鍵の run 記録だけを手放してリースを取り直す。
 *
 * 成功した派生の鍵は `#blockingRun` が恒久的に塞ぐので、
 * 同一プロセスの正規の経路では二度と claim できません（それが B の修正の目的）。
 * 分岐（#10, #11）は「別の台が処理した」「run の記録だけが失われた DB を復元した」
 * のような、**run の記録と derivation が食い違っている**状況でしか到達しません。
 * ここではその状況を直接作ります。
 *
 * DELETE ではなく status を落とすのは、observation.run_id の FK を壊さないためです。
 */
async function reclaimLease(worker: WorkerId = W1, draft: DerivationDraft = derivation()): Promise<RunId> {
  conn.db
    .prepare("UPDATE processing_run SET status='abandoned', finished_at=? WHERE derivation_key=?")
    .run(clock.now(), keyOf(draft));
  return newLease(worker, draft);
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
  openScanId = scan.scanId;
  const hash = hashOf("one");
  const observed = await store.recordObservedDocument(scan.scanId, {
    stableKey: "a.txt",
    outcome: { kind: "content", contentHash: hash, sizeBytes: 3 },
  });
  docId = observed.documentId;
  const v = await store.insertVersionIfAbsent({
    documentId: docId,
    contentHash: hash,
    sizeBytes: 3,
    blobKey: __unsafeBlobKey("b1"),
    blobVerifiedAt: attestPersisted(clock.now(), hash),
    mimeType: "text/plain",
    discoveredByScanId: scan.scanId,
    pipelineVersion: "v0.1",
  });
  versionId = v.versionId;
  await store.setActiveVersion({
    documentId: docId,
    observedHash: hash,
    versionId,
    scanId: scan.scanId,
  });
  runId = await newLease();
});

afterEach(() => conn.close());

describe("commitDerivation", () => {
  it("AC-CMT-01: Artifact 0件で commit すると outputsHash が sha256(\"out:\")", async () => {
    const r = await store.commitDerivation({
      derivation: derivation(),
      artifacts: [],
      runId,
      workerId: W1,
    });
    assert.equal(r.created, true);

    const row = one<{ artifact_count: number; outputs_hash: string; created_at: number }>(
      "SELECT artifact_count, outputs_hash, created_at FROM derivation WHERE derivation_key=?",
      r.derivationKey,
    )!;
    assert.equal(row.artifact_count, 0);
    assert.equal(row.outputs_hash, EMPTY_OUTPUTS);
    assert.equal(row.created_at, 1000, "createdAt はストアの時計が刻む");
    assert.equal(
      one<{ status: string }>("SELECT status FROM processing_run WHERE run_id=?", runId)!.status,
      "succeeded",
    );
  });

  it("derivationKey はストアが導出する", async () => {
    const draft = derivation();
    const r = await store.commitDerivation({ derivation: draft, artifacts: [], runId, workerId: W1 });
    assert.equal(
      r.derivationKey,
      deriveDerivationKey({
        processorName: draft.processorName,
        processorVersion: draft.processorVersion,
        configHash: draft.configHash,
        inputIds: draft.inputIds,
      }),
    );
  });

  it("Artifact つきの commit では artifactId が導出され ordinal 順に並ぶ", async () => {
    const r = await store.commitDerivation({
      derivation: derivation(),
      artifacts: [chunk(0, "alpha"), chunk(1, "beta")],
      runId,
      workerId: W1,
    });
    assert.equal(
      one<{ artifact_id: string }>("SELECT artifact_id FROM artifact WHERE ordinal=0")!.artifact_id,
      deriveArtifactId(r.derivationKey, 0),
    );
    assert.equal(count("artifact"), 2);
    assert.equal(
      one<{ artifact_count: number }>("SELECT artifact_count FROM derivation")!.artifact_count,
      2,
    );
  });

  it("ordinal に穴があれば hash を計算せず落とす（#10 の残骸を通さない）", async () => {
    await assert.rejects(
      () =>
        store.commitDerivation({
          derivation: derivation(),
          artifacts: [chunk(0, "a"), chunk(2, "c")],
          runId,
          workerId: W1,
        }),
      /ordinals must be 0\.\.n-1/,
    );
    assert.equal(contentRows(), 1, "version 1行のみ。derivation も artifact も書かれない");
  });

  it("AC-CMT-02: 同一内容の再 commit は created:false / 内容の行は増えない", async () => {
    await store.commitDerivation({ derivation: derivation(), artifacts: [], runId, workerId: W1 });
    const before = contentRows();

    runId = await reclaimLease(W1);
    const again = await store.commitDerivation({
      derivation: derivation(),
      artifacts: [],
      runId,
      workerId: W1,
    });
    assert.equal(again.created, false);
    assert.equal(contentRows(), before);
  });

  it("AC-CMT-03: 同一 key で内容が違えば DerivationDivergenceError", async () => {
    await store.commitDerivation({
      derivation: derivation(),
      artifacts: [chunk(0, "alpha")],
      runId,
      workerId: W1,
    });
    const stored = one<{ outputs_hash: string }>("SELECT outputs_hash FROM derivation")!.outputs_hash;

    // 依存ライブラリ版の違う2台目が、同じ入力から違う出力を作った
    runId = await reclaimLease(W1);
    await assert.rejects(
      () =>
        store.commitDerivation({
          derivation: derivation(),
          artifacts: [chunk(0, "ALPHA")],
          runId,
          workerId: W1,
        }),
      (e: unknown) => isStoreError(e, "derivation_divergence"),
    );

    // 元の行はそのまま。先着が正になるのではなく、失敗として表面化する
    assert.equal(one<{ outputs_hash: string }>("SELECT outputs_hash FROM derivation")!.outputs_hash, stored);
    assert.equal(count("artifact"), 1);
  });

  it("AC-CMT-03: 分岐の記録はロールバックで消えず1件残る（8節の順序）", async () => {
    await store.commitDerivation({
      derivation: derivation(),
      artifacts: [chunk(0, "alpha")],
      runId,
      workerId: W1,
    });
    runId = await reclaimLease(W1);
    await assert.rejects(() =>
      store.commitDerivation({
        derivation: derivation(),
        artifacts: [chunk(0, "ALPHA")],
        runId,
        workerId: W1,
      }),
    );

    assert.equal(count("observation WHERE kind='derivation_output_divergence'"), 1);
    const detail = JSON.parse(
      one<{ detail: string }>(
        "SELECT detail FROM observation WHERE kind='derivation_output_divergence'",
      )!.detail,
    );
    assert.notEqual(detail.storedOutputsHash, detail.incomingOutputsHash);
  });

  it("個数だけが違う場合も分岐として扱う（#10: 和集合にしない）", async () => {
    await store.commitDerivation({
      derivation: derivation(),
      artifacts: [chunk(0, "a"), chunk(1, "b")],
      runId,
      workerId: W1,
    });
    runId = await reclaimLease(W1);
    await assert.rejects(
      () =>
        store.commitDerivation({
          derivation: derivation(),
          artifacts: [chunk(0, "a")],
          runId,
          workerId: W1,
        }),
      (e: unknown) => isStoreError(e, "derivation_divergence"),
    );
    assert.equal(count("artifact"), 2, "1回目の2件がそのまま残る（混ざらない）");
  });

  it("AC-CMT-05: 失効したワーカーは commit できない（B-3 / #13）", async () => {
    clock.advance(61_000);
    await assert.rejects(
      () => store.commitDerivation({ derivation: derivation(), artifacts: [], runId, workerId: W1 }),
      (e: unknown) => isStoreError(e, "stale_worker"),
    );
    assert.equal(count("derivation"), 0);
    assert.equal(count("observation WHERE kind='stale_worker_rejected'"), 1);
  });

  it("別ワーカーは commit できない", async () => {
    await assert.rejects(
      () => store.commitDerivation({ derivation: derivation(), artifacts: [], runId, workerId: W2 }),
      (e: unknown) => isStoreError(e, "stale_worker"),
    );
    assert.equal(count("derivation"), 0);
  });

  it("processorVersion が変われば別の鍵になり、両方が並存する（AGENTS.md 3.3）", async () => {
    const a = await store.commitDerivation({
      derivation: derivation(),
      artifacts: [],
      runId,
      workerId: W1,
    });
    // 別の鍵なので、その鍵で改めてリースを取る。手放す必要はない
    const run2 = await newLease(W1, derivation({ processorVersion: "2" }));
    const b = await store.commitDerivation({
      derivation: derivation({ processorVersion: "2" }),
      artifacts: [],
      runId: run2,
      workerId: W1,
    });
    assert.notEqual(a.derivationKey, b.derivationKey);
    assert.equal(count("derivation"), 2);
  });

  /**
   * 回帰試験その1。**鍵Xのリースで鍵Yの派生を確定できない。**
   *
   * これが通っていた頃は、`#succeedRun` が鍵Xのリースを鍵Yの commit で閉じていた。
   * 閉じられた鍵は `#blockingRun` が恒久的に塞ぐので、鍵Xは二度と処理できなくなる。
   *
   * 修正は「runId を消す」ではなく「runId とその鍵の一致を要求する」。
   * 消すと世代が守れなくなる（回帰試験その2）。
   */
  it("別の鍵のリースで commit できない（B の回帰試験・鍵の側）", async () => {
    const other = derivation({ processorVersion: "other" });
    const otherRunId = await newLease(W2, other);
    assert.notEqual(keyOf(other), keyOf(), "前提: 2つの鍵は別物");

    // W2 は other の鍵の run しか持っていない。既定の鍵の派生は確定できない
    await assert.rejects(
      () =>
        store.commitDerivation({
          derivation: derivation(),
          artifacts: [],
          runId: otherRunId,
          workerId: W2,
        }),
      (e: unknown) => isStoreError(e, "stale_worker"),
    );

    assert.equal(count("derivation"), 0, "1行も書かれていない");
    assert.equal(
      one<{ status: string }>("SELECT status FROM processing_run WHERE run_id=?", otherRunId)!.status,
      "leased",
      "渡された run が巻き添えで閉じられていない。閉じられると鍵が永久に塞がる",
    );

    // 拒否は記録に残り、**どちらの識別子が食い違ったか**まで分かる
    const detail = JSON.parse(
      one<{ detail: string }>(
        "SELECT detail FROM observation WHERE kind='stale_worker_rejected'",
      )!.detail,
    );
    assert.equal(detail.mismatch, "key_mismatch", "世代でも名乗りでもなく鍵が食い違った");
    assert.equal(detail.derivationKey, keyOf(), "derivation から導出された鍵");
    assert.equal(detail.runDerivationKey, keyOf(other), "run が指していた鍵");
    assert.equal(detail.workerId, W2);
    assert.equal(detail.runId, otherRunId);
    assert.equal(detail.status, "leased", "run 自体は生きている。食い違ったのは鍵だけ");

    // 自分の鍵の run で確定する分には通る
    const ok = await store.commitDerivation({
      derivation: derivation(),
      artifacts: [],
      runId,
      workerId: W1,
    });
    assert.equal(ok.created, true);
    assert.equal(
      one<{ status: string }>("SELECT status FROM processing_run WHERE run_id=?", otherRunId)!.status,
      "leased",
      "他の鍵のリースは最後まで無傷",
    );
  });

  /**
   * 回帰試験その2。**失効して取り直した後、古い世代の commit は通らない。**
   *
   * runId を消して「その鍵の生きたリースの持ち主か」だけを見ていた時期は、
   * これが通っていた:
   *
   *   1. W が鍵 K を claim → R1
   *   2. W が固まる。リースが失効し reap される
   *   3. **同じ W** が K を再 claim → R2
   *   4. R1 の遅れてきた commit が到着 → 鍵も名乗りも一致するので通り、**R2 が閉じる**
   *
   * workerId はホスト/プロセスの識別子であって世代の識別子ではないので、
   * 名乗りだけでは 1 と 3 を区別できません。区別しているのは runId です。
   * これが #13 の主張を commitDerivation 経路で成立させている唯一の根拠。
   */
  it("失効して取り直した後、古い世代の commit は通らない（B の回帰試験・世代の側）", async () => {
    const oldRun = runId;

    clock.advance(61_000);
    assert.equal(await store.reapAbandonedRuns(), 1, "前提: 古い世代は reap された");

    const newRun = await newLease(W1); // 同じワーカーが同じ鍵を取り直す
    assert.notEqual(newRun, oldRun, "前提: 世代は変わったが workerId は同じ");

    await assert.rejects(
      () =>
        store.commitDerivation({
          derivation: derivation(),
          artifacts: [chunk(0, "stale work")],
          runId: oldRun,
          workerId: W1,
        }),
      (e: unknown) => isStoreError(e, "stale_worker"),
      "鍵も名乗りも一致するが、世代が古い",
    );

    assert.equal(count("derivation"), 0, "古い世代の成果物が正本になっていない");
    assert.equal(
      one<{ status: string }>("SELECT status FROM processing_run WHERE run_id=?", newRun)!.status,
      "leased",
      "新しい世代が巻き添えで閉じられていない。閉じられると鍵が永久に塞がる",
    );

    const detail = JSON.parse(
      one<{ detail: string }>(
        "SELECT detail FROM observation WHERE kind='stale_worker_rejected'",
      )!.detail,
    );
    assert.equal(detail.mismatch, "not_leased", "鍵は合っている。落ちたのは世代の条件");
    assert.equal(detail.runId, oldRun);
    assert.equal(detail.runDerivationKey, keyOf(), "鍵は一致していた");
    assert.equal(detail.owner, W1, "名乗りも一致していた");

    // 現世代なら通る
    const ok = await store.commitDerivation({
      derivation: derivation(),
      artifacts: [chunk(0, "fresh work")],
      runId: newRun,
      workerId: W1,
    });
    assert.equal(ok.created, true);
  });

  it("commit した状態が不変条件を満たす", async () => {
    await store.commitDerivation({
      derivation: derivation(),
      artifacts: [chunk(0, "alpha"), chunk(1, "beta")],
      runId,
      workerId: W1,
    });
    const report = await checkInvariants({ reader });
    assert.doesNotThrow(() => assertInvariants(report));
  });
});

/**
 * **「リースが生きている」の述語は1つしかない（`#liveLease`）。**
 *
 * heartbeat / completeRun / commitDerivation は同じ判定を通ります。
 * 述語を各経路に写経していた頃、条件が片方だけ抜けると
 * 「heartbeat は ok なのに commit は lease_expired」という食い違いが起きえました。
 * 一番危ないのが**失効しているが reap がまだ走っていない窓**です。
 * そこは status が 'leased' のままなので、期限を見ない経路だけが通してしまいます。
 *
 * ここで確かめているのは2つです。
 *
 *   1. 3経路の**可否が一致する**（述語が一本であることの外から見える証拠）
 *   2. 記録された `mismatch` が**拒否した理由と同じ**である
 *
 * 2 が要ります。判定に使った行と記録に使う行が別読みだと、間に reaper が入って
 * 「lease_expired で拒否したのに記録は not_leased」になります。監査のための
 * 5分岐なので、そこがずれると分岐そのものの意味が消えます。
 * `#liveLease` が読んだ行をそのまま `#staleLeaseDraft` に渡すのは、
 * その窓を構文的に無くすためです。
 */
describe("リースの述語は3経路で一本（#liveLease）", () => {
  const details = (): ReadonlyArray<Record<string, unknown>> =>
    (
      conn.db
        .prepare(
          "SELECT detail FROM observation WHERE kind='stale_worker_rejected' ORDER BY observation_seq",
        )
        .all() as Array<{ detail: string }>
    ).map((r) => JSON.parse(r.detail) as Record<string, unknown>);

  /** 3経路すべてを同じ run / 名乗りで叩く。どれも拒否されるはずの状況でだけ使う */
  async function allThree(run: RunId, worker: WorkerId): Promise<ReadonlyArray<string>> {
    const hb = await store.heartbeat(run, worker);
    const done = await store.completeRun({ runId: run, workerId: worker, status: "succeeded" });
    let commit = "ok";
    try {
      await store.commitDerivation({ derivation: derivation(), artifacts: [], runId: run, workerId: worker });
    } catch (e) {
      commit = isStoreError(e, "stale_worker") ? "stale_worker" : `unexpected:${String(e)}`;
    }
    return [hb.reason ?? "ok", done.reason ?? "ok", commit];
  }

  const expectAllRejected = (results: ReadonlyArray<string>, mismatch: string) => {
    assert.deepEqual(results, ["stale_worker", "stale_worker", "stale_worker"]);
    assert.deepEqual(
      details().map((d) => d["mismatch"]),
      [mismatch, mismatch, mismatch],
      "3経路が同じ理由で落ちている。記録も拒否と同じ行から書かれている",
    );
    assert.deepEqual(
      details().map((d) => d["operation"]),
      ["heartbeat", "completeRun", "commitDerivation"],
    );
  };

  it("失効しているが reap 前の窓で、3経路とも lease_expired で落ちる", async () => {
    clock.advance(61_000);
    // あえて reapAbandonedRuns を呼ばない。status は 'leased' のまま
    assert.equal(
      one<{ status: string }>("SELECT status FROM processing_run WHERE run_id=?", runId)!.status,
      "leased",
      "前提: 行はまだ leased。生死を決めているのは status ではなく期限",
    );
    expectAllRejected(await allThree(runId, W1), "lease_expired");
    assert.equal(count("derivation"), 0);
  });

  it("reap 後は3経路とも not_leased で落ちる（同じ窓の反対側）", async () => {
    clock.advance(61_000);
    assert.equal(await store.reapAbandonedRuns(), 1);
    expectAllRejected(await allThree(runId, W1), "not_leased");
  });

  it("別ワーカーは3経路とも other_worker で落ちる", async () => {
    expectAllRejected(await allThree(runId, W2), "other_worker");
    assert.equal(
      one<{ status: string }>("SELECT status FROM processing_run WHERE run_id=?", runId)!.status,
      "leased",
      "正当な持ち主のリースが巻き添えで閉じられていない",
    );
  });

  it("存在しない run は3経路とも run_missing で落ちる", async () => {
    expectAllRejected(await allThree("run-does-not-exist" as RunId, W1), "run_missing");
    // run_id 列に入れると FK 違反になるので参照は張らない。detail には必ず残る
    assert.equal(count("observation WHERE kind='stale_worker_rejected' AND run_id IS NULL"), 3);
    for (const d of details()) assert.equal(d["runId"], "run-does-not-exist");
  });

  it("key_mismatch は鍵を渡す commit にしか無い", async () => {
    const other = derivation({ processorVersion: "other" });
    const otherRunId = await newLease(W2, other);

    // 鍵を渡さない2経路にとって、この run は完全に正当
    assert.deepEqual(await store.heartbeat(otherRunId, W2), { ok: true });
    assert.equal(count("observation WHERE kind='stale_worker_rejected'"), 0);

    await assert.rejects(
      () =>
        store.commitDerivation({
          derivation: derivation(),
          artifacts: [],
          runId: otherRunId,
          workerId: W2,
        }),
      (e: unknown) => isStoreError(e, "stale_worker"),
    );
    assert.equal(details()[0]!["mismatch"], "key_mismatch");
  });

  it("鍵の2列は commit にだけ載る。突き合わせる相手が無い経路には載せない", async () => {
    await store.heartbeat(runId, W2); // other_worker で拒否される
    await assert.rejects(
      () =>
        store.commitDerivation({ derivation: derivation(), artifacts: [], runId, workerId: W2 }),
      (e: unknown) => isStoreError(e, "stale_worker"),
    );

    const [hb, commit] = details();
    assert.deepEqual(
      Object.keys(hb!).sort(),
      ["mismatch", "operation", "owner", "runId", "status", "workerId"],
      "heartbeat には derivationKey / runDerivationKey は無い。比べる鍵が無いので",
    );
    assert.deepEqual(
      Object.keys(commit!).sort(),
      [
        "derivationKey",
        "mismatch",
        "operation",
        "owner",
        "runDerivationKey",
        "runId",
        "status",
        "workerId",
      ],
      "commit だけが両方の鍵を残す。食い違いをどちらが正しかったかまで読めるように。" +
        "**原本の対はここに無い** —— 渡す口が無いので、食い違いが起こらない",
    );
  });
});

/**
 * AC-CMT-06（2026-09-10 の指摘 1）
 *
 * **原本と文書を渡す口が無い。** 以前は `DerivationDraft` が
 * `rootVersionId` / `documentId` を持っており、文書 A の run で「原本は文書 B の版」
 * という派生・artifact が確定できました（`LINEAGE_COMPLETE` の
 * `artifact_document_disagrees_with_version` に触れる行が入る）。しかも A は
 * `succeeded` になるので再 claim は `null` で拒まれます。
 * 鍵の材料に `rootVersionId` は入っていないので、鍵の照合では止まりません。
 *
 * いまは検証した run の `root_version_id` を原本とし、その版の行から文書を引きます。
 * **一致を要求するのではなく、受け取りません。** 渡す口が無ければ、
 * 食い違いは表現できません（口が無いことは型検査が見ます。
 * `test/types/derivation-key-authority.test.ts`）。
 */
describe("AC-CMT-06: 系譜は run の原本から決まる", () => {
  /** 同じ走査で見つかった別の文書 */
  async function otherDocument(): Promise<{ documentId: DocumentId; versionId: VersionId }> {
    const hash = hashOf("two");
    const observed = await store.recordObservedDocument(openScanId, {
      stableKey: "b.txt",
      outcome: { kind: "content", contentHash: hash, sizeBytes: 3 },
    });
    const v = await store.insertVersionIfAbsent({
      documentId: observed.documentId,
      contentHash: hash,
      sizeBytes: 3,
      blobKey: __unsafeBlobKey("b2"),
      blobVerifiedAt: attestPersisted(clock.now(), hash),
      mimeType: "text/plain",
      discoveredByScanId: openScanId,
      pipelineVersion: "v0.1",
    });
    // ポインタも立てる。立てないと POINTER_MATCHES_OBSERVATION が
    // 「版はあるのに active が無い」で鳴り、攻撃と無関係な赤になる
    await store.setActiveVersion({
      documentId: observed.documentId,
      observedHash: hash,
      versionId: v.versionId,
      scanId: openScanId,
    });
    return { documentId: observed.documentId, versionId: v.versionId };
  }

  // node:sqlite の行は null プロトタイプなので、比較の前に素のオブジェクトにする
  const lineageOf = (key: string) => ({
    ...one<{ root_version_id: string; document_id: string }>(
      "SELECT root_version_id, document_id FROM derivation WHERE derivation_key=?",
      key,
    )!,
  });

  it("A の run で確定すると、A の原本と A の文書が書かれる", async () => {
    const r = await store.commitDerivation({
      derivation: derivation(),
      artifacts: [chunk(0, "alpha")],
      runId,
      workerId: W1,
    });
    assert.equal(r.created, true, "正しい確定は成功する");

    assert.deepEqual(lineageOf(r.derivationKey), {
      root_version_id: versionId,
      document_id: docId,
    });
    const artifact = one<{ root_version_id: string; document_id: string }>(
      "SELECT root_version_id, document_id FROM artifact WHERE derivation_key=?",
      r.derivationKey,
    )!;
    assert.deepEqual({ ...artifact }, { root_version_id: versionId, document_id: docId });
    const report = await checkInvariants({ reader });
    assert.doesNotThrow(() => assertInvariants(report));
  });

  it("B の版で取った run は B の系譜を書く。run が原本を決めている", async () => {
    const other = await otherDocument();
    const draft = derivation({ inputIds: [other.versionId] });
    const run = await store.claimRun({
      ...draft,
      rootVersionId: other.versionId,
      workerId: W1,
      leaseSeconds: 60,
    });
    assert.ok(run);

    const r = await store.commitDerivation({
      derivation: draft,
      artifacts: [],
      runId: run.runId,
      workerId: W1,
    });
    assert.deepEqual(lineageOf(r.derivationKey), {
      root_version_id: other.versionId,
      document_id: other.documentId,
    });
  });

  it("原本は inputIds ではなく run から来る", async () => {
    // 入力に B の版を挙げ、原本は A の版で claim する。鍵は inputIds から決まるので
    // 一致し、commit は通る。書かれる系譜は **A**（run の原本）でなければならない
    const other = await otherDocument();
    const draft = derivation({ inputIds: [other.versionId] });
    const run = await store.claimRun({
      ...draft,
      rootVersionId: versionId,
      workerId: W1,
      leaseSeconds: 60,
    });
    assert.ok(run);

    const r = await store.commitDerivation({
      derivation: draft,
      artifacts: [chunk(0, "alpha")],
      runId: run.runId,
      workerId: W1,
    });
    assert.deepEqual(lineageOf(r.derivationKey), {
      root_version_id: versionId,
      document_id: docId,
    });

    // 文書と原本が食い違う行は入らない（それが指摘1の署名だった）
    const report = await checkInvariants({ reader });
    assert.doesNotThrow(() => assertInvariants(report));
  });

  it("run の鍵と材料の鍵が違えば、原本を決める前に落ちる", async () => {
    const other = derivation({ processorVersion: "other" });
    const otherRunId = await newLease(W2, other);
    await assert.rejects(
      () =>
        store.commitDerivation({ derivation: derivation(), artifacts: [], runId: otherRunId, workerId: W2 }),
      (e: unknown) => isStoreError(e, "stale_worker"),
    );
    assert.equal(count("derivation"), 0);
  });
});

/**
 * AC-CMT-07（2026-09-10 の指摘 3）
 *
 * **inline の hash と size を渡す口が無い。** 以前は `ArtifactDraft` が
 * `contentHash` を受け取っており、本文 `"WRONG"` に
 * `attestContentHash(Buffer.from("RIGHT"))` ——正規の鋳造元から出た本物の証拠——を
 * 付けた artifact が確定でき、`sizeBytes` は 99999 でも通り、**15項目すべてが緑**
 * でした。証拠型は「ある実在のバイト列を読み切った」ことしか運ばず、
 * *どの*バイト列かは運びません（KNOWN_LIMITATIONS 11.4/11.5）。
 * 監査も届きません——`HASH_MATCHES_BLOB` は `blob_key IS NOT NULL` の行しか見ません。
 *
 * 軸4（述語の費用）が「払えない」と裁定したのは blob の再読についてです。
 * inline の本文は draft の中にあるので、その理由は当てはまりません。
 */
describe("AC-CMT-07: inline の hash と size はストアが本文から導出する", () => {
  /** ストアの実装を import せずに検算する。同じ関数で確かめても何も言えない */
  const sha256Of = (text: string): string =>
    createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

  const storedArtifact = (key: string, ordinal = 0) =>
    one<{ inline_content: string; content_hash: string; size_bytes: number; blob_key: string | null }>(
      "SELECT inline_content, content_hash, size_bytes, blob_key FROM artifact WHERE derivation_key=? AND ordinal=?",
      key,
      ordinal,
    )!;

  it("保存される hash と size は本文から決まる", async () => {
    const text = "alpha";
    const r = await store.commitDerivation({
      derivation: derivation(),
      artifacts: [chunk(0, text)],
      runId,
      workerId: W1,
    });

    const row = storedArtifact(r.derivationKey);
    assert.equal(row.inline_content, text, "本文は正規化されない");
    assert.equal(row.content_hash, sha256Of(text));
    assert.equal(row.size_bytes, Buffer.byteLength(text, "utf8"));
    assert.equal(row.blob_key, null);
  });

  it("非ASCII は文字数ではなくバイト長で入る", async () => {
    const text = "日本語 ok";
    assert.notEqual(text.length, Buffer.byteLength(text, "utf8"), "前提: 文字数とバイト長が違う");

    const r = await store.commitDerivation({
      derivation: derivation(),
      artifacts: [chunk(0, text)],
      runId,
      workerId: W1,
    });
    const row = storedArtifact(r.derivationKey);
    assert.equal(row.inline_content, text);
    assert.equal(row.content_hash, sha256Of(text));
    assert.equal(row.size_bytes, Buffer.byteLength(text, "utf8"));
  });

  it("本文が NFC/NFD で違えば、別の hash になる（畳まない）", async () => {
    // 正規化を入れると、保存された本文と hash の原像が別物になり、
    // 独立した検算（監査器）が偽の不一致を報告する
    const nfc = "café".normalize("NFC");
    const nfd = "café".normalize("NFD");
    assert.notEqual(nfc, nfd, "前提: 2つの文字列は別物");

    const r = await store.commitDerivation({
      derivation: derivation(),
      artifacts: [chunk(0, nfd)],
      runId,
      workerId: W1,
    });
    const row = storedArtifact(r.derivationKey);
    assert.equal(row.inline_content, nfd);
    assert.equal(row.content_hash, sha256Of(nfd));
    assert.notEqual(row.content_hash, sha256Of(nfc));
  });

  it("outputsHash も導出値から計算される", async () => {
    const texts = ["alpha", "beta"];
    const r = await store.commitDerivation({
      derivation: derivation(),
      artifacts: texts.map((t, i) => chunk(i, t)),
      runId,
      workerId: W1,
    });

    assert.equal(
      one<{ outputs_hash: string }>(
        "SELECT outputs_hash FROM derivation WHERE derivation_key=?",
        r.derivationKey,
      )!.outputs_hash,
      expectedOutputsHash(
        texts.map((t, i) => ({
          artifactId: deriveArtifactId(r.derivationKey, i),
          contentHash: sha256Of(t) as ContentHash,
        })),
      ),
      "宣言された hash ではなく、本文から導出された hash が根拠になっている",
    );
  });

  it("blob の枝は依然として受け取る（軸4 の裁定どおり）", async () => {
    // ここで通ることは欠陥ではありません。確定時に全 artifact の blob を
    // 再読する述語は払えないので、実体との一致は HASH_MATCHES_BLOB が見ます
    // （KNOWN_LIMITATIONS 11.5）
    const r = await store.commitDerivation({
      derivation: derivation(),
      artifacts: [
        {
          ordinal: 0,
          type: "chunk",
          kind: "blob",
          blobKey: __unsafeBlobKey("nowhere"),
          contentHash: hashOf("RIGHT"),
          sizeBytes: 5,
        },
      ],
      runId,
      workerId: W1,
    });
    assert.equal(r.created, true);
    assert.equal(storedArtifact(r.derivationKey).inline_content, null);
  });
});

describe("AC-CMT-04: 部分成立が無い（#9）", () => {
  it("COMMIT 直前で落ちると derivation も artifact も run 完了も残らない", async () => {
    // COMMIT の実行だけを失敗させる。プロセスを落とす必要はない
    const crash = injectCrash(conn, { at: "before_commit" });

    await assert.rejects(
      () =>
        store.commitDerivation({
          derivation: derivation(),
          artifacts: [chunk(0, "alpha")],
          runId,
          workerId: W1,
        }),
      isInjectedCrash,
    );
    assert.equal(crash.fired, 1, "注入点に到達していないまま緑になっていない");
    crash.restore();

    assert.equal(count("derivation"), 0, "Derivation だけ残ることはない");
    assert.equal(count("artifact"), 0);
    assert.equal(
      one<{ status: string }>("SELECT status FROM processing_run WHERE run_id=?", runId)!.status,
      "leased",
      "run も完了していない",
    );

    // 再実行すれば通る。「Derivation 行があるから処理済み」と誤読する余地がない
    const retry = await store.commitDerivation({
      derivation: derivation(),
      artifacts: [chunk(0, "alpha")],
      runId,
      workerId: W1,
    });
    assert.equal(retry.created, true);
    assert.equal(count("artifact"), 1);

    const report = await checkInvariants({ reader });
    assert.doesNotThrow(() => assertInvariants(report));
  });

  it("BEGIN 直後で落ちても何も残らない", async () => {
    const crash = injectCrash(conn, { at: "after_begin" });
    await assert.rejects(
      () => store.commitDerivation({ derivation: derivation(), artifacts: [], runId, workerId: W1 }),
      isInjectedCrash,
    );
    crash.restore();
    assert.equal(contentRows(), 1, "既存の版1行だけ。derivation も artifact も増えていない");
  });

  /**
   * #10 の再現: 1回目が途中まで Artifact を書いてクラッシュする。
   *
   * 2件目の INSERT の直前で落とすので、1件目は「書けている」状態です。
   * それでも1件も残らないことが、和集合が構造的に起きない根拠になります。
   */
  it("Artifact を途中まで書いた状態で落ちても、残骸は1件も残らない（#10）", async () => {
    const crash = injectCrash(conn, {
      at: "before_statement",
      matching: "INSERT INTO artifact",
      occurrence: 2,
    });

    await assert.rejects(
      () =>
        store.commitDerivation({
          derivation: derivation(),
          artifacts: [chunk(0, "a"), chunk(1, "b"), chunk(2, "c")],
          runId,
          workerId: W1,
        }),
      isInjectedCrash,
    );
    assert.equal(crash.reached, 2, "1件目は実際に書かれた後で落ちている");
    crash.restore();

    assert.equal(count("artifact"), 0, "ordinal 0 の残骸が残ると #10 の和集合になる");
    assert.equal(count("derivation"), 0);

    // 2回目は3件生成する。1回目の残骸と和集合にならないことを確かめる
    const retry = await store.commitDerivation({
      derivation: derivation(),
      artifacts: [chunk(0, "a"), chunk(1, "b"), chunk(2, "c")],
      runId,
      workerId: W1,
    });
    assert.equal(retry.created, true);
    assert.equal(count("artifact"), 3);
    const report = await checkInvariants({ reader });
    assert.doesNotThrow(() => assertInvariants(report));
  });
});

/**
 * KNOWN_LIMITATIONS 9節の窓を実測する。
 *
 * ロールバック後の後書きは正しい判断ですが、ROLLBACK と観測書き込みの間で
 * 落ちると記録が消えます。**この窓が存在することを緑のテストで固定します。**
 * 「拒否は必ず監査に残る」という成立していない主張を、
 * どこにも書かないための一本です。
 */
describe("ロールバック後の後書きが失われる窓（KNOWN_LIMITATIONS 9節）", () => {
  it("分岐は検出されるが、記録が書かれる前に落ちると監査に残らない", async () => {
    await store.commitDerivation({
      derivation: derivation(),
      artifacts: [chunk(0, "alpha")],
      runId,
      workerId: W1,
    });
    runId = await reclaimLease(W1);
    // 同じ derivationKey に別の出力が到着する（#10, #11）
    const divergent = { derivation: derivation(), artifacts: [chunk(0, "beta")], runId, workerId: W1 };

    // 1回目の BEGIN は commitDerivation 本体。2回目が後書きのトランザクション
    const crash = injectCrash(conn, { at: "after_begin", occurrence: 2 });
    await assert.rejects(
      () => store.commitDerivation(divergent),
      (error: unknown) => {
        // **監査の失敗で例外の型が変わらない。** 呼び出し側の再試行判断は
        // code に依存しているので、ここが化けると「分岐が起きた」が
        // 「一時的な書き込みエラー」に見え、そのまま再試行される
        assert.ok(isStoreError(error, "derivation_divergence"), "code は分岐のまま");
        assert.ok(
          isInjectedCrash((error as { observationWriteError?: unknown }).observationWriteError),
          "二次的な失敗は別名のプロパティで運ばれる。cause は上書きしない",
        );
        assert.equal((error as Error).cause, undefined);
        return true;
      },
    );
    assert.equal(crash.fired, 1);
    crash.restore();

    assert.equal(
      count("observation WHERE kind='derivation_output_divergence'"),
      0,
      "窓は実在する。ここが 1 になったら KNOWN_LIMITATIONS 9節を消せる",
    );
    // 失われたのは記録だけ。状態は正しいまま
    assert.equal(count("derivation"), 1);
    assert.equal(count("artifact"), 1);
    assert.equal(
      one<{ inline_content: string }>("SELECT inline_content FROM artifact")!.inline_content,
      "alpha",
      "後着が先着を上書きしていない",
    );
  });

  it("窓の外なら記録は残る（同じ経路で注入しなければ）", async () => {
    await store.commitDerivation({
      derivation: derivation(),
      artifacts: [chunk(0, "alpha")],
      runId,
      workerId: W1,
    });
    runId = await reclaimLease(W1);
    await assert.rejects(
      () =>
        store.commitDerivation({
          derivation: derivation(),
          artifacts: [chunk(0, "beta")],
          runId,
          workerId: W1,
        }),
      (e: unknown) => isStoreError(e, "derivation_divergence"),
    );
    assert.equal(count("observation WHERE kind='derivation_output_divergence'"), 1);
  });
});

describe("upsertAcl", () => {
  // documentId は呼び出しごとに必ず与える。土台には持たせない
  const synced = { tenantId: "t1", state: "synced" as const };

  it("synced な ACL は syncedAt がストアの時計で入る", async () => {
    clock.setTo(5555);
    await store.upsertAcl({
      ...synced,
      documentId: docId,
      principals: ["group:eng", "user:alice"],
      aclHash: hashOf("acl1"),
    });
    const row = one<{ synced_at: number; last_attempt_at: number; principals: string }>(
      "SELECT synced_at, last_attempt_at, principals FROM access_control",
    )!;
    assert.equal(row.synced_at, 5555);
    assert.equal(row.last_attempt_at, 5555);
    assert.deepEqual(JSON.parse(row.principals), ["group:eng", "user:alice"]);
  });

  it("principals は昇順に正規化される（比較の安定のため）", async () => {
    await store.upsertAcl({
      ...synced,
      documentId: docId,
      principals: ["user:zoe", "group:a"],
      aclHash: "h",
    });
    assert.deepEqual(
      JSON.parse(one<{ principals: string }>("SELECT principals FROM access_control")!.principals),
      ["group:a", "user:zoe"],
    );
  });

  it("AC-ACL-01: 取得失敗（unknown）は既存の synced を上書きしない（#29）", async () => {
    await store.upsertAcl({
      ...synced,
      documentId: docId,
      principals: ["user:alice"],
      aclHash: "h1",
    });
    clock.advance(1000);

    await store.upsertAcl({
      documentId: docId,
      tenantId: "t1",
      state: "unknown",
      principals: [],
      aclHash: "h1",
      lastError: "ETIMEDOUT",
    });

    const row = one<{ state: string; principals: string; synced_at: number; last_attempt_at: number; last_error: string }>(
      "SELECT state, principals, synced_at, last_attempt_at, last_error FROM access_control",
    )!;
    assert.equal(row.state, "synced", "既存の同期済み ACL は残る");
    assert.deepEqual(JSON.parse(row.principals), ["user:alice"], "principals が空にならない");
    assert.equal(row.synced_at, 1000, "同期時刻は動かない");
    assert.equal(row.last_attempt_at, 2000, "試行時刻だけ進む");
    assert.equal(row.last_error, "ETIMEDOUT");
    assert.equal(count("observation WHERE kind='acl_fetch_failed'"), 1);
  });

  it("初回が取得失敗なら unknown で記録され principals は空", async () => {
    await store.upsertAcl({
      documentId: docId,
      tenantId: "t1",
      state: "unknown",
      principals: [],
      aclHash: "h",
      lastError: "EACCES",
    });
    const row = one<{ state: string; principals: string; synced_at: number | null }>(
      "SELECT state, principals, synced_at FROM access_control",
    )!;
    assert.equal(row.state, "unknown");
    assert.equal(row.principals, "[]");
    assert.equal(row.synced_at, null);
  });

  it("unknown に principals を渡すのは矛盾なので拒む", async () => {
    await assert.rejects(
      () =>
        store.upsertAcl({
          documentId: docId,
          tenantId: "t1",
          state: "unknown",
          principals: ["everyone"],
          aclHash: "h",
        }),
      (e: unknown) => isStoreError(e, "invalid_argument"),
    );
  });

  it("AC-ACL-02: ACL のみの変更は version を作らない（AGENTS.md 3.4）", async () => {
    const versionsBefore = count("document_version");
    const activeBefore = one<{ v: string }>(
      "SELECT active_version_id AS v FROM document WHERE document_id=?",
      docId,
    )!.v;
    const createdBefore = count("observation WHERE kind='version_created'");

    await store.upsertAcl({ ...synced, documentId: docId, principals: ["a"], aclHash: "h1" });
    clock.advance(1000);
    await store.upsertAcl({ ...synced, documentId: docId, principals: ["a", "b"], aclHash: "h2" });

    assert.equal(count("document_version"), versionsBefore);
    assert.equal(
      one<{ v: string }>("SELECT active_version_id AS v FROM document WHERE document_id=?", docId)!.v,
      activeBefore,
    );
    assert.equal(count("observation WHERE kind='version_created'"), createdBefore);
  });

  it("テナントごとに独立している", async () => {
    await store.upsertAcl({ ...synced, documentId: docId, principals: ["a"], aclHash: "h" });
    await store.upsertAcl({
      documentId: docId,
      tenantId: "t2",
      state: "synced",
      principals: ["b"],
      aclHash: "h",
    });
    assert.equal(count("access_control"), 2);
  });
});

describe("findOrphanedSources / traceToOrigin / verifyBlobReferences", () => {
  it("走査対象に無い sourceId を検出する（#24）。1行も書かない", async () => {
    const before = count("observation");
    assert.deepEqual(await store.findOrphanedSources(["nas-tokyo-2" as SourceId]), [SRC]);
    assert.deepEqual(await store.findOrphanedSources([SRC]), []);
    assert.equal(count("observation"), before, "検出のみ。自動対処も記録もしない");
  });

  it("tombstoned な文書しかない source は孤児にしない", async () => {
    conn.db.prepare("UPDATE document SET state='tombstoned', tombstoned_at=?").run(clock.now());
    assert.deepEqual(await store.findOrphanedSources([]), []);
  });

  it("Artifact から原本まで辿れる（LINEAGE_COMPLETE）", async () => {
    const r = await store.commitDerivation({
      derivation: derivation(),
      artifacts: [chunk(0, "alpha")],
      runId,
      workerId: W1,
    });
    const traced = await store.traceToOrigin(deriveArtifactId(r.derivationKey, 0));

    assert.equal(traced.artifact.ordinal, 0);
    assert.equal(traced.derivation.derivationKey, r.derivationKey);
    assert.equal(traced.version.versionId, versionId);
    assert.equal(traced.document.documentId, docId);
    assert.equal(traced.document.stableKey, "a.txt");
    assert.deepEqual(traced.derivation.inputIds, [versionId]);
  });

  it("系譜が切れていれば null ではなく失敗として表面化する", async () => {
    await assert.rejects(
      () => store.traceToOrigin(__unsafeArtifactId("nope")),
      (e: unknown) => isStoreError(e, "invalid_argument"),
    );
  });

  it("verifyBlobReferences は件数上限つきで列挙する（#30）", async () => {
    const all: BlobReference[] = [];
    for await (const r of store.verifyBlobReferences()) all.push(r);
    assert.equal(all.length, 1);
    assert.deepEqual(all[0], {
      kind: "version",
      versionId,
      blobKey: "b1",
      contentHash: hashOf("one"),
    });

    const limited: unknown[] = [];
    for await (const r of store.verifyBlobReferences(0)) limited.push(r);
    assert.equal(limited.length, 0);
  });

  /**
   * **artifact だけが指している鍵が「参照ゼロ」に見えてはいけません。**
   *
   * 以前の列挙は `document_version` しか見ていませんでした。その状態で
   * 削除述語を書くと、artifact 参照だけの鍵に正規の許可が下り、
   * 実体が消えても `artifact` 行は残るので `NO_ORPHAN_ARTIFACT` は緑のままです。
   * 「行がある」と「中身が読める」が離れます（AGENTS.md 3.7）。
   */
  it("artifact の blobKey も参照として列挙される", async () => {
    // beforeEach が既定の鍵でリースを取っている。同一鍵の leased は1件（#12）
    await store.commitDerivation({
      derivation: derivation(),
      artifacts: [
        { ordinal: 0, type: "chunk", kind: "blob", blobKey: "art-blob-0" as BlobKey, contentHash: hashOf("c0"), sizeBytes: 2 },
      ],
      runId,
      workerId: W1,
    });

    const seen: BlobReference[] = [];
    for await (const r of store.verifyBlobReferences()) seen.push(r);

    const artifactRefs = seen.filter((r) => r.kind === "artifact");
    assert.equal(artifactRefs.length, 1);
    assert.deepEqual(
      { key: artifactRefs[0]!.blobKey, hash: artifactRefs[0]!.contentHash },
      { key: "art-blob-0", hash: hashOf("c0") },
    );
    // version 側も落ちていない。閉包は和であって、置き換えではない
    assert.equal(seen.filter((r) => r.kind === "version").length, 1);
  });

  it("inline な artifact は参照ではない（blob_key IS NULL を数えない）", async () => {
    await store.commitDerivation({
      derivation: derivation(),
      artifacts: [chunk(0, "inline")],
      runId,
      workerId: W1,
    });

    const seen: BlobReference[] = [];
    for await (const r of store.verifyBlobReferences()) seen.push(r);
    assert.deepEqual(seen.map((r) => r.kind), ["version"]);
  });

  /**
   * サンプリングは「全件見ないこと」を認めた設計であって、
   * 「同じ一部だけを見続けること」を認めた設計ではありません（0-d）。
   */
  describe("verifyBlobReferences の継続位置", () => {
    /** 追加の版を n 件作る。version_id は内容から導出されるので順序は内容で決まる */
    async function addVersions(n: number): Promise<VersionId[]> {
      // beforeEach が開いた走査に相乗りする。同一 source の running は1件だけ（#1）
      const scanId = openScanId;
      const ids: VersionId[] = [];
      for (let i = 0; i < n; i += 1) {
        const hash = hashOf(`extra-${i}`);
        const observed = await store.recordObservedDocument(scanId, {
          stableKey: `extra-${i}.txt`,
          outcome: { kind: "content", contentHash: hash, sizeBytes: 3 },
        });
        const v = await store.insertVersionIfAbsent({
          documentId: observed.documentId,
          contentHash: hash,
          sizeBytes: 3,
          blobKey: __unsafeBlobKey(`b-extra-${i}`),
          blobVerifiedAt: attestPersisted(clock.now(), hash),
          mimeType: "text/plain",
          discoveredByScanId: scanId,
          pipelineVersion: "v0.1",
        });
        ids.push(v.versionId);
      }
      return ids;
    }

    const take = async (limit?: number): Promise<string[]> => {
      const out: string[] = [];
      for await (const r of store.verifyBlobReferences(limit)) {
        out.push(r.kind === "version" ? r.versionId : r.artifactId);
      }
      return out;
    };

    it("繰り返し呼ぶと前進する。同じ行を返し続けない", async () => {
      await addVersions(4);
      const first = await take(2);
      const second = await take(2);
      const third = await take(2);

      assert.equal(first.length, 2);
      assert.equal(second.length, 2);
      assert.deepEqual(
        [...new Set([...first, ...second, ...third])].length,
        5,
        "3回で全5件（既定の1件 + 追加4件）を尽くす",
      );
    });

    it("選択順序は version_id の昇順で決まっている", async () => {
      await addVersions(4);
      const seen = [...(await take(2)), ...(await take(2)), ...(await take(2))];
      assert.deepEqual(seen, [...seen].sort(), "DB の返す順に依存しない");
    });

    it("終端まで来たら先頭へ折り返す", async () => {
      await addVersions(2);
      const all = await take();
      assert.equal(all.length, 3);
      // 折り返さないと、この呼び出し以降は永久に空になる
      assert.deepEqual(await take(), all);
    });

    it("列挙しても1行も書かない（判定関数は状態を変えない）", async () => {
      await addVersions(2);
      const before = count("observation");
      await take(1);
      await take(1);
      assert.equal(count("observation"), before);
    });
  });
});
