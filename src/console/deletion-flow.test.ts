/** DF-1〜15: 小さな架空資料と通常のHTTP操作で、判断・保全・終了の出口を検査する。 */
import { it } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { startConsole } from "./server.ts";
import { LocalFolderSourceAdapter } from "../source/local-fs/local-folder-adapter.ts";
import type { EnumeratedItem } from "../domain/types.ts";
import { SqliteLineageStore } from "../store/sqlite/lineage-store.ts";
import { wordSample } from "../../test/support/office-samples.ts";

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "df-check-"));
  const input = join(root, "input"), dataDir = join(root, "data");
  await mkdir(input);
  const app = await startConsole({ dataDir, port: 0, pickFolder: null });
  t.after(async () => { await app.close(); assert.equal(dirname(root), tmpdir()); await rm(root, { recursive: true, force: true }); });
  const request = (path: string, data?: unknown) => fetch(`${app.origin}/api/${path}`, {
    headers: { Authorization: `Bearer ${app.token}`, ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { method: "POST", body: JSON.stringify(data) }),
  });
  const api = async (path: string, data?: unknown) => {
    const response = await request(path, data), value: any = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value)); return value;
  };
  const until = async (predicate: (s: any) => boolean) => {
    for (let i = 0; i < 600; i++) { const state = await api("state"); if (predicate(state)) return state; await delay(20); }
    assert.fail("状態が決着しない");
  };
  const put = async (name: string, bytes: string | Buffer = name) => { const path = join(input, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); };
  return { app, input, dataDir, api, request, until, put };
}

it("見送り表示 HTTP: stateに判断を保持し、次回の確認と終了後の中立表示へ戻れる", async (t) => {
  const { sourceStatus, scanStatus, attentionCount } = await import(new URL("./public/console-view.js", import.meta.url).href);
  const { api, until, put, input, app, dataDir } = await setup(t);
  await put("gone.txt"); await put("keep.txt");
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  await rm(join(input, "gone.txt"));
  await api("scan", { sourceId }); const first = await until((s) => s.pending);
  await api("decision", { scanId: first.pending.scanId, approve: false });
  const done = await until((s) => !s.busy);
  assert.equal(done.counts.tombstoned, 0);
  assert.equal(done.scans[0].status, "aborted_safety");
  assert.equal(done.sources[0].latest_abort_reason, done.scans[0].abort_reason);
  assert.equal(done.sources[0].latest_approved_max_missing_count, 0);
  assert.equal(sourceStatus(done.sources[0], done).key, "declined");
  assert.equal(scanStatus(done.scans[0], done).key, "declined");
  assert.equal(attentionCount(done), 0);
  await api("scan", { sourceId }); const again = await until((s) => s.pending);
  assert.equal(again.pending.missingCount, 1);
  await app.close();
  const restarted = await startConsole({ dataDir, port: 0, pickFolder: null });
  t.after(() => restarted.close());
  const state: any = await (await fetch(`${restarted.origin}/api/state`, { headers: { Authorization: `Bearer ${restarted.token}` } })).json();
  assert.equal(state.counts.tombstoned, 0);
  assert.match(state.scans[0].approved_note, /終了/);
  assert.equal(sourceStatus(state.sources[0], state).key, "declined");
  assert.equal(attentionCount(state), 0);
  await restarted.close();
});

it("新規発見 HTTP: 改名の新しい名前を同じ走査の参考情報として返す", async (t) => {
  const { api, until, put, input } = await setup(t);
  await put("old.docx", wordSample()); await put("keep.txt");
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  await rename(join(input, "old.docx"), join(input, "renamed.docx"));
  await api("scan", { sourceId }); const { pending } = await until((s) => s.pending);
  assert.equal(pending.discovered.total, 1);
  assert.deepEqual(pending.discovered.rows.map((r: any) => r.stable_key), ["renamed.docx"]);
  assert.deepEqual(pending.candidates.map((r: any) => r.stable_key), ["old.docx"]);
  assert.equal(pending.missingCount, 1);
  assert.match(pending.candidateHash, /^[0-9a-f]{64}$/);
  await api("decision", { scanId: pending.scanId, approve: false }); await until((s) => !s.busy);
  await api("scan", { sourceId }); const next = await until((s) => s.pending);
  assert.deepEqual(next.pending.discovered, { total: 0, rows: [] });
  assert.equal(next.pending.candidateHash, pending.candidateHash);
});

it("新規発見 HTTP: 20件の表示上限と全件数を分け、過去の走査を混ぜない", async (t) => {
  const { api, until, put, input } = await setup(t);
  await put("gone.txt"); await put("keep.txt");
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  await rm(join(input, "gone.txt"));
  for (let i = 0; i < 23; i++) await put(`new-${String(i).padStart(2, "0")}.txt`);
  await api("scan", { sourceId }); const { pending } = await until((s) => s.pending);
  assert.equal(pending.discovered.total, 23);
  assert.equal(pending.discovered.rows.length, 20);
  assert.ok(pending.discovered.rows.every((r: any) => r.stable_key.startsWith("new-")));
  assert.equal(pending.discovered.rows[19].stable_key, "new-19.txt");
  assert.equal(pending.missingCount, 1);
});

