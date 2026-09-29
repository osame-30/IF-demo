import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { openStore, type StoreConnection } from "./connection.ts";
import { SqliteLineageStore } from "./lineage-store.ts";
import { TestClock } from "../../../test/support/clock.ts";
import { isStoreError, ConcurrentScanError, StoreError } from "../../domain/errors.ts";
import { __unsafeObservationKind } from "../../../test/support/unsafe-brands.ts";

let clock: TestClock;
let conn: StoreConnection;

beforeEach(() => {
  clock = new TestClock(1000);
  conn = openStore({ clock });
});

afterEach(() => {
  conn.close();
});

const q = <T = Record<string, unknown>>(sql: string): T[] => conn.db.prepare(sql).all() as T[];
const one = <T = Record<string, unknown>>(sql: string): T => conn.db.prepare(sql).get() as T;

describe("connection: PRAGMA", () => {
  it("foreign_keys が ON（既定は OFF なので明示が要る）", () => {
    assert.equal(one<{ foreign_keys: number }>("PRAGMA foreign_keys").foreign_keys, 1);
  });

  it("synchronous が FULL（クラッシュ注入テストの前提）", () => {
    assert.equal(one<{ synchronous: number }>("PRAGMA synchronous").synchronous, 2);
  });

  it("busy_timeout の既定は 5000", () => {
    assert.equal(one<{ timeout: number }>("PRAGMA busy_timeout").timeout, 5000);
  });

  it("busy_timeout=0 は競合再現テスト用に指定できる（#12）", () => {
    const c = openStore({ clock, busyTimeoutMs: 0 });
    assert.equal((c.db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 0);
    c.close();
  });

  it("schema.sql が適用されている", () => {
    const tables = q<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'");
    assert.ok(tables.some((t) => t.name === "scan_run"));
  });

  it("applySchema:false なら適用しない", () => {
    const c = openStore({ clock, applySchema: false });
    const row = c.db.prepare("SELECT count(*) AS n FROM sqlite_master").get() as { n: number };
    assert.equal(row.n, 0);
    c.close();
  });
});

describe("connection: transaction", () => {
  const rows = () => q<{ n: number }>("SELECT count(*) AS n FROM source")[0]!.n;

  const insertSource = (id: string): void => {
    conn.db
      .prepare(
        `INSERT INTO source (source_id, kind, config_hash, display_name,
           key_unicode_form, key_case_fold, key_path_separator, key_trim_slashes)
         VALUES (?, 'local-fs', 'cfg', ?, 'NFC', 0, 'posix', 1)`,
      )
      .run(id, id);
  };

  it("成功したら COMMIT する", () => {
    conn.transaction(() => insertSource("s1"));
    assert.equal(rows(), 1);
  });

  it("例外が出たら全部 ROLLBACK する（部分成立が無い / #9）", () => {
    assert.throws(() =>
      conn.transaction(() => {
        insertSource("s1");
        insertSource("s2");
        throw new Error("boom");
      }),
    );
    assert.equal(rows(), 0);
  });

  it("元の例外をそのまま投げる（握りつぶさない）", () => {
    const original = new ConcurrentScanError("already running");
    try {
      conn.transaction(() => {
        throw original;
      });
      assert.fail("should have thrown");
    } catch (error) {
      assert.equal(error, original);
      assert.ok(isStoreError(error, "concurrent_scan"));
    }
  });

  it("戻り値をそのまま返す", () => {
    assert.equal(
      conn.transaction(() => 42),
      42,
    );
  });

  it("入れ子は呼び出し側の誤りとして落とす", () => {
    assert.throws(
      () => conn.transaction(() => conn.transaction(() => 1)),
      /nested transaction/,
    );
  });

  it("例外の後もトランザクション状態が残らない", () => {
    assert.throws(() => conn.transaction(() => { throw new Error("boom"); }));
    assert.equal(conn.inTransaction(), false);
    // 次のトランザクションが普通に張れる
    conn.transaction(() => insertSource("s1"));
    assert.equal(rows(), 1);
  });

  it("inTransaction が内側で true を返す", () => {
    assert.equal(conn.inTransaction(), false);
    conn.transaction(() => {
      assert.equal(conn.inTransaction(), true);
    });
    assert.equal(conn.inTransaction(), false);
  });
});

describe("connection: 事象 ID の採番", () => {
  it("毎回ちがう値を返す（事象は再実行で同じ値になってはいけない）", () => {
    const ids = new Set(Array.from({ length: 200 }, () => conn.newEventId()));
    assert.equal(ids.size, 200);
  });

  it("整列に使えない形式（UUIDv4。時刻が埋まっていない）", () => {
    const id = conn.newEventId();
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("appendObservation", () => {
  let store: SqliteLineageStore;
  beforeEach(() => {
    store = new SqliteLineageStore(conn);
  });

  it("occurredAt はストアの時計が刻む", async () => {
    clock.setTo(4242);
    await store.appendObservation({ kind: "document_discovered", detail: {} });
    assert.equal(one<{ occurred_at: number }>("SELECT occurred_at FROM observation").occurred_at, 4242);
  });

  it("observationId はストアが採番し、毎回ちがう", async () => {
    await store.appendObservation({ kind: "document_discovered", detail: {} });
    await store.appendObservation({ kind: "document_discovered", detail: {} });
    const ids = q<{ observation_id: string }>("SELECT observation_id FROM observation");
    assert.equal(new Set(ids.map((r) => r.observation_id)).size, 2);
  });

  it("detail は JSON として保存される", async () => {
    await store.appendObservation({ kind: "run_failed", detail: { reason: "boom", attempt: 2 } });
    const row = one<{ detail: string }>("SELECT detail FROM observation");
    assert.deepEqual(JSON.parse(row.detail), { reason: "boom", attempt: 2 });
  });

  it("省略された参照は NULL になる", async () => {
    await store.appendObservation({ kind: "document_discovered", detail: {} });
    // node:sqlite は null プロトタイプのオブジェクトを返すので、比較前に平たくする
    const row = { ...one<Record<string, unknown>>(
      "SELECT document_id, version_id, scan_id, run_id FROM observation",
    ) };
    assert.deepEqual(row, { document_id: null, version_id: null, scan_id: null, run_id: null });
  });

  it("外側のトランザクションに参加する（分離したトランザクションを張らない）", async () => {
    // 状態変更と観測が同一トランザクションで巻き戻ることを確かめる
    await assert.rejects(async () => {
      conn.transaction(() => {
        void store.appendObservation({ kind: "scan_aborted_safety", detail: {} });
        throw new Error("boom");
      });
    });
    assert.equal(q<{ n: number }>("SELECT count(*) AS n FROM observation")[0]!.n, 0);
  });

  it("トランザクションの外なら単独で確定する", async () => {
    await store.appendObservation({ kind: "document_discovered", detail: {} });
    assert.equal(q<{ n: number }>("SELECT count(*) AS n FROM observation")[0]!.n, 1);
  });

  it("未知の kind はスキーマが拒む（黙って書かない）", async () => {
    await assert.rejects(
      () => store.appendObservation({ kind: __unsafeObservationKind("not_a_real_kind"), detail: {} }),
      /constraint/i,
    );
  });
});

describe("errors", () => {
  it("code で分岐できる（メッセージを読まない）", () => {
    assert.ok(isStoreError(new ConcurrentScanError("x"), "concurrent_scan"));
    assert.ok(!isStoreError(new ConcurrentScanError("x"), "stale_scan"));
    assert.ok(!isStoreError(new Error("x")));
  });

  it("name にクラス名が入る", () => {
    assert.equal(new ConcurrentScanError("x").name, "ConcurrentScanError");
  });

  it("StoreError を継承している", () => {
    assert.ok(new ConcurrentScanError("x") instanceof StoreError);
  });
});
