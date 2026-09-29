/**
 * state-snapshot 自身の検証。
 *
 * ここが間違っていると全フィクスチャの IDEMPOTENT_REPLAY が嘘になるため、
 * 比較規則（AGENTS.md 5節）を直接テストする。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  assertSameState,
  diffSnapshots,
  isEmptyDiff,
  snapshotState,
  type SnapshotReader,
} from "./state-snapshot.ts";

/** 表名 → 行の配列 を返すだけの読み取り口 */
function fakeReader(tables: Record<string, ReadonlyArray<Record<string, unknown>>>): SnapshotReader {
  return {
    all(sql: string) {
      const from = /FROM\s+(\w+)/i.exec(sql);
      const name = from?.[1] ?? "";
      const rows = tables[name] ?? [];
      if (/SELECT DISTINCT kind, document_id/i.test(sql)) {
        const seen = new Set<string>();
        const distinct: Record<string, unknown>[] = [];
        for (const r of rows) {
          const tag = `${String(r["kind"])}\x00${String(r["document_id"] ?? "")}`;
          if (seen.has(tag)) continue;
          seen.add(tag);
          distinct.push({ kind: r["kind"], document_id: r["document_id"] ?? null });
        }
        return Promise.resolve(distinct);
      }
      return Promise.resolve(rows);
    },
  };
}

const doc = (id: string, state = "active") => ({
  document_id: id,
  source_id: "src",
  stable_key: `/${id}.txt`,
  state,
  active_version_id: `v-${id}`,
  first_seen_at: 1000,
  last_seen_at: 1000,
  last_seen_scan_id: "scan-1",
  last_fingerprint: null,
  last_fingerprint_at: null,
  tombstoned_at: null,
});

const obs = (kind: string, documentId: string | null) => ({
  observation_id: `o-${Math.random()}`,
  kind,
  document_id: documentId,
});

