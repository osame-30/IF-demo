/** HTTP の操作から実FS・DBまで通す。画面のボタンだけ成功する模型にはしない。 */
import { it } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { startConsole } from "./server.ts";
import { request as httpRequest } from "node:http";
import { openStore } from "../store/sqlite/connection.ts";
import { SqliteLineageStore } from "../store/sqlite/lineage-store.ts";
import { systemClock } from "../runtime/system-clock.ts";
import { wordSample, excelSample, wordControlledTableEntries, zipEntries, wordTabEntries, wordSymbolEntries, wordHiddenEntries } from "../../test/support/office-samples.ts";
import { canonicalConfigHash } from "../domain/ids.ts";
import { PARSER_CONFIG, PARSER_VERSION } from "../parser/process.ts";
import type { BlobKey, VersionId, WorkerId } from "../domain/types.ts";
import { blobPath } from "../store/blob/blob-path.ts";
import { FileBlobStore } from "../store/blob/file-blob-store.ts";
import { readParsed } from "../pipeline/parse.ts";

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "operator-ui-"));
  const input = join(root, "input"); await mkdir(input);
  const dataDir = join(root, "data");
  const app = await startConsole({ dataDir, port: 0 });
  const observers: DatabaseSync[] = [];
  const openDatabase = () => { const db = new DatabaseSync(join(dataDir, "lineage.sqlite")); observers.push(db); return db; };
  t.after(async () => { for (const db of observers) db.close(); await app.close(); await rm(root, { recursive: true, force: true }); });
  const request = async (path: string, data?: unknown) => fetch(`${app.origin}/api/${path}`, {
    headers: { Authorization: `Bearer ${app.token}`, ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(data === undefined ? {} : { method: "POST", body: JSON.stringify(data) }),
  });
  const api = async (path: string, data?: unknown) => {
    const res = await request(path, data); const body: any = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body)); return body;
  };
  const until = async (predicate: (state: any) => boolean) => {
    for (let i = 0; i < 600; i++) { const s = await api("state"); if (predicate(s)) return s; await delay(50); }
    assert.fail("運用操作が30秒以内に決着しない");
  };
  return { root, input, dataDir, app, request, api, until, openDatabase };
}

