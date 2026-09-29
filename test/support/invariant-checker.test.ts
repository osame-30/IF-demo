/**
 * invariant-checker 自身の検証。
 *
 * schema.sql から実際に SQLite の DB を作り、そこへ違反状態を仕込んで
 * 「検出できること」を確かめます。schema.sql が SQLite で通ること自体も
 * ここで担保されます。
 *
 * 違反を仕込むときは PRAGMA foreign_keys を OFF にします。
 * SQLite の外部キーは接続ごとの設定で既定が OFF であり、
 * 「FK が効いていれば起きないはず」の状態は現実に起こり得るためです。
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  assertInvariants,
  checkInvariants,
  SCHEMA_GUARDS,
  type InvariantReport,
  type InvariantResult,
} from "./invariant-checker.ts";
import { INVARIANTS } from "../../src/domain/types.ts";
import { derivationKey as deriveDerivationKey } from "../../src/domain/ids.ts";
import { snapshotState } from "./state-snapshot.ts";
import { __unsafeSourceId, __unsafeVersionId } from "./unsafe-brands.ts";
import type { SnapshotReader } from "./state-snapshot.ts";

const SCHEMA = readFileSync(
  fileURLToPath(new URL("../../schema.sql", import.meta.url)),
  "utf8",
);

let db: DatabaseSync;
let reader: SnapshotReader;

function insert(table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  db.prepare(sql).run(...(columns.map((c) => row[c]) as never[]));
}

/** FK を外して不正な行を入れる。検証対象は「壊れた DB を検出できるか」 */
function insertUnchecked(table: string, row: Record<string, unknown>): void {
  db.exec("PRAGMA foreign_keys = OFF");
  insert(table, row);
  db.exec("PRAGMA foreign_keys = ON");
}

/** すべての不変条件を満たす最小の状態 */
function seedValidGraph(): void {
  insert("source", {
    source_id: "src1",
    kind: "local-fs",
    config_hash: "cfg",
    display_name: "src1",
    key_unicode_form: "NFC",
    key_case_fold: 0,
    key_path_separator: "posix",
    key_trim_slashes: 1,
  });
  insert("scan_run", {
    scan_id: "scan-1",
    source_id: "src1",
    started_at: 900,
    start_seq: 1,
    finished_at: 2000,
    status: "completed",
    enumerated_count: 1,
    distinct_count: 1,
    previous_distinct_count: 0,
    count_ratio_threshold_bp: 9000,
    missing_ratio_threshold_bp: 1000,
    write_failure_count: 0,
    completion_seq: 1,
    deletion_state: "applied",
  });
  insert("document", {
    document_id: "doc-1",
    source_id: "src1",
    stable_key: "a.txt",
    state: "active",
    active_version_id: null,
    first_seen_at: 1000,
    last_seen_at: 1000,
    last_seen_scan_id: "scan-1",
  });
  insert("document_version", {
    version_id: "ver-1",
    document_id: "doc-1",
    content_hash: "h1",
    size_bytes: 3,
    blob_key: "b1",
    // 検証は put の中で起きるので、取り込み時刻より後にはならない
    blob_verified_at: 900,
    mime_type: "text/plain",
    ingested_at: 1000,
    discovered_by_scan_id: "scan-1",
    pipeline_version: "v0.1",
  });
  db.prepare("UPDATE document SET active_version_id = ? WHERE document_id = ?").run("ver-1", "doc-1");
  insert("observation", {
    observation_id: "o-1",
    kind: "version_created",
    document_id: "doc-1",
    version_id: "ver-1",
    scan_id: "scan-1",
    occurred_at: 1000,
    detail: "{}",
  });
}

function pick(report: InvariantReport, name: string): InvariantResult {
  const found = report.results.find((r) => r.name === name);
  assert.ok(found, `no result for ${name}`);
  return found;
}

function problems(report: InvariantReport, name: string): string[] {
  return pick(report, name).findings.map((f) => f.problem);
}

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  // PRAGMA は DDL ではなく接続セットアップの責務。schema.sql には入れない
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  reader = { all: (sql) => Promise.resolve(db.prepare(sql).all()) };
});