it("DF-5/6/8: 一時ファイルは文書を作らず、深い階層・全角・フォルダを区別し除外数を保持する", async (t) => {
  const { api, until, put, input } = await setup(t);
  for (const name of ["~$a.docx", "sub/深い/~$b.DOCX", "~$no-extension", "～＄本物.docx", "~$folder/本物.docx", "~WRL0001.tmp"]) await put(name);
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); const first = await until((s) => !s.busy);
  const docs = await api("documents");
  assert.equal(docs.total, 3);
  assert.deepEqual(docs.rows.map((r: any) => r.stable_key).sort(), ["～＄本物.docx", "~$folder/本物.docx", "~WRL0001.tmp"].sort());
  const skipped = await api(`skipped-summary?scanId=${first.lastReport.scanId}`);
  assert.deepEqual(skipped, [{ kind: "office_temporary_file", count: 3 }]);
  const details = (await api(`observations?scanId=${first.lastReport.scanId}`)).filter((o: any) => o.kind === "entry_skipped").map((o: any) => JSON.parse(o.detail));
  assert.equal(details.length, 3); assert.ok(details.every((d: any) => typeof d.stableKey === "string" && d.sizeBytes > 0));
  await api("scan", { sourceId }); const replay = await until((s) => !s.busy);
  assert.equal(replay.lastReport.versionsCreatedCount, 0);
  assert.deepEqual((await api("documents")).rows.map((r: any) => r.active_version_id), docs.rows.map((r: any) => r.active_version_id));
  // 開いていたOfficeを閉じた状況。消えた対象外ファイルで承認待ちを増やさない。
  await rm(join(input, "~$a.docx"));
  await api("scan", { sourceId }); const closed = await until((s) => !s.busy);
  assert.equal(closed.lastReport.missingCount, 0); assert.equal(closed.counts.tombstoned, 0);
});

it("DF-1/9: 承認後のFS変化は次の走査に回り、削除済みの検索・旧原本・復活が使える", async (t) => {
  const { api, request, until, put, input } = await setup(t);
  for (let i = 0; i < 12; i++) await put(`f${i}.txt`);
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  const original = (await api("documents?q=f0.txt")).rows[0];
  await rm(join(input, "f0.txt"));
  await api("scan", { sourceId }); const { pending } = await until((s) => s.pending);
  assert.deepEqual(pending.reasons, []); assert.equal(pending.missingCount, 1);
  await rm(join(input, "f1.txt")); await put("new.txt");
  assert.equal((await api(`candidates?scanId=${pending.scanId}`)).rows[0].stable_key, "f0.txt");
  await api("decision", { scanId: pending.scanId, approve: true, confirmedCount: 1 });
  const done = await until((s) => !s.busy);
  assert.equal(done.lastReport.tombstonedCount, 1);
  assert.equal((await api("documents?q=f0.txt")).hiddenDeleted, 1);
  assert.equal((await api("documents?q=f0.txt")).total, 0);
  assert.equal((await api("documents?q=f0.txt&deleted=1")).rows[0].state, "tombstoned");
  assert.equal(await (await request(`original?versionId=${original.active_version_id}`)).text(), "f0.txt");
  assert.equal((await request("decision", { scanId: pending.scanId, approve: true, confirmedCount: 1 })).status, 400);
  await api("scan", { sourceId }); const second = await until((s) => s.pending);
  assert.deepEqual(second.pending.candidates.map((r: any) => r.stable_key), ["f1.txt"]);
  await api("decision", { scanId: second.pending.scanId, approve: false }); await until((s) => !s.busy);
  await put("f0.txt"); await put("f1.txt"); await api("scan", { sourceId });
  const restored = await until((s) => !s.busy);
  assert.equal(restored.counts.tombstoned, 0); assert.equal(restored.lastReport.revivedCount, 1);
});

it("DF-2/3/4: 101件の候補は総数で承認し、比率の弁を免除するときだけ追加確認する", async (t) => {
  const { api, request, until, put, input } = await setup(t);
  await put("keep.txt");
  for (let i = 0; i < 101; i++) await put(`sub/f${i}.txt`, "sample");
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  for (let i = 0; i < 101; i++) await rm(join(input, `sub/f${i}.txt`));
  await api("scan", { sourceId }); const { pending } = await until((s) => s.pending);
  assert.equal(pending.missingCount, 101); assert.equal(pending.candidates.length, 100);
  assert.deepEqual(pending.reasons, ["count_ratio", "missing_ratio"]);
  assert.deepEqual(pending.folders, [{ folder: "sub", count: 101 }]);
  assert.equal((await api(`candidates?scanId=${pending.scanId}&offset=100`)).rows.length, 1);
  const decision = { scanId: pending.scanId, approve: true, confirmedCount: 101 };
  for (const extra of [{}, { typedCount: 100, largeLossConfirmed: true }, { confirmedCount: 100, typedCount: 101, largeLossConfirmed: true }]) {
    assert.equal((await request("decision", { ...decision, ...extra })).status, 400);
    assert.equal((await api("state")).counts.tombstoned, 0);
  }
  await api("decision", { ...decision, typedCount: 101, largeLossConfirmed: true });
  const done = await until((s) => !s.busy);
  assert.equal(done.lastReport.tombstonedCount, 101);
  assert.equal(done.scans[0].approved_max_missing_count, 101);
  assert.ok(done.scans[0].approved_note.includes(pending.candidateHash));
});