it("⑥ HTTP: 作成・履歴・固定出典・再実行を通し、別原本の履歴と無認証を拒否する", async (t) => {
  const { input, app, api, request, until, openDatabase } = await setup(t);
  await writeFile(join(input, "文書.docx"), wordSample());
  await writeFile(join(input, "表.xlsx"), excelSample());
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  const versions = (await api("documents")).rows.map((r: any) => r.active_version_id);
  for (const versionId of versions) {
    assert.equal((await api(`normalized?versionId=${versionId}`)).status, "not_normalized");
    await api("normalize", { versionId });
    assert.equal((await until((s) => !s.busy)).lastNormalizeError, undefined);
    const out = await api(`normalized?versionId=${versionId}`);
    assert.equal(out.status, "ready"); assert.equal(out.history.length, 1);
    assert.equal(out.canNormalize, true);
    assert.deepEqual(await api(`normalized?versionId=${versionId}&artifactId=${out.artifactId}`), out);
    const { renderNormalizedPage } = await import(new URL("./public/normalized-view.js", import.meta.url).href);
    const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
    const html = renderNormalizedPage(out.result, "", true, 0, esc);
    if (out.result.format === "xlsx") {
      assert.ok(html.includes("出典を見る · 確認用!D1"));
      assert.ok(html.includes("SUM(A1:C1)")); assert.ok(html.includes("値が未保存"));
    } else { assert.ok(html.includes("出典を見る · 本文 / 段落 1")); assert.ok(html.includes("見出し 1")); }
    assert.equal((await request(`parsed-artifact?artifactId=${out.inputArtifactId}`)).status, 404);
    assert.equal((await request(`normalized?versionId=${versions.find((v: string) => v !== versionId)}&artifactId=${out.artifactId}`)).status, 400);
    const db = openDatabase();
    const before = db.prepare("SELECT * FROM processing_run ORDER BY rowid").all();
    assert.equal((await api("normalize", { versionId })).status, "ready");
    assert.deepEqual(db.prepare("SELECT * FROM processing_run ORDER BY rowid").all(), before);
  }
  for (const path of ["normalized", "normalize"]) {
    const response = await fetch(`${app.origin}/api/${path}`, path === "normalize" ? { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" } : {});
    assert.equal(response.status, 401); await response.arrayBuffer();
  }
});

it("⑥ HTTP: 旧DBは⑤を利用でき、⑥は案内付きで停止して自動移行しない", async (t) => {
  const { input, api, request, until, openDatabase } = await setup(t);
  await writeFile(join(input, "文書.docx"), wordSample());
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  const versionId = (await api("documents")).rows[0].active_version_id;
  const db = openDatabase(), ddl = String(db.prepare("SELECT sql FROM sqlite_master WHERE name='artifact'").get()!.sql).replace("'parsed_document', 'normalized_document',", "'parsed_document',");
  db.exec("DROP TABLE artifact"); db.exec(ddl); db.exec("CREATE INDEX idx_artifact_derivation ON artifact(derivation_key)");
  await api("parse", { versionId }); await until((s) => !s.busy);
  assert.equal((await api(`content?versionId=${versionId}`)).status, "ready");
  assert.equal((await api(`normalized?versionId=${versionId}`)).canNormalize, false);
  const response = await request("normalize", { versionId });
  assert.equal(response.status, 400); assert.match((await response.json() as { error: string }).error, /DBの更新/);
  assert.equal(db.prepare("SELECT count(*) n FROM artifact").get()!.n, 1);
  assert.ok(!String(db.prepare("SELECT sql FROM sqlite_master WHERE name='artifact'").get()!.sql).includes("'normalized_document'"));
});

it("⑤ S5-72: 旧Parserの成功結果を保持し、新版の表を同じ原本から保存できる", async (t) => {
  const { input, dataDir, api, until, openDatabase } = await setup(t);
  await writeFile(join(input, "表の確認.docx"), zipEntries(wordControlledTableEntries()));
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  const versionId = String((await api("documents")).rows[0].active_version_id) as VersionId;
  const conn = openStore({ clock: systemClock(), location: join(dataDir, "lineage.sqlite"), applySchema: false });
  // 正規の確定APIで旧版の成果物を残し、存在するだけで新版の処理済みにならないことを見る。
  const oldDraft = { processorName: "office-xml", processorVersion: "office-xml-1", configHash: canonicalConfigHash({ ...PARSER_CONFIG, format: "docx" }), inputIds: [versionId] };
  try {
    const store = new SqliteLineageStore(conn), workerId = "old-parser-fixture" as WorkerId;
    const run = await store.claimRun({ ...oldDraft, rootVersionId: versionId, workerId, leaseSeconds: 120 });
    assert.ok(run);
    await store.commitDerivation({ derivation: oldDraft, artifacts: [{ kind: "inline", ordinal: 0, type: "parsed_document", content: JSON.stringify({ schemaVersion: 1, format: "docx", warnings: [], blocks: [] }) }], runId: run.runId, workerId });
  } finally { conn.close(); }
  const db = openDatabase();
  const oldArtifacts = db.prepare("SELECT * FROM artifact").all();
  const oldDerivations = db.prepare("SELECT * FROM derivation").all();
  const oldRuns = db.prepare("SELECT * FROM processing_run").all();
  assert.equal((await api(`content?versionId=${versionId}`)).status, "not_parsed");
  await api("parse", { versionId }); await until((s) => !s.busy);
  const current = await api(`content?versionId=${versionId}`);
  assert.equal(current.status, "ready");
  assert.deepEqual(current.result.blocks[0].rows.map((r: any[]) => r.map((c) => c.text)), [["A1", "A2", "A3"], ["B1", "B2", "B3"], ["C1", "C2", "C3"]]);
  assert.equal(current.result.blocks[0].rows[1][1].location, "本文 / 表 1 / 行 2 / セル 2");
  assert.equal(db.prepare("SELECT count(*) n FROM document_version").get()!.n, 1);
  assert.deepEqual(db.prepare("SELECT processor_version FROM derivation ORDER BY processor_version").all().map((r) => r.processor_version), ["office-xml-1", PARSER_VERSION]);
  assert.deepEqual(db.prepare("SELECT * FROM artifact WHERE artifact_id=?").all(oldArtifacts[0]!.artifact_id!), oldArtifacts);
  assert.deepEqual(db.prepare("SELECT * FROM derivation WHERE derivation_key=?").all(oldDerivations[0]!.derivation_key!), oldDerivations);
  assert.deepEqual(db.prepare("SELECT * FROM processing_run WHERE run_id=?").all(oldRuns[0]!.run_id!), oldRuns);
  const snapshot = () => ["document_version", "derivation", "artifact", "processing_run"].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before = snapshot();
  assert.equal((await api("parse", { versionId })).status, "ready");
  assert.deepEqual(snapshot(), before);
});

for (const fixture of [
  { scenario: "Opus S5-2", entries: wordTabEntries(), oldVersion: "office-xml-2", oldText: "\t\t氏名\t架空 太郎\n\t続き", expected: "氏名\t架空 太郎\n\t続き" },
  { scenario: "Opus S5-3", entries: wordSymbolEntries(), oldVersion: "office-xml-3", oldText: "電話 0312345678 確認済", expected: "電話 03\u20111234\u20115678 確認［記号未再現（フォント: Wingdings / コード: F0FC）］済" },
  { scenario: "Opus S5-4", entries: wordHiddenEntries(), oldVersion: "office-xml-4", oldText: "提出日 （記入例）令和6年5月1日", expected: "提出日 （記入例）令和6年5月1日" },
]) it(`⑤ ${fixture.scenario}: 旧版の成功結果を保持して同じ原本を再解析する`, async (t) => {
  const { input, dataDir, api, request, until, openDatabase } = await setup(t);
  const bytes = zipEntries(fixture.entries);
  await writeFile(join(input, "文字の確認.docx"), bytes);
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  const versionId = String((await api("documents")).rows[0].active_version_id) as VersionId;
  const conn = openStore({ clock: systemClock(), location: join(dataDir, "lineage.sqlite"), applySchema: false });
  // 旧成功を消さず、新しい処理版の通常の確定経路だけで訂正できることを検査する。
  try {
    const store = new SqliteLineageStore(conn), workerId = "old-tabs-parser" as WorkerId;
    const draft = { processorName: "office-xml", processorVersion: fixture.oldVersion, configHash: canonicalConfigHash({ ...PARSER_CONFIG, format: "docx" }), inputIds: [versionId] };
    const run = await store.claimRun({ ...draft, rootVersionId: versionId, workerId, leaseSeconds: 120 });
    assert.ok(run);
    const paragraph = { kind: "paragraph", location: "本文 / 段落 1", style: "", text: fixture.oldText };
    await store.commitDerivation({ derivation: draft, artifacts: [{ kind: "inline", ordinal: 0, type: "parsed_document", content: JSON.stringify({ schemaVersion: 1, format: "docx", warnings: [], blocks: [paragraph] }) }], runId: run.runId, workerId });
  } finally { conn.close(); }
  const db = openDatabase();
  const tables = ["document_version", "derivation", "artifact", "processing_run"];
  const snapshot = () => tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const old = snapshot();
  assert.equal((await api(`content?versionId=${versionId}`)).status, "not_parsed");
  await api("parse", { versionId }); await until((s) => !s.busy);
  const result = await api(`content?versionId=${versionId}`);
  assert.equal(result.status, "ready");
  assert.equal(result.result.blocks[0].text, fixture.expected);
  assert.equal(result.result.blocks[1].rows[0][0].text, result.result.blocks[0].text);
  assert.equal(result.result.warnings.some((w: string) => w.includes("記号未再現")), fixture.scenario === "Opus S5-3");
  assert.equal(result.result.warnings.some((w: string) => w.includes("隠し文字の設定を検出")), fixture.scenario === "Opus S5-4");
  const current = snapshot();
  assert.deepEqual(current[0], old[0]);
  for (let i = 1; i < tables.length; i++) { assert.equal(current[i]!.length, 2); assert.deepEqual(current[i]![0], old[i]![0]); }
  assert.deepEqual(Buffer.from(await (await request(`original?versionId=${versionId}`)).arrayBuffer()), bytes);
  assert.equal((await api("parse", { versionId })).status, "ready");
  assert.deepEqual(snapshot(), current);
});

it("商品化 S5-74: 原本GETは1件までで、切断後は枠を解放して再取得できる", async (t) => {
  const { input, app, api, request, until } = await setup(t);
  const bytes = wordSample("同時読取の確認");
  await writeFile(join(input, "原本.docx"), bytes);
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  const versionId = (await api("documents")).rows[0].active_version_id;
  let signalEntered!: () => void, signalRelease!: () => void;
  const entered = { promise: new Promise<void>((resolve) => { signalEntered = resolve; }), resolve: () => signalEntered() };
  const release = { promise: new Promise<void>((resolve) => { signalRelease = resolve; }), resolve: () => signalRelease() };
  const get = FileBlobStore.prototype.get;
  let gated = true;
  t.mock.method(FileBlobStore.prototype, "get", async function (this: FileBlobStore, ...args: Parameters<FileBlobStore["get"]>) {
    const read = await get.apply(this, args);
    if (!gated) return read;
    gated = false;
    return { ...read, stream: read.stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ async transform(chunk, sink) { entered.resolve(); await release.promise; sink.enqueue(chunk); } })) };
  });
  const controller = new AbortController();
  const pending = fetch(`${app.origin}/api/original?versionId=${versionId}`, { headers: { Authorization: `Bearer ${app.token}` }, signal: controller.signal });
  const aborted = assert.rejects(pending, /abort/i);
  try {
    await entered.promise;
    const busy = await request(`original?versionId=${versionId}`);
    assert.equal(busy.status, 429); assert.equal(busy.headers.get("retry-after"), "1");
    assert.equal((await request("state")).status, 200);
    controller.abort(); await aborted;
  } finally { controller.abort(); release.resolve(); }
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await request(`original?versionId=${versionId}`);
    if (response.status === 429) { await response.arrayBuffer(); await delay(10); continue; }
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes); return;
  }
  assert.fail("切断後に原本GETの枠が解放されない");
});