describe("schema.sql", () => {
  it("SQLite にそのまま流し込める", () => {
    // sqlite_ 接頭辞は SQLite の内部表。AUTOINCREMENT が作る sqlite_sequence が
    // ここに混ざるので、宣言した表だけを見る
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    assert.deepEqual(tables, [
      "access_control",
      "artifact",
      "derivation",
      "document",
      "document_version",
      "observation",
      "processing_run",
      "rename_candidate",
      "scan_run",
      "source",
    ]);
  });

  /**
   * AUTOINCREMENT が実際に効いていることの唯一の観測可能な証拠。
   *
   * PRAGMA table_info は「INTEGER PRIMARY KEY である」までしか言えず、
   * AUTOINCREMENT の有無を返しません。DDL 文字列の一致で見ると、
   * 空白を変えただけで落ちる一方で型の変更には気づかない検査になります。
   * SQLite は AUTOINCREMENT 付きの表を作るときだけ sqlite_sequence を作るので、
   * その存在を見ます。AUTOINCREMENT が無いと rowid が削除後に再利用され、
   * 追記順の全順序が巻き戻ります。
   */
  it("observation_seq は rowid の再利用を禁じている（SQLite 固有の確認）", () => {
    const internal = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = 'sqlite_sequence'")
      .all();
    assert.equal(internal.length, 1);
  });

  it("前方参照は document -> document_version の1本だけ（PostgreSQL 互換 / B-5）", () => {
    // PostgreSQL は CREATE 時に参照先テーブルの実在を要求する。
    // 前方参照が増えると、移植時に ALTER へ外に出す箇所が増えて破綻する。
    // 「互換に保つ」をコメントではなく検査にする
    const chunks = SCHEMA.split(/CREATE TABLE\s+/).slice(1);
    const defined = new Set<string>();
    const forward: string[] = [];

    for (const chunk of chunks) {
      const name = /^(\w+)/.exec(chunk)?.[1] ?? "";
      const body = chunk.split(/CREATE (?:INDEX|UNIQUE|TRIGGER)/)[0] ?? "";
      for (const m of body.matchAll(/REFERENCES\s+(\w+)/g)) {
        const target = m[1]!;
        if (target !== name && !defined.has(target)) forward.push(`${name} -> ${target}`);
      }
      defined.add(name);
    }

    assert.deepEqual([...new Set(forward)], ["document -> document_version"]);
  });

  it("AGENTS.md 7節が要求する2本の部分ユニークインデックスを持つ", () => {
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_one_%'")
      .all()
      .map((r) => (r as { name: string }).name)
      .sort();
    assert.deepEqual(idx, ["idx_one_leased_run", "idx_one_running_scan"]);
  });

  it("同一 source で running な走査を2件書けない（#1）", () => {
    seedValidGraph();
    const running = (id: string) => ({
      scan_id: id,
      source_id: "src1",
      started_at: 3000,
      start_seq: 9,
      status: "running",
      enumerated_count: 0,
      distinct_count: 0,
      previous_distinct_count: 0,
      count_ratio_threshold_bp: 9000,
      missing_ratio_threshold_bp: 1000,
      write_failure_count: 0,
    });
    insert("scan_run", running("scan-2"));
    assert.throws(() => insert("scan_run", running("scan-3")), /UNIQUE|constraint/i);
  });

  it("同一 derivationKey で leased な run を2件書けない（#12）", () => {
    seedValidGraph();
    const leased = (id: string) => ({
      run_id: id,
      derivation_key: "der-1",
      document_id: "doc-1",
      root_version_id: "ver-1",
      status: "leased",
      attempt: 1,
      worker_id: "w1",
      lease_expires_at: 5000,
      lease_seconds: 60,
    });
    insert("processing_run", leased("run-1"));
    assert.throws(() => insert("processing_run", leased("run-2")), /UNIQUE|constraint/i);
  });

  it("tombstoned でない行に tombstonedAt を残せない（#25）", () => {
    seedValidGraph();
    assert.throws(
      () =>
        db
          .prepare("UPDATE document SET state='active', tombstoned_at=123 WHERE document_id='doc-1'")
          .run(),
      /constraint/i,
    );
  });

  it("blobVerifiedAt のない version 行を書けない（#8, #21）", () => {
    seedValidGraph();
    assert.throws(
      () =>
        insert("document_version", {
          version_id: "ver-2",
          document_id: "doc-1",
          content_hash: "h2",
          size_bytes: 1,
          blob_key: "b2",
          mime_type: "text/plain",
          ingested_at: 1000,
          discovered_by_scan_id: "scan-1",
          pipeline_version: "v0.1",
        }),
      /NOT NULL|constraint/i,
    );
  });

  it("distinctCount が enumeratedCount を超えられない（#27）", () => {
    seedValidGraph();
    assert.throws(
      () => db.prepare("UPDATE scan_run SET distinct_count = 99 WHERE scan_id='scan-1'").run(),
      /constraint/i,
    );
  });

  it("unknown な ACL に principals を持たせられない（#29）", () => {
    seedValidGraph();
    assert.throws(
      () =>
        insert("access_control", {
          document_id: "doc-1",
          tenant_id: "t1",
          state: "unknown",
          principals: '["everyone"]',
          acl_hash: "h",
        }),
      /constraint/i,
    );
  });

  it("複合 FK が他文書の版を指すポインタを拒む（追加ガード1）", () => {
    seedValidGraph();
    insert("document", {
      document_id: "doc-2",
      source_id: "src1",
      stable_key: "b.txt",
      state: "active",
      first_seen_at: 1000,
      last_seen_at: 1000,
      last_seen_scan_id: "scan-1",
    });
    assert.throws(
      () => db.prepare("UPDATE document SET active_version_id='ver-1' WHERE document_id='doc-2'").run(),
      /FOREIGN KEY|constraint/i,
    );
    // 自分の版と NULL は通る
    assert.doesNotThrow(() =>
      db.prepare("UPDATE document SET active_version_id=NULL WHERE document_id='doc-1'").run(),
    );
  });

  it("document_version は UPDATE できない（追加ガード3）", () => {
    seedValidGraph();
    assert.throws(
      () => db.prepare("UPDATE document_version SET content_hash='h9' WHERE version_id='ver-1'").run(),
      /document_version is immutable/,
    );
    const row = db.prepare("SELECT content_hash FROM document_version WHERE version_id='ver-1'").get();
    assert.equal((row as { content_hash: string }).content_hash, "h1");
  });

  it("基準走査が別 source から来る事故を拒む（追加ガード2 / #3 の変種）", () => {
    seedValidGraph();
    insert("source", {
      source_id: "src2",
      kind: "local-fs",
      config_hash: "cfg",
      display_name: "src2",
      key_unicode_form: "NFC",
      key_case_fold: 0,
      key_path_separator: "posix",
      key_trim_slashes: 1,
    });
    assert.throws(
      () =>
        insert("scan_run", {
          scan_id: "scan-x",
          source_id: "src2",
          started_at: 3000,
          start_seq: 1,
          finished_at: 3100,
          status: "completed",
          enumerated_count: 1,
          distinct_count: 1,
          // src1 の走査を基準にしようとしている
          previous_completed_scan_id: "scan-1",
          previous_distinct_count: 1,
          count_ratio_threshold_bp: 9000,
          missing_ratio_threshold_bp: 1000,
          write_failure_count: 0,
          completion_seq: 1,
          deletion_state: "applied",
        }),
      /FOREIGN KEY|constraint/i,
    );
  });

  it("completed な走査は completion_seq を必ず持つ（B-4）", () => {
    seedValidGraph();
    assert.throws(
      () => db.prepare("UPDATE scan_run SET completion_seq = NULL WHERE scan_id='scan-1'").run(),
      /constraint/i,
    );
  });

  it("閾値は 0..10000 のベーシスポイント整数（B-6）", () => {
    seedValidGraph();
    assert.throws(
      () => db.prepare("UPDATE scan_run SET count_ratio_threshold_bp = 10001 WHERE scan_id='scan-1'").run(),
      /constraint/i,
    );
    // 交差積で比較するので除算は現れない: distinct*10000 < prevDistinct*bp
    const row = db
      .prepare("SELECT (900*10000 < 1000*9000) AS trips, (899*10000 < 1000*9000) AS trips2")
      .get() as { trips: number; trips2: number };
    assert.equal(row.trips, 0, "900/1000 は閾値 0.90 の境界なので通過する");
    assert.equal(row.trips2, 1, "899/1000 は閾値を下回るので発火する");
  });
});