describe("state-snapshot: IDEMPOTENT_REPLAY の比較規則", () => {
  it("同一状態の差分は空になる", async () => {
    const before = await snapshotState(fakeReader({ document: [doc("a")] }));
    const after = await snapshotState(fakeReader({ document: [doc("a")] }));
    assert.ok(isEmptyDiff(diffSnapshots(before, after)));
  });

  it("observation の行数が増えても差分にならない", async () => {
    const before = await snapshotState(
      fakeReader({ document: [doc("a")], observation: [obs("document_discovered", "a")] }),
    );
    // 同じ種類の事実が3回起きただけ。追記専用なので行数は増えて当然
    const after = await snapshotState(
      fakeReader({
        document: [doc("a")],
        observation: [
          obs("document_discovered", "a"),
          obs("document_discovered", "a"),
          obs("document_discovered", "a"),
        ],
      }),
    );
    assert.ok(isEmptyDiff(diffSnapshots(before, after)));
  });

  it("observationId が違っても差分にならない", async () => {
    const a = { observation_id: "o-1", kind: "document_discovered", document_id: "a" };
    const b = { observation_id: "o-2", kind: "document_discovered", document_id: "a" };
    const before = await snapshotState(fakeReader({ observation: [a] }));
    const after = await snapshotState(fakeReader({ observation: [b] }));
    assert.ok(isEmptyDiff(diffSnapshots(before, after)));
  });

  it("observation の kind の集合が変われば差分になる", async () => {
    const before = await snapshotState(
      fakeReader({ observation: [obs("document_discovered", "a")] }),
    );
    const after = await snapshotState(
      fakeReader({
        observation: [obs("document_discovered", "a"), obs("document_tombstoned", "a")],
      }),
    );
    const diff = diffSnapshots(before, after);
    assert.deepEqual(diff.observationKindsAdded, ["document_tombstoned\x00a"]);
    assert.equal(diff.rows.length, 0);
  });

  it("同じ kind でも documentId が違えば差分になる", async () => {
    const before = await snapshotState(fakeReader({ observation: [obs("version_created", "a")] }));
    const after = await snapshotState(fakeReader({ observation: [obs("version_created", "b")] }));
    const diff = diffSnapshots(before, after);
    assert.equal(diff.observationKindsAdded.length, 1);
    assert.equal(diff.observationKindsRemoved.length, 1);
  });

  it("document の状態変化は差分になる", async () => {
    const before = await snapshotState(fakeReader({ document: [doc("a", "active")] }));
    const after = await snapshotState(fakeReader({ document: [doc("a", "tombstoned")] }));
    const diff = diffSnapshots(before, after);
    assert.equal(diff.rows.length, 1);
    assert.equal(diff.rows[0]?.kind, "changed");
    assert.deepEqual(diff.rows[0]?.changes, [
      { column: "state", before: "active", after: "tombstoned" },
    ]);
  });

  it("走査の生存記録（last_seen_*）は既定で比較しない", async () => {
    const before = await snapshotState(fakeReader({ document: [doc("a")] }));
    const after = await snapshotState(
      fakeReader({
        document: [{ ...doc("a"), last_seen_at: 9999, last_seen_scan_id: "scan-2" }],
      }),
    );
    assert.ok(isEmptyDiff(diffSnapshots(before, after)));
  });

  it("ignoreColumns を明示すれば既定を上書きできる", async () => {
    const rows = { document: [{ ...doc("a"), last_seen_scan_id: "scan-2" }] };
    const before = await snapshotState(fakeReader({ document: [doc("a")] }), {
      ignoreColumns: {},
    });
    const after = await snapshotState(fakeReader(rows), { ignoreColumns: {} });
    assert.equal(diffSnapshots(before, after).rows.length, 1);
  });

  it("行の追加と削除を区別する", async () => {
    const before = await snapshotState(fakeReader({ document: [doc("a")] }));
    const after = await snapshotState(fakeReader({ document: [doc("b")] }));
    const diff = diffSnapshots(before, after);
    assert.deepEqual(
      diff.rows.map((r) => r.kind).sort(),
      ["added", "removed"],
    );
  });

  it("定義に列挙されていない表は比較しない", async () => {
    // scan_run / processing_run は再実行のたびに別の試行になるため対象外
    const before = await snapshotState(fakeReader({ scan_run: [{ scan_id: "scan-1" }] }));
    const after = await snapshotState(fakeReader({ scan_run: [{ scan_id: "scan-2" }] }));
    assert.ok(isEmptyDiff(diffSnapshots(before, after)));
  });

  it("access_control は複合主キーで対応づける", async () => {
    const acl = (tenant: string, state: string) => ({
      document_id: "a",
      tenant_id: tenant,
      state,
      principals: "[]",
      acl_hash: "h",
    });
    const before = await snapshotState(fakeReader({ access_control: [acl("t1", "unknown")] }));
    const after = await snapshotState(fakeReader({ access_control: [acl("t1", "synced")] }));
    const diff = diffSnapshots(before, after);
    assert.equal(diff.rows[0]?.key, "a\x00t1");
    assert.equal(diff.rows[0]?.kind, "changed");
  });

  it("主キーの重複は黙って上書きせず落とす", async () => {
    await assert.rejects(
      () => snapshotState(fakeReader({ document: [doc("a"), doc("a")] })),
      /duplicate primary key in document/,
    );
  });

  it("BIGINT を BigInt で返すドライバでも number と一致する", async () => {
    const before = await snapshotState(fakeReader({ document: [{ ...doc("a"), first_seen_at: 1000 }] }));
    const after = await snapshotState(
      fakeReader({ document: [{ ...doc("a"), first_seen_at: 1000n }] }),
    );
    assert.ok(isEmptyDiff(diffSnapshots(before, after)));
  });

  it("assertSameState は違いを本文に出す", async () => {
    const before = await snapshotState(fakeReader({ document: [doc("a", "active")] }));
    const after = await snapshotState(fakeReader({ document: [doc("a", "tombstoned")] }));
    assert.throws(() => assertSameState(before, after), /state: "active" -> "tombstoned"/);
  });
});