it("⑤ S5-76: 101版から初版へ戻しても現行版を選べ、本文と原本が一致する", async (t) => {
  const { input, api, request, until, openDatabase } = await setup(t);
  const file = join(input, "版の確認.docx"), original = wordSample("INITIAL_VERSION");
  const { sourceId } = await api("sources", { root: input });
  const scan = async (bytes: Buffer) => {
    await writeFile(file, bytes);
    await api("scan", { sourceId });
    const state = await until((s) => !s.busy);
    assert.equal(state.lastReport.status, "completed");
    return (await api("documents")).rows[0];
  };
  const first = await scan(original);
  let latest = first;
  for (let i = 1; i <= 100; i++) latest = await scan(wordSample(`PAST_VERSION_${i}`));
  const reverted = await scan(original);
  assert.equal(reverted.active_version_id, first.active_version_id);
  const detail = await api(`document?id=${first.document_id}`);
  assert.equal(detail.versions.length, 100);
  assert.equal(new Set(detail.versions.map((v: any) => v.version_id)).size, 100);
  assert.equal(detail.versions[0].version_id, first.active_version_id);
  assert.ok(detail.versions.some((v: any) => v.version_id === latest.active_version_id));
  assert.equal(detail.observations.length, 100);
  const db = openDatabase();
  assert.equal(db.prepare("SELECT count(*) n FROM document_version").get()!.n, 101);
  for (const [versionId, bytes, text] of [
    [first.active_version_id, original, "INITIAL_VERSION"],
    [latest.active_version_id, wordSample("PAST_VERSION_100"), "PAST_VERSION_100"],
  ] as const) {
    await api("parse", { versionId }); await until((s) => !s.busy);
    const content = await api(`content?versionId=${versionId}`);
    assert.equal(content.status, "ready");
    assert.equal(content.versionId, versionId);
    assert.ok(content.result.blocks.some((b: any) => b.text === text));
    const downloaded = await request(`original?versionId=${versionId}`);
    assert.equal(downloaded.status, 200);
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  }
  assert.deepEqual((await api(`document?id=${first.document_id}`)).versions, detail.versions);
});