describe("invariant-checker", () => {
  it("正しい状態では DB 由来の11項目がすべて ok", async () => {
    seedValidGraph();
    const report = await checkInvariants({ reader });
    const ok = report.results.filter((r) => r.status === "ok").map((r) => r.name);
    assert.equal(ok.length, 11);
    assert.doesNotThrow(() => assertInvariants(report));
  });

  it("15項目すべてを1回ずつ報告する", async () => {
    const report = await checkInvariants({ reader });
    assert.equal(report.results.length, 15);
    assert.equal(new Set(report.results.map((r) => r.name)).size, 15);
  });

  it("入力が足りない4項目は ok ではなく not_checked になる", async () => {
    const report = await checkInvariants({ reader });
    const unchecked = report.results.filter((r) => r.status === "not_checked").map((r) => r.name);
    assert.deepEqual(unchecked.sort(), [
      "CANONICAL_KEY_STABILITY",
      "HASH_MATCHES_BLOB",
      "IDEMPOTENT_REPLAY",
      "NO_WORK_WITHOUT_CHANGE",
    ]);
    for (const r of report.results) {
      if (r.status === "not_checked") assert.ok(r.reason, `${r.name} has no reason`);
    }
  });

  it("宣言した項目が not_checked なら落ちる（緑と数えない）", async () => {
    const report = await checkInvariants({ reader });
    assert.doesNotThrow(() => assertInvariants(report, ["LINEAGE_COMPLETE"]));
    assert.throws(
      () => assertInvariants(report, ["HASH_MATCHES_BLOB"]),
      /asserted but not checked/,
    );
  });

  it("親のない Artifact を検出する", async () => {
    seedValidGraph();
    insertUnchecked("artifact", {
      artifact_id: "art-1",
      derivation_key: "missing-der",
      ordinal: 0,
      document_id: "doc-1",
      root_version_id: "ver-1",
      type: "chunk",
      inline_content: "x",
      content_hash: "h",
      size_bytes: 1,
      created_at: 1000,
    });
    const report = await checkInvariants({ reader });
    assert.ok(problems(report, "NO_ORPHAN_ARTIFACT").includes("artifact_without_derivation"));
  });

  it("artifactCount と実行数の食い違いを検出する（#9）", async () => {
    seedValidGraph();
    insert("derivation", {
      derivation_key: "der-1",
      processor_name: "echo",
      processor_version: "1",
      config_hash: "c",
      input_ids: '["ver-1"]',
      root_version_id: "ver-1",
      document_id: "doc-1",
      created_at: 1000,
      // Derivation だけ書いてクラッシュした形
      artifact_count: 3,
      outputs_hash: "whatever",
    });
    const report = await checkInvariants({ reader });
    assert.ok(problems(report, "NO_ORPHAN_ARTIFACT").includes("artifact_count_mismatch"));
  });

  it("outputsHash を独立に再計算して食い違いを検出する（#10, #11）", async () => {
    seedValidGraph();
    // Artifact 0件の Derivation の outputsHash は sha256("out:")。v0.1 が通る唯一の経路
    insert("derivation", {
      derivation_key: "der-1",
      processor_name: "echo",
      processor_version: "1",
      config_hash: "c",
      input_ids: '["ver-1"]',
      root_version_id: "ver-1",
      document_id: "doc-1",
      created_at: 1000,
      artifact_count: 0,
      outputs_hash: "7d33c9d029ac7d770c5ede79a2ae0989c9df1bd8b8ce5784e61ad7a8f0317ebe",
    });
    let report = await checkInvariants({ reader });
    assert.deepEqual(problems(report, "DERIVATION_OUTPUT_STABLE"), []);

    db.prepare("UPDATE derivation SET outputs_hash='tampered' WHERE derivation_key='der-1'").run();
    report = await checkInvariants({ reader });
    assert.ok(
      problems(report, "DERIVATION_OUTPUT_STABLE").includes("outputs_hash_does_not_match_artifacts"),
    );
  });

  it("aborted_safety な走査からの tombstone を検出する（#4）", async () => {
    seedValidGraph();
    insert("scan_run", {
      scan_id: "scan-bad",
      source_id: "src1",
      started_at: 3000,
      start_seq: 3,
      finished_at: 3100,
      status: "aborted_safety",
      enumerated_count: 1,
      distinct_count: 1,
      previous_distinct_count: 100,
      count_ratio_threshold_bp: 9000,
      missing_ratio_threshold_bp: 1000,
      write_failure_count: 0,
      abort_reason: "count ratio 0.01 below threshold",
    });
    insert("observation", {
      observation_id: "o-abort",
      kind: "scan_aborted_safety",
      scan_id: "scan-bad",
      occurred_at: 3100,
      detail: "{}",
    });
    insert("observation", {
      observation_id: "o-tomb",
      kind: "document_tombstoned",
      document_id: "doc-1",
      scan_id: "scan-bad",
      occurred_at: 3100,
      detail: "{}",
    });
    const report = await checkInvariants({ reader });
    assert.ok(
      problems(report, "SAFETY_ABORT_WRITES_NOTHING").includes("tombstone_written_by_aborted_scan"),
    );
    assert.ok(
      problems(report, "DELETION_ONLY_FROM_COMPLETED_SCAN").includes(
        "tombstone_from_non_promoted_scan",
      ),
    );
  });

  it("書き込み失敗のあった走査からの tombstone を検出する（#16）", async () => {
    seedValidGraph();
    db.prepare("UPDATE scan_run SET write_failure_count = 1 WHERE scan_id='scan-1'").run();
    insert("observation", {
      observation_id: "o-tomb",
      kind: "document_tombstoned",
      document_id: "doc-1",
      scan_id: "scan-1",
      occurred_at: 2000,
      detail: "{}",
    });
    const report = await checkInvariants({ reader });
    assert.ok(
      problems(report, "DELETION_ONLY_FROM_COMPLETED_SCAN").includes(
        "tombstone_from_non_promoted_scan",
      ),
    );
  });

  it("後発の走査に追い越された走査からの tombstone を検出する（#1, #2）", async () => {
    seedValidGraph();
    // 走査 B が先に完了し、遅れて走査 A が削除判定に進んだ形
    insert("scan_run", {
      scan_id: "scan-b",
      source_id: "src1",
      started_at: 2100,
      start_seq: 2,
      finished_at: 2200,
      status: "completed",
      enumerated_count: 1,
      distinct_count: 1,
      previous_distinct_count: 1,
      count_ratio_threshold_bp: 9000,
      missing_ratio_threshold_bp: 1000,
      write_failure_count: 0,
      completion_seq: 2,
      deletion_state: "applied",
    });
    insert("observation", {
      observation_id: "o-tomb",
      kind: "document_tombstoned",
      document_id: "doc-1",
      scan_id: "scan-1",
      occurred_at: 2300,
      detail: "{}",
    });
    const report = await checkInvariants({ reader });
    assert.ok(
      problems(report, "DELETION_ONLY_FROM_COMPLETED_SCAN").includes(
        "tombstone_from_superseded_scan",
      ),
    );
  });

  it("版が入ったのに動かなかった active ポインタを検出する（#15）", async () => {
    seedValidGraph();
    insert("document_version", {
      version_id: "ver-2",
      document_id: "doc-1",
      content_hash: "h2",
      size_bytes: 4,
      blob_key: "b2",
      blob_verified_at: 1900,
      mime_type: "text/plain",
      ingested_at: 2000,
      discovered_by_scan_id: "scan-1",
      pipeline_version: "v0.1",
    });
    insert("observation", {
      observation_id: "o-2",
      kind: "version_created",
      document_id: "doc-1",
      version_id: "ver-2",
      scan_id: "scan-1",
      occurred_at: 2000,
      detail: "{}",
    });
    // ポインタは ver-1 のまま
    const report = await checkInvariants({ reader });
    assert.ok(
      problems(report, "POINTER_MATCHES_OBSERVATION").includes(
        "active_pointer_does_not_match_latest_observation",
      ),
    );
  });

  it("occurredAt が同値で並んでも誤検出しない", async () => {
    seedValidGraph();
    insert("observation", {
      observation_id: "o-tie",
      kind: "version_reverted",
      document_id: "doc-1",
      version_id: "ver-1",
      scan_id: "scan-1",
      // seedValidGraph の version_created と同時刻
      occurred_at: 1000,
      detail: "{}",
    });
    const report = await checkInvariants({ reader });
    assert.deepEqual(problems(report, "POINTER_MATCHES_OBSERVATION"), []);
  });

  it("別文書の版を指すポインタを検出する（FK が無効な DB を想定）", async () => {
    seedValidGraph();
    insert("document", {
      document_id: "doc-2",
      source_id: "src1",
      stable_key: "b.txt",
      state: "active",
      first_seen_at: 1000,
      last_seen_at: 1000,
      last_seen_scan_id: "scan-1",
    });
    // 複合 FK が有効なら書けない。checker は FK が切れている DB を検出する側なので
    // ここでは意図的に外して仕込む
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("UPDATE document SET active_version_id='ver-1' WHERE document_id='doc-2'").run();
    db.exec("PRAGMA foreign_keys = ON");

    const report = await checkInvariants({ reader });
    assert.ok(
      problems(report, "SINGLE_ACTIVE_VERSION").includes(
        "active_version_belongs_to_other_document",
      ),
    );
  });

  it("正規化後に衝突する stableKey を検出する（#23）", async () => {
    seedValidGraph();
    // "café" の NFC と NFD。source のポリシーは NFC なので同一に潰れるはず
    db.prepare("UPDATE document SET stable_key = ? WHERE document_id='doc-1'").run("café.txt");
    insert("document", {
      document_id: "doc-2",
      source_id: "src1",
      stable_key: "café.txt",
      state: "active",
      first_seen_at: 1000,
      last_seen_at: 1000,
      last_seen_scan_id: "scan-1",
    });
    const report = await checkInvariants({ reader });
    assert.ok(
      problems(report, "SINGLE_ACTIVE_VERSION").includes(
        "stable_key_collides_after_normalization",
      ),
    );
  });

  it("caseFold が無効な source では大文字小文字違いを衝突と呼ばない", async () => {
    seedValidGraph();
    insert("document", {
      document_id: "doc-2",
      source_id: "src1",
      stable_key: "A.TXT",
      state: "active",
      first_seen_at: 1000,
      last_seen_at: 1000,
      last_seen_scan_id: "scan-1",
    });
    const report = await checkInvariants({ reader });
    assert.deepEqual(problems(report, "SINGLE_ACTIVE_VERSION"), []);
  });

  it("caseFold が有効な source では大文字小文字違いを衝突と呼ぶ（#23）", async () => {
    seedValidGraph();
    db.prepare("UPDATE source SET key_case_fold = 1 WHERE source_id='src1'").run();
    insert("document", {
      document_id: "doc-2",
      source_id: "src1",
      stable_key: "A.TXT",
      state: "active",
      first_seen_at: 1000,
      last_seen_at: 1000,
      last_seen_scan_id: "scan-1",
    });
    const report = await checkInvariants({ reader });
    assert.ok(
      problems(report, "SINGLE_ACTIVE_VERSION").includes(
        "stable_key_collides_after_normalization",
      ),
    );
  });

  it("走査対象から外れた source の active 文書を検出する（#24）", async () => {
    seedValidGraph();
    const report = await checkInvariants({
      reader,
      knownSourceIds: [__unsafeSourceId("src-renamed")],
    });
    assert.ok(
      problems(report, "SINGLE_ACTIVE_VERSION").includes("active_document_in_orphaned_source"),
    );
  });

  it("ACL 起因の版はスキーマが構造的に拒む（AGENTS.md 3.4）", () => {
    seedValidGraph();
    // 内容が1バイトも変わらないまま権限だけ変わっても、同じ contentHash の
    // 版は2つ書けない。FK を外しても UNIQUE 制約は効く
    assert.throws(
      () =>
        insertUnchecked("document_version", {
          version_id: "ver-dup",
          document_id: "doc-1",
          content_hash: "h1",
          size_bytes: 3,
          blob_key: "b1",
          blob_verified_at: 900,
          mime_type: "text/plain",
          ingested_at: 1000,
          discovered_by_scan_id: "scan-1",
          pipeline_version: "v0.1",
        }),
      /UNIQUE constraint failed: document_version/,
    );
  });

  it("取得失敗が synced として焼き付いていれば検出する（#29）", async () => {
    seedValidGraph();
    insert("access_control", {
      document_id: "doc-1",
      tenant_id: "t1",
      state: "synced",
      principals: "[]",
      acl_hash: "h",
      synced_at: 1000,
      last_error: "ETIMEDOUT",
    });
    const report = await checkInvariants({ reader });
    assert.ok(
      problems(report, "ACL_DOES_NOT_VERSION").includes("failed_acl_fetch_recorded_as_synced"),
    );
  });

  it("ACL_DOES_NOT_VERSION を支える UNIQUE 制約の存在を確かめる", async () => {
    const report = await checkInvariants({ reader });
    const guard = report.schemaGuards.find((g) => g.name === "REQUIRED_UNIQUE_CONSTRAINTS");
    assert.equal(guard?.status, "ok");
  });

  it("UNIQUE 制約が落ちていれば構造ガードが落ちる", async () => {
    // 制約が消えると ACL_DOES_NOT_VERSION は静かに検証不能になる
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DROP TABLE artifact");
    db.exec(`CREATE TABLE artifact (
      artifact_id TEXT PRIMARY KEY, derivation_key TEXT NOT NULL, ordinal BIGINT NOT NULL,
      document_id TEXT NOT NULL, root_version_id TEXT NOT NULL, type TEXT NOT NULL,
      inline_content TEXT, blob_key TEXT, content_hash TEXT NOT NULL,
      size_bytes BIGINT NOT NULL, created_at BIGINT NOT NULL)`);
    const report = await checkInvariants({ reader });
    const guard = report.schemaGuards.find((g) => g.name === "REQUIRED_UNIQUE_CONSTRAINTS");
    assert.equal(guard?.status, "violated");
    assert.deepEqual(
      guard?.findings.map((f) => f.subject),
      ["artifact(derivation_key, ordinal)"],
    );
    assert.throws(() => assertInvariants(report), /missing_unique_constraint/);
  });

  it("blob に到達できない文書が quarantined でなければ検出する（#30）", async () => {
    seedValidGraph();
    insert("observation", {
      observation_id: "o-broken",
      kind: "blob_reference_broken",
      document_id: "doc-1",
      version_id: "ver-1",
      occurred_at: 3000,
      detail: "{}",
    });
    const report = await checkInvariants({ reader });
    assert.ok(
      problems(report, "LINEAGE_COMPLETE").includes("broken_blob_reference_not_quarantined"),
    );
  });

  it("BlobVerifier を渡すと実バイト列との不一致を検出する", async () => {
    seedValidGraph();
    const report = await checkInvariants({
      reader,
      blobs: { verify: () => Promise.resolve(false) },
    });
    assert.ok(problems(report, "HASH_MATCHES_BLOB").includes("version_blob_hash_mismatch"));
  });

  /**
   * 2026-09-10 の指摘 3 の残り。
   *
   * **確定時の検査は新しい不整合を止めるだけで、既に入った行は直しません。**
   * 本文と hash が食い違う artifact が既に保存されている状態は、
   * この検算でしか見つかりません。ストアを通さず生の SQL で作ります
   * ——「既に入っている」がこの検査の前提だからです。
   */
  it("inline 本文と content_hash の食い違いを、blob 検証器なしで検出する", async () => {
    seedValidGraph();
    insertUnchecked("artifact", {
      artifact_id: "art-bad",
      derivation_key: "der-1",
      ordinal: 9,
      document_id: "doc-1",
      root_version_id: "ver-1",
      type: "chunk",
      inline_content: "WRONG",
      content_hash: createHash("sha256").update(Buffer.from("RIGHT", "utf8")).digest("hex"),
      size_bytes: 5,
      created_at: 1000,
    });

    const report = await checkInvariants({ reader });
    const result = report.results.find((r) => r.name === "HASH_MATCHES_BLOB")!;
    assert.equal(result.status, "violated", "検証器が無くても、見つけた違反は報告する");
    assert.ok(problems(report, "HASH_MATCHES_BLOB").includes("artifact_inline_hash_mismatch"));
  });

  it("inline の size_bytes の食い違いも検出する", async () => {
    seedValidGraph();
    insertUnchecked("artifact", {
      artifact_id: "art-bad-size",
      derivation_key: "der-1",
      ordinal: 8,
      document_id: "doc-1",
      root_version_id: "ver-1",
      type: "chunk",
      inline_content: "ok",
      content_hash: createHash("sha256").update(Buffer.from("ok", "utf8")).digest("hex"),
      size_bytes: 99_999,
      created_at: 1000,
    });

    const report = await checkInvariants({ reader });
    assert.ok(problems(report, "HASH_MATCHES_BLOB").includes("artifact_inline_size_mismatch"));
  });

  it("inline が健全でも、blob を見ていなければ ok にはならない", async () => {
    seedValidGraph();
    insertUnchecked("artifact", {
      artifact_id: "art-good",
      derivation_key: "der-1",
      ordinal: 7,
      document_id: "doc-1",
      root_version_id: "ver-1",
      type: "chunk",
      inline_content: "ok",
      content_hash: createHash("sha256").update(Buffer.from("ok", "utf8")).digest("hex"),
      size_bytes: 2,
      created_at: 1000,
    });

    const result = (await checkInvariants({ reader })).results.find(
      (r) => r.name === "HASH_MATCHES_BLOB",
    )!;
    assert.equal(result.status, "not_checked", "blob の枝を1バイトも見ていない");
    assert.match(result.reason ?? "", /inline artifacts were checked/);
  });

  it("インデックスが落ちていれば構造ガードが落ちる", async () => {
    db.exec("DROP INDEX idx_one_running_scan");
    const report = await checkInvariants({ reader });
    const guard = report.schemaGuards.find((g) => g.name === "REQUIRED_PARTIAL_UNIQUE_INDEXES");
    assert.equal(guard?.status, "violated");
    assert.throws(() => assertInvariants(report), /missing_partial_unique_index/);
  });

  it("構造ガードの違反は assertions に挙げていなくても落とす", async () => {
    db.exec("DROP INDEX idx_one_leased_run");
    const report = await checkInvariants({ reader });
    assert.throws(() => assertInvariants(report, ["LINEAGE_COMPLETE"]), /idx_one_leased_run/);
  });

  it("completion_seq のインデックスが落ちていれば検出する（B-4）", async () => {
    db.exec("DROP INDEX idx_scan_completion_seq");
    const report = await checkInvariants({ reader });
    assert.throws(() => assertInvariants(report), /idx_scan_completion_seq/);
  });

  it("名指しした違反は落とさない（Fixture.expectedViolations）", async () => {
    seedValidGraph();
    insert("observation", {
      observation_id: "o-div",
      kind: "derivation_output_divergence",
      document_id: "doc-1",
      occurred_at: 3000,
      detail: "{}",
    });
    const report = await checkInvariants({ reader });
    assert.throws(() => assertInvariants(report), /divergence_observed/);
    assert.doesNotThrow(() =>
      assertInvariants(report, ["DERIVATION_OUTPUT_STABLE"], [
        { invariant: "DERIVATION_OUTPUT_STABLE", problem: "divergence_observed" },
      ]),
    );
  });

  it("名指しは1つの problem にしか効かない。同じ不変条件の別の違反は落ちる", async () => {
    seedValidGraph();
    insert("observation", {
      observation_id: "o-div",
      kind: "derivation_output_divergence",
      occurred_at: 3000,
      detail: "{}",
    });
    // ordinal が 0 から始まっていない Artifact。#10 の残骸の形
    insert("derivation", {
      derivation_key: "der-1",
      processor_name: "echo",
      processor_version: "1",
      config_hash: "cfg",
      input_ids: '["ver-1"]',
      root_version_id: "ver-1",
      document_id: "doc-1",
      created_at: 3000,
      artifact_count: 1,
      outputs_hash: "not-recomputable",
    });
    insert("artifact", {
      artifact_id: "art-9",
      derivation_key: "der-1",
      ordinal: 9,
      document_id: "doc-1",
      root_version_id: "ver-1",
      type: "chunk",
      inline_content: "leftover",
      content_hash: "deadbeef",
      size_bytes: 8,
      created_at: 3000,
    });

    const report = await checkInvariants({ reader });
    assert.throws(
      () =>
        assertInvariants(report, ["DERIVATION_OUTPUT_STABLE"], [
          { invariant: "DERIVATION_OUTPUT_STABLE", problem: "divergence_observed" },
        ]),
      /artifact_ordinals_not_contiguous|outputs_hash_does_not_match_artifacts/,
      "名指ししていない違反まで一緒に見逃さない",
    );
  });

  /**
   * C1 / C3 — **checker と seed が簡略式で自己整合することを構造的に禁じる。**
   *
   * seed は `src/domain/ids.ts` の実導出経路を通し、checker は独立実装で
   * 再導出します。両方を簡略式にすると、実導出を一度も通らずに全項目が緑になります。
   */
  describe("DERIVATION_KEY_MATCHES_MATERIALS", () => {
    const materials = {
      processorName: "echo",
      processorVersion: "1",
      configHash: "cfg-1",
      inputIds: [__unsafeVersionId("ver-1")],
    };

    function seedDerivation(key: string): void {
      seedValidGraph();
      insert("derivation", {
        derivation_key: key,
        processor_name: materials.processorName,
        processor_version: materials.processorVersion,
        config_hash: materials.configHash,
        input_ids: JSON.stringify(materials.inputIds),
        root_version_id: "ver-1",
        document_id: "doc-1",
        created_at: 1000,
        artifact_count: 0,
        outputs_hash: "out",
      });
    }

    it("実導出経路で作った鍵は通る", async () => {
      seedDerivation(deriveDerivationKey(materials));
      const report = await checkInvariants({ reader });
      assert.deepEqual(problems(report, "DERIVATION_KEY_MATCHES_MATERIALS"), []);
    });

    it("簡略式で作った鍵を検出する（C1）", async () => {
      seedDerivation("der-1");
      const report = await checkInvariants({ reader });
      assert.deepEqual(problems(report, "DERIVATION_KEY_MATCHES_MATERIALS"), [
        "derivation_key_does_not_match_materials",
      ]);
    });

    it("input_ids が鍵に入った順序で保存されていなければ検出する", async () => {
      seedValidGraph();
      insert("document_version", {
        version_id: "ver-0",
        document_id: "doc-1",
        content_hash: "h0",
        size_bytes: 3,
        blob_key: "b0",
        blob_verified_at: 900,
        mime_type: "text/plain",
        ingested_at: 1000,
        discovered_by_scan_id: "scan-1",
        pipeline_version: "v0.1",
      });
      const inputIds = ["ver-0", "ver-1"];
      insert("derivation", {
        derivation_key: deriveDerivationKey({
          ...materials,
          // 生 SQL で seed した version_id。実導出した ID では seed 行と一致しない
          inputIds: inputIds.map(__unsafeVersionId),
        }),
        processor_name: materials.processorName,
        processor_version: materials.processorVersion,
        config_hash: materials.configHash,
        // 鍵はソート済みの順で作ったのに、保存だけ逆順にした
        input_ids: JSON.stringify([...inputIds].reverse()),
        root_version_id: "ver-1",
        document_id: "doc-1",
        created_at: 1000,
        artifact_count: 0,
        outputs_hash: "out",
      });
      const report = await checkInvariants({ reader });
      assert.deepEqual(problems(report, "DERIVATION_KEY_MATCHES_MATERIALS"), [
        "input_ids_not_stored_in_key_order",
      ]);
    });

    it("IDEMPOTENT_REPLAY は作り物の鍵を比べて緑にならない（C3）", async () => {
      seedDerivation("der-1");
      const snapshot = await snapshotState(reader);
      // 状態は完全に一致している。それでも比べた同一性が作り物なら緑にしない
      const report = await checkInvariants({ reader, replay: { before: snapshot, after: snapshot } });
      assert.deepEqual(problems(report, "IDEMPOTENT_REPLAY"), ["replay_compared_unattributable_key"]);
    });

    it("実導出経路を通った鍵なら、同じ状態の比較は緑になる", async () => {
      seedDerivation(deriveDerivationKey(materials));
      const snapshot = await snapshotState(reader);
      const report = await checkInvariants({ reader, replay: { before: snapshot, after: snapshot } });
      assert.deepEqual(problems(report, "IDEMPOTENT_REPLAY"), []);
    });
  });

  it("15の不変条件と5本の構造ガードを、ちょうど1回ずつ報告する", async () => {
    seedValidGraph();
    const report = await checkInvariants({ reader });

    assert.equal(report.results.length, 15, "不変条件は INVARIANTS が正本");
    assert.deepEqual(
      [...report.results.map((r) => r.name)].sort(),
      Object.keys(INVARIANTS).sort(),
    );

    // 構造ガードは INVARIANTS のような正本を持たない。
    // 宣言リストとの突き合わせだけが「足したが報告していない」を捕まえる
    assert.equal(report.schemaGuards.length, SCHEMA_GUARDS.length);
    assert.deepEqual(
      [...report.schemaGuards.map((g) => g.name)].sort(),
      [...SCHEMA_GUARDS].sort(),
    );
  });

  it("observation に追記順の全順序がある（0-a）", async () => {
    const report = await checkInvariants({ reader });
    assert.equal(
      report.schemaGuards.find((g) => g.name === "OBSERVATION_TOTAL_ORDER")?.status,
      "ok",
    );
  });

  it("全順序列が落ちていれば検出する", async () => {
    // 列が消えると、分岐検出と失効ワーカー拒否の前後関係が復元できなくなる。
    // 「UUID を整列に使わない」規約だけが残り、整列する手段そのものが消える
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DROP TABLE observation");
    db.exec(`CREATE TABLE observation (
      observation_id TEXT PRIMARY KEY, kind TEXT NOT NULL, document_id TEXT,
      version_id TEXT, scan_id TEXT, run_id TEXT,
      occurred_at BIGINT NOT NULL, detail TEXT NOT NULL)`);
    const report = await checkInvariants({ reader });
    assert.throws(() => assertInvariants(report), /missing_total_order_column/);
  });

  it("全順序列が主キーでなければ検出する（rowid の別名でなければ追記順が保証されない）", async () => {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("DROP TABLE observation");
    db.exec(`CREATE TABLE observation (
      observation_id TEXT PRIMARY KEY, observation_seq INTEGER, kind TEXT NOT NULL,
      document_id TEXT, version_id TEXT, scan_id TEXT, run_id TEXT,
      occurred_at BIGINT NOT NULL, detail TEXT NOT NULL)`);
    const report = await checkInvariants({ reader });
    assert.throws(() => assertInvariants(report), /total_order_column_is_not_primary_key/);
  });

  it("observation_id の一意性は順序を移した後も残っている", async () => {
    const report = await checkInvariants({ reader });
    assert.equal(
      report.schemaGuards.find((g) => g.name === "REQUIRED_UNIQUE_CONSTRAINTS")?.status,
      "ok",
    );
    // 同じ事象 ID を2回書けないこと自体を実測で確かめる
    insert("observation", {
      observation_id: "o-dup",
      kind: "document_discovered",
      occurred_at: 1,
      detail: "{}",
    });
    assert.throws(() =>
      insert("observation", {
        observation_id: "o-dup",
        kind: "document_discovered",
        occurred_at: 2,
        detail: "{}",
      }),
    );
  });

  it("不変性トリガが落ちていれば検出する", async () => {
    const report0 = await checkInvariants({ reader });
    assert.equal(
      report0.schemaGuards.find((g) => g.name === "DOCUMENT_VERSION_IMMUTABLE_TRIGGER")?.status,
      "ok",
    );
    db.exec("DROP TRIGGER trg_document_version_immutable");
    const report = await checkInvariants({ reader });
    assert.throws(() => assertInvariants(report), /missing_immutability_trigger/);
  });
});