it("DF-5: 旧版で取り込んだ一時ファイルと本物の欠損を表示し、見送りは両方を保持する", async (t) => {
  const { api, until, put, input, request } = await setup(t);
  await put("sub/~$legacy.DOCX"); await put("real.docx", wordSample()); await put("keep.txt");
  const enumerate = LocalFolderSourceAdapter.prototype.enumerate;
  // 旧版の入力経路だけを再現し、DBには本物の取り込みAPIを通して保存する。
  const legacy = t.mock.method(LocalFolderSourceAdapter.prototype, "enumerate", async function* (this: LocalFolderSourceAdapter): AsyncIterable<EnumeratedItem> {
    for await (const item of enumerate.call(this)) yield item.kind === "office_temporary_file" ? { kind: "entry", entry: { stableKey: item.stableKey, sizeBytes: item.sizeBytes } } : item;
  });
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy); legacy.mock.restore();
  const legacyDoc = (await api("documents?q=legacy")).rows[0];
  await rm(join(input, "real.docx"));
  await api("scan", { sourceId }); const { pending } = await until((s) => s.pending);
  assert.equal(pending.missingCount, 2);
  assert.equal(pending.candidates.find((r: any) => r.stable_key === "sub/~$legacy.DOCX").temporaryName, true);
  assert.equal(pending.candidates.find((r: any) => r.stable_key === "real.docx").temporaryName, false);
  await api("decision", { scanId: pending.scanId, approve: false });
  assert.equal((await until((s) => !s.busy)).counts.tombstoned, 0);
  await api("scan", { sourceId }); const second = await until((s) => s.pending);
  await api("decision", { scanId: second.pending.scanId, approve: true, confirmedCount: 2, typedCount: 2, largeLossConfirmed: true });
  assert.equal((await until((s) => !s.busy)).counts.tombstoned, 2);
  assert.equal(await (await request(`original?versionId=${legacyDoc.active_version_id}`)).text(), "sub/~$legacy.DOCX");
  assert.equal((await readFile(join(input, "sub/~$legacy.DOCX"))).toString(), "sub/~$legacy.DOCX");
  await api("scan", { sourceId }); assert.equal((await until((s) => !s.busy)).lastReport.missingCount, 0);
});

it("DF-10: 解析の成功・失敗は、走査の失敗表示を消さない", async (t) => {
  const { api, until, put, input } = await setup(t);
  await put("good.docx", wordSample()); await put("bad.docx", "not a zip");
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  const docs = (await api("documents")).rows;
  const fail = t.mock.method(SqliteLineageStore.prototype, "beginScan", async () => { throw new Error("架空の保存先エラー"); });
  await api("scan", { sourceId }); const failure = await until((s) => !s.busy); fail.mock.restore();
  assert.match(failure.lastScanError, /架空の保存先エラー/);
  for (const name of ["good.docx", "bad.docx"]) {
    const versionId = docs.find((d: any) => d.stable_key === name).active_version_id;
    await api("parse", { versionId }); const state = await until((s) => !s.busy);
    assert.equal(state.lastScanError, failure.lastScanError);
    assert.equal((await api(`content?versionId=${versionId}`)).status, name === "good.docx" ? "ready" : "failed");
    if (name === "bad.docx") assert.equal(state.lastParseError.versionId, versionId);
  }
});

it("DF-15関連: 列挙中の終了要求は、後から承認待ちにならず見送って終了する", async (t) => {
  const { api, until, put, input, app, dataDir } = await setup(t);
  await put("gone.txt"); await put("keep.txt");
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy); await rm(join(input, "gone.txt"));
  let entered!: () => void, release!: () => void;
  const entering = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const enumerate = LocalFolderSourceAdapter.prototype.enumerate;
  t.mock.method(LocalFolderSourceAdapter.prototype, "enumerate", async function* (this: LocalFolderSourceAdapter) { entered(); await gate; yield* enumerate.call(this); });
  await api("scan", { sourceId }); await entering;
  const closing = app.close();
  // closeがサービスへ届くまでのmicrotaskを通し、列挙の続きを解放する。
  await delay(20); release(); await closing;
  const db = new DatabaseSync(join(dataDir, "lineage.sqlite"), { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT count(*) n FROM scan_run WHERE status='running'").get()!.n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM document WHERE state='tombstoned'").get()!.n, 0);
    assert.equal(db.prepare("SELECT approved_max_missing_count FROM scan_run ORDER BY start_seq DESC LIMIT 1").get()!.approved_max_missing_count, 0);
  } finally { db.close(); }
});