it("⑤ HTTP: Word/Excelの原本照合・保存・再実行・版切替まで通る", async (t) => {
  const { input, dataDir, app, api, request, until, openDatabase } = await setup(t);
  const samples = [["労災資料.docx", wordSample()], ["履歴書.xlsx", excelSample()]] as const;
  for (const [name, bytes] of samples) await writeFile(join(input, name), bytes);
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  const documents = await api("documents");
  const db = openDatabase();
  const snapshot = () => ["document_version", "derivation", "artifact", "processing_run"].map((table) => db.prepare(`SELECT * FROM ${table}`).all());
  for (const d of documents.rows) {
    const versionId = d.active_version_id;
    assert.equal((await api(`content?versionId=${versionId}`)).status, "not_parsed");
    await api("parse", { versionId }); await until((s) => !s.busy);
    const result = await api(`content?versionId=${versionId}`);
    assert.equal(result.status, "ready"); assert.equal(result.versionId, versionId);
    const raw = await request(`original?versionId=${versionId}`);
    assert.equal(raw.status, 200); assert.match(raw.headers.get("content-disposition")!, /^attachment/);
    assert.deepEqual(Buffer.from(await raw.arrayBuffer()), samples.find(([name]) => name === d.stable_key)![1]);
    const before = snapshot();
    for (let i = 0; i < 10; i++) assert.equal((await api("parse", { versionId })).status, "ready");
    assert.deepEqual(snapshot(), before);
    assert.equal((await fetch(`${app.origin}/api/content?versionId=${versionId}`)).status, 401);
    assert.equal((await fetch(`${app.origin}/api/original?versionId=${versionId}`)).status, 401);
  }
  assert.equal(db.prepare("SELECT count(*) AS n FROM artifact").get()!.n, 2);
  const original = documents.rows.find((d: any) => d.stable_key === "労災資料.docx");
  await writeFile(join(input, "労災資料.docx"), wordSample("追記した架空の記録"));
  await api("scan", { sourceId }); await until((s) => !s.busy);
  const current = (await api(`document?id=${original.document_id}`)).document.active_version_id;
  assert.notEqual(current, original.active_version_id);
  assert.equal((await api(`content?versionId=${current}`)).status, "not_parsed");
  assert.equal((await api(`content?versionId=${original.active_version_id}`)).status, "ready");
  await api("parse", { versionId: current }); await until((s) => !s.busy);
  assert.equal((await api(`content?versionId=${current}`)).result.blocks[1].text, "追記した架空の記録");
  const audit = await api("audit", {});
  for (const name of ["LINEAGE_COMPLETE", "NO_ORPHAN_ARTIFACT", "HASH_MATCHES_BLOB", "DERIVATION_OUTPUT_STABLE", "DERIVATION_KEY_MATCHES_MATERIALS"]) assert.equal(audit.report.results.find((r: any) => r.name === name).status, "ok", name);
});

it("⑤ HTTP: 破損・未対応の理由が残り、原本の修正後に新しい版を解析できる", async (t) => {
  const { input, dataDir, api, until, openDatabase } = await setup(t);
  await writeFile(join(input, "壊れた.docx"), "not a zip"); await writeFile(join(input, "印刷用.pdf"), "%PDF-test");
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  const docs = (await api("documents")).rows;
  const broken = docs.find((d: any) => d.stable_key.endsWith("docx"));
  const pdf = docs.find((d: any) => d.stable_key.endsWith("pdf"));
  assert.equal((await api("parse", { versionId: pdf.active_version_id })).status, "unsupported");
  await api("parse", { versionId: broken.active_version_id }); const failed = await until((s) => !s.busy);
  // 解析の失敗は版に結び付けて持ち、走査の失敗表示（赤帯）には出さない（DF-10）
  assert.equal(failed.lastParseError.versionId, broken.active_version_id);
  assert.equal(failed.lastScanError ?? null, null);
  assert.equal((await api(`content?versionId=${broken.active_version_id}`)).status, "failed");
  const db = openDatabase();
  assert.equal(db.prepare("SELECT count(*) AS n FROM artifact").get()!.n, 0);
  assert.equal(db.prepare("SELECT permanent FROM processing_run").get()!.permanent, 0);
  await writeFile(join(input, "壊れた.docx"), wordSample());
  await api("scan", { sourceId }); await until((s) => !s.busy);
  const current = (await api(`document?id=${broken.document_id}`)).document.active_version_id;
  await api("parse", { versionId: current }); await until((s) => !s.busy);
  assert.equal((await api(`content?versionId=${current}`)).status, "ready");
  assert.equal((await api(`content?versionId=${broken.active_version_id}`)).status, "failed");
});