describe("条件4: 監査の故障と観測順を取り違えない", () => {
  it("blob 検証の1件の例外が起きても15項目を1回ずつ報告する", async () => {
    seedValidGraph();
    const report = await checkInvariants({ reader, blobs: { verify: async () => { throw new Error("read failed"); } } });
    assert.deepEqual(report.results.map((r) => r.name).sort(), Object.keys(INVARIANTS).sort());
    assert.equal(pick(report, "HASH_MATCHES_BLOB").status, "not_checked");
    assert.equal(pick(report, "POINTER_MATCHES_OBSERVATION").status, "ok");
    assert.throws(() => assertInvariants(report, ["HASH_MATCHES_BLOB"]));
  });

  it("同時刻でも追記順で後の観測と異なるポインタを検出する", async () => {
    seedValidGraph();
    insert("document_version", { version_id: "ver-2", document_id: "doc-1", content_hash: "h2",
      size_bytes: 4, blob_key: "b2", blob_verified_at: 900, mime_type: "text/plain", ingested_at: 1000,
      discovered_by_scan_id: "scan-1", pipeline_version: "v0.1" });
    insert("observation", { observation_id: "o-later", kind: "version_created", document_id: "doc-1",
      version_id: "ver-2", scan_id: "scan-1", occurred_at: 1000, detail: "{}" });
    assert.equal(pick(await checkInvariants({ reader }), "POINTER_MATCHES_OBSERVATION").status, "violated");
    db.prepare("UPDATE document SET active_version_id='ver-2' WHERE document_id='doc-1'").run();
    assert.equal(pick(await checkInvariants({ reader }), "POINTER_MATCHES_OBSERVATION").status, "ok");
  });

  it("墓標と後続完了が同時刻なら順序は不明で、違反とは断定しない", async () => {
    seedValidGraph();
    insert("observation", { observation_id: "o-tomb", kind: "document_tombstoned", document_id: "doc-1",
      scan_id: "scan-1", occurred_at: 2200, detail: "{}" });
    insert("scan_run", { scan_id: "scan-b", source_id: "src1", started_at: 2100, start_seq: 2,
      finished_at: 2200, status: "completed", enumerated_count: 1, distinct_count: 1,
      previous_distinct_count: 1, count_ratio_threshold_bp: 9000, missing_ratio_threshold_bp: 1000,
      write_failure_count: 0, completion_seq: 2, deletion_state: "applied" });
    assert.equal(pick(await checkInvariants({ reader }), "DELETION_ONLY_FROM_COMPLETED_SCAN").status, "not_checked");
  });

  it("不正な派生材料があっても他の項目を取り出せる", async () => {
    seedValidGraph();
    const broken: SnapshotReader = { all: async (sql) => {
      if (sql.includes("SELECT derivation_key, processor_name")) throw new Error("invalid derivation row");
      return reader.all(sql);
    } };
    const report = await checkInvariants({ reader: broken });
    assert.equal(report.results.length, 15);
    assert.equal(pick(report, "DERIVATION_KEY_MATCHES_MATERIALS").status, "not_checked");
  });
});