it("⑤ HTTP: 成果物保存の途中失敗で部分確定せず、同じ版を再試行できる", async (t) => {
  const { input, dataDir, api, until, openDatabase } = await setup(t);
  await writeFile(join(input, "労災.docx"), wordSample());
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  const versionId = (await api("documents")).rows[0].active_version_id;
  const db = openDatabase();
  db.exec("CREATE TRIGGER fail_parse BEFORE INSERT ON artifact BEGIN SELECT RAISE(ABORT, 'injected artifact failure'); END");
  await api("parse", { versionId }); await until((s) => !s.busy);
  assert.equal((await api(`content?versionId=${versionId}`)).status, "failed");
  assert.equal(db.prepare("SELECT count(*) AS n FROM derivation").get()!.n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM artifact").get()!.n, 0);
  db.exec("DROP TRIGGER fail_parse");
  await api("parse", { versionId }); await until((s) => !s.busy);
  assert.equal((await api(`content?versionId=${versionId}`)).status, "ready");
  assert.deepEqual(db.prepare("SELECT status FROM processing_run ORDER BY attempt").all().map((r) => r.status), ["failed", "succeeded"]);
});

it("⑤ HTTP: 保存結果の本文改ざん・成功証拠の欠落を完了扱いしない", async (t) => {
  const { input, dataDir, api, request, until, openDatabase } = await setup(t);
  await writeFile(join(input, "履歴書.xlsx"), excelSample());
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  const versionId = (await api("documents")).rows[0].active_version_id;
  await api("parse", { versionId }); await until((s) => !s.busy);
  assert.equal((await api(`content?versionId=${versionId}`)).status, "ready");
  const db = openDatabase();
  const original = db.prepare("SELECT inline_content FROM artifact").get()!.inline_content;
  db.prepare("UPDATE artifact SET inline_content=?").run("{}");
  assert.equal((await request(`content?versionId=${versionId}`)).status, 400);
  db.prepare("UPDATE artifact SET inline_content=?").run(original!);
  db.exec("UPDATE processing_run SET status='abandoned'");
  assert.equal((await request(`content?versionId=${versionId}`)).status, 400);
});

it("⑤ HTTP: 中断した解析は期限後に再取得でき、別接続でも完了結果を復元できる", async (t) => {
  const { input, dataDir, api, until, openDatabase } = await setup(t);
  await writeFile(join(input, "資料.docx"), wordSample());
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  const versionId = String((await api("documents")).rows[0].active_version_id) as VersionId;
  const location = join(dataDir, "lineage.sqlite");
  const conn = openStore({ clock: systemClock(), location, applySchema: false });
  try {
    const store = new SqliteLineageStore(conn);
    const run = await store.claimRun({ processorName: "office-xml", processorVersion: PARSER_VERSION, configHash: canonicalConfigHash({ ...PARSER_CONFIG, format: "docx" }), inputIds: [versionId], rootVersionId: versionId, workerId: "interrupted-parser" as WorkerId, leaseSeconds: 120 });
    assert.ok(run);
  } finally { conn.close(); }
  assert.equal((await api(`content?versionId=${versionId}`)).status, "waiting");
  const db = openDatabase();
  db.exec("UPDATE processing_run SET lease_expires_at=1 WHERE status='leased'");
  await api("parse", { versionId }); await until((s) => !s.busy);
  assert.equal((await api(`content?versionId=${versionId}`)).status, "ready");
  assert.deepEqual(db.prepare("SELECT status FROM processing_run ORDER BY attempt").all().map((r) => r.status), ["abandoned", "succeeded"]);
  const reopened = openStore({ clock: systemClock(), location, applySchema: false });
  try { assert.equal(readParsed(reopened, versionId).status, "ready"); } finally { reopened.close(); }
});

it("⑤ HTTP: 破損原本を解析・ダウンロードできず、既存の修復操作後に同じ版を再試行できる", async (t) => {
  const { input, dataDir, api, request, until, openDatabase } = await setup(t);
  await writeFile(join(input, "資料.docx"), wordSample());
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  const versionId = (await api("documents")).rows[0].active_version_id;
  const db = openDatabase(), key = db.prepare("SELECT blob_key FROM document_version WHERE version_id=?").get(versionId)!.blob_key;
  const path = blobPath(join(dataDir, "blobs"), String(key) as BlobKey);
  assert.deepEqual(await readFile(path), wordSample());
  await writeFile(path, "corrupt");
  await api("parse", { versionId }); await until((s) => !s.busy);
  assert.equal((await api(`content?versionId=${versionId}`)).status, "failed");
  assert.equal((await request(`original?versionId=${versionId}`)).status, 400);
  assert.equal(db.prepare("SELECT count(*) AS n FROM artifact").get()!.n, 0);
  await api("scan", { sourceId, repair: true, repairConfirmed: true }); await until((s) => !s.busy);
  await api("parse", { versionId }); await until((s) => !s.busy);
  assert.equal((await api(`content?versionId=${versionId}`)).status, "ready");
  assert.equal(db.prepare("SELECT count(*) AS n FROM document_version").get()!.n, 1);
});

it("運用UI: 画面が import するモジュールをすべて配信する", async (t) => {
  // 配信表に無いモジュールを import すると、画面は一行も描かれずに止まる
  const { app } = await setup(t);
  const script = await (await fetch(`${app.origin}/app.js`)).text();
  const modules = [...script.matchAll(/from "\.\/([\w-]+\.js)"/g)].map((match) => match[1]!);
  assert.ok(modules.length >= 2, "import の抽出に失敗している");
  for (const name of modules) {
    const response = await fetch(`${app.origin}/${name}`);
    assert.equal(response.status, 200, name);
    assert.match(response.headers.get("content-type")!, /javascript/, name);
  }
});

it("運用UI: 別サイト・トークンなしから読取も更新もできない", async (t) => {
  const { app, input, request } = await setup(t);
  assert.equal((await fetch(`${app.origin}/api/state`)).status, 401);
  assert.equal((await fetch(`${app.origin}/api/sources`, { method: "POST", headers: { Authorization: `Bearer ${app.token}`, Origin: "https://outside.example", "Content-Type": "application/json" }, body: JSON.stringify({ root: input }) })).status, 403);
  const html = await fetch(app.origin);
  assert.match(html.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.equal((await html.text()).includes(app.token), false);
  assert.equal((await request("sources", { root: input })).status, 200);
});

it("運用UI: 登録・検索・履歴・15項目の点検と未検査がHTTPから取得できる", async (t) => {
  const { input, dataDir, api, request, until, openDatabase } = await setup(t);
  assert.equal((await request("sources", { root: dataDir })).status, 400);
  await writeFile(join(input, "資料100%.txt"), "original");
  const s = await api("sources", { root: input, name: "社内資料" });
  assert.deepEqual(await api("sources", { root: input }), s);
  await api("scan", { sourceId: s.sourceId });
  const state = await until((value) => !value.busy);
  assert.equal(state.counts.active, 1);
  const docs = await api("documents?q=%25"); assert.equal(docs.total, 1);
  const history = await api(`document?id=${docs.rows[0].document_id}`);
  assert.equal(history.versions.length, 1); assert.ok(history.observations.length > 0);
  const audit = await api("audit", {});
  assert.equal(audit.report.results.length, 15);
  assert.equal(audit.report.results.find((r: any) => r.name === "HASH_MATCHES_BLOB").status, "ok");
  assert.equal(audit.report.results.find((r: any) => r.name === "IDEMPOTENT_REPLAY").status, "not_checked");
  await api("scan", { sourceId: s.sourceId }); await until((value) => !value.busy);
  assert.equal((await api(`document?id=${docs.rows[0].document_id}`)).versions.length, 1);
});

it("運用UI: 削除候補は件数の確認だけで反映でき、上限と理由はサーバーが決め、削除済みは既定で隠す", async (t) => {
  const { input, api, request, until, openDatabase } = await setup(t);
  // 20件中1件。件数比・欠損率の弁が鳴らない少量の削除（一押しで反映できる側）
  for (let i = 0; i < 19; i++) await writeFile(join(input, `keep${String(i).padStart(2, "0")}.txt`), `keep ${i}`);
  await writeFile(join(input, "gone.txt"), "gone");
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  await rm(join(input, "gone.txt"));
  await api("scan", { sourceId });
  const first = await until((s) => !!s.pending);
  assert.equal(first.pending.missingCount, 1);
  assert.equal(first.pending.ratioValveWouldFire, false);
  assert.equal(first.pending.candidates[0].stable_key, "gone.txt");
  assert.equal(first.pending.candidates[0].size_bytes, 4, "候補に大きさが無い");
  assert.ok(first.pending.candidates[0].last_seen_at > 0, "候補に最後に見えた日時が無い");
  // 上限はサーバーが持つ件数。画面と食い違う件数・古い走査の承認は受け付けない（DF-3）
  assert.equal((await request("decision", { scanId: first.pending.scanId, approve: true, confirmedCount: 2 })).status, 400);
  assert.equal((await request("decision", { scanId: first.pending.scanId, approve: true })).status, 400);
  assert.equal((await request("decision", { scanId: "old", approve: false })).status, 400);
  await api("decision", { scanId: first.pending.scanId, approve: false });
  assert.equal((await until((s) => !s.busy)).counts.tombstoned, 0);
  await api("scan", { sourceId }); const second = await until((s) => !!s.pending);
  assert.equal((await request("decision", { scanId: first.pending.scanId, approve: true, confirmedCount: 1 })).status, 400);
  await api("decision", { scanId: second.pending.scanId, approve: true, confirmedCount: 1 });
  const done = await until((s) => !s.busy);
  assert.equal(done.counts.tombstoned, 1); assert.equal(done.lastReport.tombstonedCount, 1);
  assert.equal(done.scans[0].approved_max_missing_count, 1);
  // 理由は自動。候補 documentId 集合の要約を残し、後から document_missing と突き合わせられる（DF-1）
  const goneId = String(openDatabase().prepare("SELECT document_id FROM document WHERE stable_key='gone.txt'").get()!.document_id);
  const { createHash } = await import("node:crypto");
  assert.equal(done.scans[0].approved_note, `運用画面で削除候補 1 件を確認して反映（候補 sha256:${createHash("sha256").update(goneId).digest("hex")}）`);

  // C: 削除済みは既定の一覧・検索から外し、隠した件数を出す。切替で表示する（DF-9）
  const listed = await api("documents?q=&offset=0");
  assert.equal(listed.total, 19); assert.equal(listed.hiddenDeleted, 1);
  assert.ok(listed.rows.every((d: any) => d.state !== "tombstoned"));
  const searched = await api(`documents?q=${encodeURIComponent("gone")}&offset=0`);
  assert.equal(searched.total, 0); assert.equal(searched.hiddenDeleted, 1, "検索で隠した削除済みの件数が出ない");
  const shown = await api(`documents?q=${encodeURIComponent("gone")}&offset=0&deleted=1`);
  assert.equal(shown.total, 1); assert.equal(shown.rows[0].state, "tombstoned"); assert.equal(shown.hiddenDeleted, 0);
});

it("運用UI: 大量の欠損は一押しで反映せず追加の確認を要求し、100件を超えてもフォルダ別の件数と共に反映できる", async (t) => {
  const { input, api, request, until } = await setup(t);
  await mkdir(join(input, "a")); await mkdir(join(input, "b"));
  for (let i = 0; i < 100; i++) await writeFile(join(input, "a", `f${i}.txt`), `a${i}`);
  for (let i = 0; i < 50; i++) await writeFile(join(input, "b", `f${i}.txt`), `b${i}`);
  for (let i = 0; i < 10; i++) await writeFile(join(input, `root${i}.txt`), `r${i}`);
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  // フォルダの欠落（同期・マウントの失敗を模す）。件数比・欠損率の弁が鳴る値（DF-2）
  await rm(join(input, "a"), { recursive: true }); await rm(join(input, "b"), { recursive: true });
  await api("scan", { sourceId });
  const { pending } = await until((s) => !!s.pending);
  assert.equal(pending.missingCount, 150);
  assert.equal(pending.ratioValveWouldFire, true);
  assert.deepEqual(pending.folders, [{ folder: "a", count: 100 }, { folder: "b", count: 50 }]);
  const page = await api(`candidates?scanId=${pending.scanId}&offset=100`);
  assert.equal(page.total, 150); assert.equal(page.rows.length, 50);
  assert.equal((await request("decision", { scanId: pending.scanId, approve: true, confirmedCount: 150 })).status, 400, "大量の欠損が一押しで通る");
  await api("decision", { scanId: pending.scanId, approve: true, confirmedCount: 150, typedCount: 150, largeLossConfirmed: true });
  const done = await until((s) => !s.busy);
  // 表示の100件で切った数を上限にすると、ここで approval_missing_limit になり永久に反映されない（DF-3）
  assert.equal(done.scans[0].status, "completed", done.scans[0].abort_reason);
  assert.equal(done.lastReport.tombstonedCount, 150);
});

it("運用UI: 解析を始めても走査の失敗表示は消えず、解析の失敗は別に持ち、次の走査の成功で消える（DF-10）", async (t) => {
  const { input, dataDir, api, until, openDatabase } = await setup(t);
  await writeFile(join(input, "資料.docx"), wordSample("DF10"));
  await writeFile(join(input, "壊れた.docx"), "not a zip");
  await writeFile(join(input, "x.txt"), "x-content");
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  const db = openDatabase();
  const versionOf = (key: string) => String(db.prepare("SELECT active_version_id FROM document WHERE stable_key=?").get(key)!.active_version_id);
  const blob = String(db.prepare("SELECT blob_key FROM document_version WHERE version_id=?").get(versionOf("x.txt"))!.blob_key);
  await writeFile(blobPath(join(dataDir, "blobs"), blob as BlobKey), "corrupt");
  await api("scan", { sourceId });
  const failed = await until((s) => !s.busy);
  assert.match(String(failed.lastScanError), /already exists with different content/);

  await api("parse", { versionId: versionOf("壊れた.docx") });
  const parseFailed = await until((s) => !s.busy);
  assert.match(String(parseFailed.lastScanError), /already exists/, "解析の開始で走査の失敗表示が消えた");
  assert.equal(parseFailed.lastParseError.versionId, versionOf("壊れた.docx"));
  assert.match(parseFailed.lastParseError.message, /読み取れません/);

  await api("parse", { versionId: versionOf("資料.docx") });
  const parsed = await until((s) => !s.busy);
  assert.equal(parsed.lastParseError ?? null, null);
  assert.match(String(parsed.lastScanError), /already exists/);

  await api("scan", { sourceId, repair: true, repairConfirmed: true });
  const repaired = await until((s) => !s.busy);
  assert.equal(repaired.lastReport.repairedBlobCount, 1);
  assert.equal(repaired.lastScanError ?? null, null);
});

it("運用UI: バックアップはDBと原本が揃ってから完了印を残す", async (t) => {
  const { input, api, until } = await setup(t);
  await writeFile(join(input, "data.txt"), "backup bytes");
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  const { destination } = await api("backup", {});
  assert.ok(JSON.parse(await readFile(join(destination, "COMPLETE.json"), "utf8")).completedAt);
  const db = new DatabaseSync(join(destination, "lineage.sqlite"), { readOnly: true });
  try {
    const row = db.prepare("SELECT blob_key FROM document_version").get()!;
    const key = String(row.blob_key);
    // 実装からパスを借りずに、内容アドレスの保存構造を検査する。
    const hash = key.replace(/^sha256:/, "");
    const files = await import("node:fs/promises");
    const paths = await files.readdir(join(destination, "blobs"), { recursive: true });
    const found = paths.find((p) => p.endsWith(hash) || p.endsWith(hash.slice(2)));
    assert.ok(found, `backup blob missing: ${key}`);
    assert.equal(await readFile(join(destination, "blobs", found), "utf8"), "backup bytes");
  } finally { db.close(); }
  const restored = await startConsole({ dataDir: destination, port: 0 });
  try {
    const response = await fetch(`${restored.origin}/api/state`, { headers: { Authorization: `Bearer ${restored.token}` } });
    const state: any = await response.json();
    assert.equal(state.counts.active, 1);
    const checked = await fetch(`${restored.origin}/api/audit`, { method: "POST", headers: { Authorization: `Bearer ${restored.token}`, "Content-Type": "application/json" }, body: "{}" });
    const report: any = await checked.json();
    assert.equal(report.report.results.find((r: any) => r.name === "HASH_MATCHES_BLOB").status, "ok");
  } finally { await restored.close(); }
});

it("運用UI: 保存原本の破損は点検で見つかり、確認付き再取得で修復できる", async (t) => {
  const { input, dataDir, api, request, until, openDatabase } = await setup(t);
  await writeFile(join(input, "original.txt"), "original");
  const { sourceId } = await api("sources", { root: input });
  await api("scan", { sourceId }); await until((s) => !s.busy);
  const { readdir } = await import("node:fs/promises");
  const paths = await readdir(join(dataDir, "blobs"), { recursive: true });
  const path = paths.find((p) => /[a-f0-9]{62,64}$/.test(p))!;
  await writeFile(join(dataDir, "blobs", path), "broken");
  const audit = await api("audit", {});
  assert.equal(audit.report.results.find((r: any) => r.name === "HASH_MATCHES_BLOB").status, "violated");
  assert.equal((await request("scan", { sourceId, repair: true })).status, 400);
  await api("scan", { sourceId, repair: true, repairConfirmed: true });
  const result = await until((s) => !s.busy);
  assert.equal(result.lastReport.repairedBlobCount, 1);
  assert.equal(await readFile(join(dataDir, "blobs", path), "utf8"), "original");
});

it("運用UI: 残留走査は停止確認と世代指定を要求し、HTTPの復旧経路で終了できる", async (t) => {
  const { input, dataDir, api, request, until, openDatabase } = await setup(t);
  await writeFile(join(input, "input.txt"), "data");
  const { sourceId } = await api("sources", { root: input });
  const conn = openStore({ clock: systemClock(), location: join(dataDir, "lineage.sqlite"), applySchema: false });
  let scanId: string;
  try { scanId = (await new SqliteLineageStore(conn).beginScan(sourceId, { countRatioThresholdBp: 9000, missingRatioThresholdBp: 1000 })).scanId; }
  finally { conn.close(); }
  const state = await api("state"); assert.equal(state.sources[0].running_id, scanId);
  assert.equal((await request("scan", { sourceId })).status, 400);
  assert.equal((await request("scan", { sourceId, interruptedScanId: scanId, stopped: false, reason: "未確認" })).status, 400);
  await api("scan", { sourceId, interruptedScanId: scanId, stopped: true, reason: "別プロセスの停止を確認" });
  const result = await until((s) => !s.busy);
  assert.equal(result.lastReport.recoveredScanId, scanId); assert.equal(result.lastReport.status, "completed");
});

it("運用UI: HTTPの途中で分割された日本語も元の文字列で登録する", async (t) => {
  const { app, input, api } = await setup(t);
  const payload = Buffer.from(JSON.stringify({ name: "日本語の資料", root: input }));
  const split = payload.indexOf(Buffer.from("日")) + 1;
  const response = new Promise<number>((resolve, reject) => {
    const request = httpRequest(`${app.origin}/api/sources`, { method: "POST", headers: {
      Authorization: `Bearer ${app.token}`, "Content-Type": "application/json", "Content-Length": payload.length,
    } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    request.on("error", reject);
    request.write(payload.subarray(0, split));
    void delay(50).then(() => request.end(payload.subarray(split)));
  });
  assert.equal(await response, 200);
  assert.equal((await api("state")).sources[0].display_name, "日本語の資料");
});
it("⑥ HTTP N-7: 壊れた履歴でも候補を返し、現在の表示と再確認を妨げない", async (t) => {
  const { input, api, request, until, openDatabase } = await setup(t);
  await writeFile(join(input, "文書.docx"), wordSample());
  const { sourceId } = await api("sources", { root: input }); await api("scan", { sourceId }); await until(s => !s.busy);
  const versionId = (await api("documents")).rows[0].active_version_id;
  await api("normalize", { versionId }); await until(s => !s.busy);
  const current = await api(`normalized?versionId=${versionId}`);
  const db = openDatabase();
  // 別の正規の版として履歴を作り、その一件だけを壊す。現在の成果物は変更しない。
  const { normalizationDraft, readNormalizedArtifact } = await import("../pipeline/normalize.ts");
  const { artifactId } = await import("../domain/ids.ts");
  const { dataDir } = await api("state");
  const conn = openStore({ location: join(dataDir, "lineage.sqlite"), clock: systemClock(), applySchema: false });
  let brokenId: string;
  try {
    const store = new SqliteLineageStore(conn), draft = { ...normalizationDraft(current.inputArtifactId), processorVersion: "older-v1-compatible" };
    const workerId = "history-test" as WorkerId;
    const run = await store.claimRun({ ...draft, rootVersionId: versionId, workerId, leaseSeconds: 120 }); assert.ok(run);
    const saved = await store.commitDerivation({ derivation: draft, runId: run.runId, workerId, artifacts: [{ kind: "inline", ordinal: 0, type: "normalized_document", content: JSON.stringify(current.result) }] });
    brokenId = artifactId(saved.derivationKey, 0);
    assert.equal(readNormalizedArtifact(conn, brokenId).status, "ready");
  } finally { conn.close(); }
  db.prepare("UPDATE artifact SET inline_content='broken' WHERE artifact_id=?").run(brokenId);
  const failure = await api(`normalized?versionId=${versionId}&artifactId=${brokenId}`);
  assert.equal(failure.status, "read_error"); assert.match(failure.message, /一致/);
  assert.equal(failure.history.length, 2); assert.equal(failure.canNormalize, true);
  assert.equal((await api(`normalized?versionId=${versionId}`)).status, "ready");
  assert.equal((await api("normalize", { versionId })).status, "ready");
  assert.equal((await request(`normalized?versionId=${versionId}&artifactId=missing`)).status, 400);
  db.prepare("UPDATE artifact SET inline_content='broken-current' WHERE artifact_id=?").run(current.artifactId);
  const failedCurrent = await api(`normalized?versionId=${versionId}`);
  assert.equal(failedCurrent.status, "read_error"); assert.equal(failedCurrent.history.length, 2);
  assert.equal((await request("normalize", { versionId })).status, 400);
});
