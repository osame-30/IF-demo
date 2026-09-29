import { it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { normalizationScenario } from "../../test/support/normalization-scenario.ts";
import { excelSample } from "../../test/support/office-samples.ts";
import { runParse } from "./parse.ts";
import { readNormalized, readNormalizedArtifact, runNormalize, normalizationDraft } from "./normalize.ts";
import { readParsedArtifact } from "../store/sqlite/office-artifact.ts";
import { normalizeDocumentV1, NORMALIZER_CONFIG } from "../domain/normalized-document.ts";
import type { NormalizedDocument } from "../domain/normalized-document.ts";
import { artifactId, derivationKey, outputsHash, canonicalConfigHash } from "../domain/ids.ts";
import type { ContentHash, WorkerId } from "../domain/types.ts";
import { checkInvariants } from "../audit/invariant-checker.ts";

const workerId = "normalization-test" as WorkerId;
it("⑥ S6-01: 全本文を一括取得せず最後の成果物まで監査し、途中読取失敗を未検査にする", async (t) => {
  const ctx = await normalizationScenario(t), root = await ctx.addVersion();
  const pd = { processorName: "office-xml", processorVersion: "audit-large", configHash: canonicalConfigHash({ large: true }), inputIds: [root] };
  const pr = await ctx.store.claimRun({ ...pd, rootVersionId: root, workerId, leaseSeconds: 120 }); assert.ok(pr);
  const p = await ctx.store.commitDerivation({ derivation: pd, runId: pr.runId, workerId, artifacts: [{ kind: "inline", ordinal: 0,
    type: "parsed_document", content: JSON.stringify({ schemaVersion: 1, format: "docx", warnings: [], blocks: [
      { kind: "paragraph", location: "本文", style: "", text: "a".repeat(256 * 1024) },
    ] }) }] });
  const parent = readParsedArtifact(ctx.conn, artifactId(p.derivationKey, 0));
  const content = JSON.stringify(normalizeDocumentV1(parent.result)), ids = [];
  for (let i = 0; i < 24; i++) {
    const draft = { ...normalizationDraft(parent.artifactId), processorVersion: `audit-large-${i}` };
    const run = await ctx.store.claimRun({ ...draft, rootVersionId: root, workerId, leaseSeconds: 120 }); assert.ok(run);
    const saved = await ctx.store.commitDerivation({ derivation: draft, runId: run.runId, workerId,
      artifacts: [{ kind: "inline", ordinal: 0, type: "normalized_document", content }] });
    ids.push(artifactId(saved.derivationKey, 0));
  }
  const seen = new Set<string>();
  const reader = { all: async (sql: string) => {
    const rows = ctx.conn.db.prepare(sql).all();
    const bodies = rows.filter(r => typeof r.inline_content === "string");
    assert.ok(bodies.length <= 1, "監査が複数本文を一括取得した");
    for (const row of bodies) seen.add(String(row.artifact_id));
    return rows;
  } };
  const good = await checkInvariants({ reader, blobs: ctx.blobs });
  assert.equal(good.results.find(r => r.name === "LINEAGE_COMPLETE")!.status, "ok");
  assert.equal(good.results.find(r => r.name === "HASH_MATCHES_BLOB")!.status, "ok");
  for (const id of ids) assert.ok(seen.has(id));
  const last = ids.sort().at(-1)!;
  ctx.conn.db.prepare("UPDATE artifact SET inline_content=? WHERE artifact_id=?").run(content.replace('"searchText":', '"wrongSearchText":'), last);
  const bad = await checkInvariants({ reader, blobs: ctx.blobs });
  for (const name of ["LINEAGE_COMPLETE", "HASH_MATCHES_BLOB"]) {
    assert.ok(bad.results.find(r => r.name === name)!.findings.some(f => f.subject === last));
  }
  const interrupted = await checkInvariants({ reader: { all: async sql => {
    if (sql.includes(`artifact_id='${last}'`) && sql.includes("inline_content IS NOT NULL")) throw new Error("injected read failure");
    return reader.all(sql);
  } }, blobs: ctx.blobs });
  assert.equal(interrupted.results.find(r => r.name === "HASH_MATCHES_BLOB")!.status, "not_checked");
});
it("⑥監査 N-01: 自己整合ハッシュと同じ不正値でも入力v1のschema・形式・型を検査する", async (t) => {
  for (const excel of [false, true]) {
    const ctx = await normalizationScenario(t), root = excel ? await ctx.addVersion("資料.xlsx", excelSample()) : await ctx.addVersion();
    const out = await runNormalize(ctx, root); if (out.status !== "ready") assert.fail();
    const parent = ctx.conn.db.prepare("SELECT * FROM artifact WHERE artifact_id=?").get(out.inputArtifactId)!;
    const child = ctx.conn.db.prepare("SELECT * FROM artifact WHERE artifact_id=?").get(out.artifactId)!;
    const parsed = JSON.parse(String(parent.inline_content));
    const mutations = ["schema", "schema-type", "schema-missing", "format", "warnings", ...(excel ? ["dateSystem", "hiddenRow", "hiddenColumn", "valueType", "formulaKind"] : ["blockKind", "style", "columnSpan", "verticalMerge"])];
    for (const change of mutations) {
      const p = structuredClone(parsed), n = structuredClone(out.result);
      if (change === "schema") p.schemaVersion = 2;
      else if (change === "schema-type") p.schemaVersion = "1";
      else if (change === "schema-missing") delete p.schemaVersion;
      else if (change === "format") { p.format = "unknown"; Object.assign(n, { format: "unknown" }); }
      else if (change === "warnings") { p.warnings = [123]; Object.assign(n, { warnings: [123] }); }
      else if (change === "dateSystem") { p.dateSystem = "unknown"; Object.assign(n, { dateSystem: "unknown" }); }
      else if (change === "blockKind") {
        const index = p.blocks.findIndex((b: { kind: string }) => b.kind === "table");
        assert.ok(index >= 0);
        const sheet = { kind: "sheet", name: "偽シート", part: "fake", state: "visible", merges: [], cells: [] };
        Object.assign(p.blocks[index], sheet); Object.assign(n.groups[index]!, sheet, { units: [] });
      }
      else {
        const kind = excel ? "sheet_cell" : change === "style" ? "word_paragraph" : "word_cell";
        const member = n.groups.flatMap(g => g.units.flatMap(u => u.members)).find(m => m.kind === kind)!;
        assert.ok(member);
        const source = excel ? p.sheets.flatMap((s: { cells: unknown[] }) => s.cells)[0] :
          change === "style" ? p.blocks.find((b: { kind: string }) => b.kind === "paragraph") :
          p.blocks.find((b: { kind: string }) => b.kind === "table").rows.flat()[0];
        if (change === "formulaKind") { delete source.formulaKind; Reflect.deleteProperty(member.source, "formulaKind"); }
        else { source[change] = change === "columnSpan" ? 0 : 123; Object.assign(member.source, { [change]: source[change] }); }
      }
      // N-01: 本文のハッシュと出力側の値も合わせ、対応比較だけでは検出できない不正を作る。
      for (const [row, value] of [[parent, p], [child, n]] as const) {
        const content = JSON.stringify(value), hash = createHash("sha256").update(content).digest("hex") as ContentHash;
        const id = String(row.artifact_id) as typeof out.artifactId;
        ctx.conn.db.prepare("UPDATE artifact SET inline_content=?,content_hash=?,size_bytes=? WHERE artifact_id=?").run(content, hash, Buffer.byteLength(content), id);
        ctx.conn.db.prepare("UPDATE derivation SET outputs_hash=? WHERE derivation_key=?").run(outputsHash([{ artifactId: id, ordinal: 0, contentHash: hash }]), row.derivation_key!);
      }
      assert.throws(() => readNormalizedArtifact(ctx.conn, out.artifactId), /./, change);
      const report = await checkInvariants({ reader: { all: async sql => ctx.conn.db.prepare(sql).all() } });
      assert.ok(report.results.find(r => r.name === "LINEAGE_COMPLETE")!.findings.some(f => f.problem === "normalized_input_or_correspondence_invalid"), change);
    }
  }
});
it("⑥: 実解析Word/Excelを保存し、100回の再実行で内容表・runが増えず独立監査も通る", async (t) => {
  const ctx = await normalizationScenario(t);
  for (const version of [await ctx.addVersion(), await ctx.addVersion("資料.xlsx", excelSample())]) {
    const first = await runNormalize(ctx, version); assert.equal(first.status, "ready");
    const snapshot = () => ["document_version", "derivation", "artifact", "processing_run"].map((s) => ctx.conn.db.prepare(`SELECT * FROM ${s} ORDER BY rowid`).all());
    const before = snapshot();
    for (let i = 0; i < 100; i++) assert.deepEqual(await runNormalize(ctx, version), first);
    assert.deepEqual(snapshot(), before);
  }
  const report = await checkInvariants({ reader: { all: async (sql) => ctx.conn.db.prepare(sql).all() }, blobs: ctx.blobs });
  assert.deepEqual(report.results.filter((r) => r.status === "violated"), []);
});
it("⑥: 別原本の入力と偽のschemaVersionはストアへ直接渡しても拒否する", async (t) => {
  const ctx = await normalizationScenario(t), root = await ctx.addVersion(), other = await ctx.addVersion("別.docx");
  const p = await runParse(ctx, root); assert.equal(p.status, "ready"); if (p.status !== "ready") return;
  const parent = readParsedArtifact(ctx.conn, p.artifactId), base = normalizationDraft(parent.artifactId);
  const content = JSON.stringify(normalizeDocumentV1(parent.result));
  for (const [i, target] of [other, root].entries()) {
    const draft = { ...base, processorVersion: `negative-${i}` };
    const run = await ctx.store.claimRun({ ...draft, rootVersionId: target, workerId, leaseSeconds: 120 }); assert.ok(run);
    const before = ctx.conn.db.prepare("SELECT count(*) AS n FROM artifact").get();
    await assert.rejects(ctx.store.commitDerivation({ derivation: draft, runId: run.runId, workerId, artifacts: [{ kind: "inline", ordinal: 0, type: "normalized_document", content: i === 0 ? content : content.replace('"schemaVersion":1', '"schemaVersion":2') }] }), /原本|一致/);
    assert.deepEqual(ctx.conn.db.prepare("SELECT count(*) AS n FROM artifact").get(), before);
  }
});
it("⑥: Parser版上げ後も旧⑥の固定入力を辿り、現在の結果とは混ぜない", async (t) => {
  const ctx = await normalizationScenario(t), root = await ctx.addVersion();
  const oldParsed = { schemaVersion: 1, format: "docx", warnings: [], blocks: [{ kind: "paragraph", location: "旧 / 段落1", style: "", text: "旧Parserの内容" }] };
  const draft = { processorName: "office-xml", processorVersion: "office-xml-old", configHash: canonicalConfigHash({ old: true }), inputIds: [root] };
  const run = await ctx.store.claimRun({ ...draft, rootVersionId: root, workerId, leaseSeconds: 120 }); assert.ok(run);
  const old = await ctx.store.commitDerivation({ derivation: draft, runId: run.runId, workerId, artifacts: [{ kind: "inline", ordinal: 0, type: "parsed_document", content: JSON.stringify(oldParsed) }] });
  const parent = readParsedArtifact(ctx.conn, artifactId(old.derivationKey, 0));
  const n = { ...normalizationDraft(parent.artifactId), processorVersion: "normalize-old-compatible-v1" };
  const nr = await ctx.store.claimRun({ ...n, rootVersionId: root, workerId, leaseSeconds: 120 }); assert.ok(nr);
  const saved = await ctx.store.commitDerivation({ derivation: n, runId: nr.runId, workerId, artifacts: [{ kind: "inline", ordinal: 0, type: "normalized_document", content: JSON.stringify(normalizeDocumentV1(parent.result)) }] });
  const id = artifactId(saved.derivationKey, 0), previous = readNormalizedArtifact(ctx.conn, id);
  const current = await runNormalize(ctx, root); assert.equal(current.status, "ready");
  assert.deepEqual(readNormalizedArtifact(ctx.conn, id), previous);
  if (current.status === "ready") { assert.notEqual(current.inputArtifactId, previous.inputArtifactId); assert.notEqual(current.artifactId, previous.artifactId); }
  assert.notEqual(derivationKey(n), derivationKey(normalizationDraft(parent.artifactId)));
  assert.notEqual(derivationKey(n), derivationKey({ ...n, configHash: canonicalConfigHash({ ...NORMALIZER_CONFIG, future: true }) }));
  const report = await checkInvariants({ reader: { all: async (sql) => ctx.conn.db.prepare(sql).all() }, blobs: ctx.blobs });
  assert.deepEqual(report.results.filter((r) => r.status === "violated"), []);
});
it("⑥: 途中commit失敗は部分確定せず、同じ版を再試行できる", async (t) => {
  const ctx = await normalizationScenario(t), root = await ctx.addVersion();
  ctx.conn.db.exec("CREATE TRIGGER fail_normalized BEFORE INSERT ON artifact WHEN NEW.type='normalized_document' BEGIN SELECT RAISE(ABORT,'injected'); END");
  await assert.rejects(runNormalize(ctx, root), /injected/);
  assert.equal(readNormalized(ctx.conn, root).status, "failed");
  assert.equal(ctx.conn.db.prepare("SELECT count(*) AS n FROM derivation WHERE processor_name='office-normalize'").get()!.n, 0);
  assert.equal(ctx.conn.db.prepare("SELECT count(*) AS n FROM artifact WHERE type='parsed_document'").get()!.n, 1);
  ctx.conn.db.exec("DROP TRIGGER fail_normalized");
  assert.equal((await runNormalize(ctx, root)).status, "ready");
});
it("⑥: 期限切れrunは再取得でき、遅れた旧世代は確定できない", async (t) => {
  const ctx = await normalizationScenario(t), root = await ctx.addVersion();
  const parsed = await runParse(ctx, root); if (parsed.status !== "ready") assert.fail();
  const parent = readParsedArtifact(ctx.conn, parsed.artifactId), draft = normalizationDraft(parent.artifactId);
  const run = await ctx.store.claimRun({ ...draft, rootVersionId: root, workerId, leaseSeconds: 1 }); assert.ok(run);
  assert.equal((await runNormalize(ctx, root)).status, "waiting");
  ctx.clock.advance(1001);
  assert.equal((await runNormalize(ctx, root)).status, "ready");
  await assert.rejects(ctx.store.commitDerivation({ derivation: draft, runId: run.runId, workerId, artifacts: [{ kind: "inline", ordinal: 0, type: "normalized_document", content: JSON.stringify(normalizeDocumentV1(parent.result)) }] }), /live lease/);
});
it("⑥: 本文とハッシュの自己整合を偽装しても入力との対応を表示と独立監査が検出する", async (t) => {
  const ctx = await normalizationScenario(t), root = await ctx.addVersion();
  const out = await runNormalize(ctx, root); if (out.status !== "ready") assert.fail();
  const row = ctx.conn.db.prepare("SELECT * FROM artifact WHERE artifact_id=?").get(out.artifactId)!;
  const content = String(row.inline_content).replace('"searchText":', '"wrongSearchText":');
  const hash = createHash("sha256").update(content).digest("hex") as ContentHash;
  ctx.conn.db.prepare("UPDATE artifact SET inline_content=?,content_hash=?,size_bytes=? WHERE artifact_id=?").run(content, hash, Buffer.byteLength(content), out.artifactId);
  ctx.conn.db.prepare("UPDATE derivation SET outputs_hash=? WHERE derivation_key=?").run(outputsHash([{ artifactId: out.artifactId, ordinal: 0, contentHash: hash }]), row.derivation_key!);
  assert.throws(() => readNormalizedArtifact(ctx.conn, out.artifactId), /一致/);
  const report = await checkInvariants({ reader: { all: async (sql) => ctx.conn.db.prepare(sql).all() } });
  assert.ok(report.results.find((r) => r.name === "LINEAGE_COMPLETE")!.findings.some((f) => f.problem === "normalized_input_or_correspondence_invalid"));
});
it("⑥監査 N-1: 順序非依存の比較でも値・キー・型・配列順の改変は拒否する", async (t) => {
  const ctx = await normalizationScenario(t), root = await ctx.addVersion("資料.xlsx", excelSample());
  const out = await runNormalize(ctx, root); if (out.status !== "ready") assert.fail();
  const row = ctx.conn.db.prepare("SELECT * FROM artifact WHERE artifact_id=?").get(out.artifactId)!;
  // S6-03: 入力Excelのキー順だけを変えても、固定v1読取と独立監査が同じ値として受理する。
  const parent = ctx.conn.db.prepare("SELECT * FROM artifact WHERE artifact_id=?").get(out.inputArtifactId)!;
  const reorder = (value: unknown): unknown => Array.isArray(value) ? value.map(reorder) :
    value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)])) : value;
  const reordered = JSON.stringify(reorder(JSON.parse(String(parent.inline_content))));
  assert.notEqual(reordered, parent.inline_content);
  const parentHash = createHash("sha256").update(reordered).digest("hex") as ContentHash;
  ctx.conn.db.prepare("UPDATE artifact SET inline_content=?,content_hash=?,size_bytes=? WHERE artifact_id=?").run(reordered, parentHash, Buffer.byteLength(reordered), out.inputArtifactId);
  ctx.conn.db.prepare("UPDATE derivation SET outputs_hash=? WHERE derivation_key=?").run(outputsHash([{ artifactId: out.inputArtifactId, ordinal: 0, contentHash: parentHash }]), parent.derivation_key!);
  assert.deepEqual(readNormalizedArtifact(ctx.conn, out.artifactId).result, out.result);
  const reorderedAudit = await checkInvariants({ reader: { all: async sql => ctx.conn.db.prepare(sql).all() }, blobs: ctx.blobs });
  assert.deepEqual(reorderedAudit.results.filter(r => r.status === "violated"), []);
  const mutations: Array<(value: NormalizedDocument) => void> = [
    (v) => { const m = v.groups[0]!.units[0]!.members[0]!; if (m.kind === "sheet_cell") m.source.value = "偽"; },
    (v) => { Reflect.deleteProperty(v.groups[0]!.units[0]!.members[0]!.source, "value"); },
    (v) => { Object.assign(v.groups[0]!.units[0]!.members[0]!.source, { extra: "偽" }); },
    (v) => { Object.assign(v.groups[0]!.units[0]!.members[0]!.source, { row: "1" }); },
    (v) => { v.groups.reverse(); },
    (v) => { v.groups[0]!.units[0]!.members[0]!.searchText = "偽"; },
    (v) => { for (const g of v.groups) for (const u of g.units) for (const m of u.members) if (m.kind === "sheet_cell" && m.source.value === null) m.source.value = ""; },
    (v) => { for (const g of v.groups) for (const u of g.units) for (const m of u.members) Reflect.deleteProperty(m.source, "hiddenColumn"); },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(out.result); mutate(value);
    const content = JSON.stringify(value), hash = createHash("sha256").update(content).digest("hex") as ContentHash;
    assert.notEqual(content, row.inline_content);
    ctx.conn.db.prepare("UPDATE artifact SET inline_content=?,content_hash=?,size_bytes=? WHERE artifact_id=?").run(content, hash, Buffer.byteLength(content), out.artifactId);
    ctx.conn.db.prepare("UPDATE derivation SET outputs_hash=? WHERE derivation_key=?").run(outputsHash([{ artifactId: out.artifactId, ordinal: 0, contentHash: hash }]), row.derivation_key!);
    assert.throws(() => readNormalizedArtifact(ctx.conn, out.artifactId), /一致/);
    const report = await checkInvariants({ reader: { all: async (sql) => ctx.conn.db.prepare(sql).all() } });
    assert.ok(report.results.find((r) => r.name === "LINEAGE_COMPLETE")!.findings.some((f) => f.problem === "normalized_input_or_correspondence_invalid"));
  }
});
it("⑥ N-4: 別設定を拒否し、同じv1契約の別processorVersionは本文照合して確定する", async (t) => {
  const ctx = await normalizationScenario(t), root = await ctx.addVersion();
  const parsed = await runParse(ctx, root); if (parsed.status !== "ready") assert.fail();
  const parent = readParsedArtifact(ctx.conn, parsed.artifactId);
  for (const changeConfig of [false, true]) {
    const draft = { ...normalizationDraft(parent.artifactId), processorVersion: "v1-compatible", ...(changeConfig ? { configHash: canonicalConfigHash({ future: true }) } : {}) };
    const run = await ctx.store.claimRun({ ...draft, rootVersionId: root, workerId, leaseSeconds: 120 }); assert.ok(run);
    const commit = ctx.store.commitDerivation({ derivation: draft, runId: run.runId, workerId, artifacts: [{ kind: "inline", ordinal: 0, type: "normalized_document", content: JSON.stringify(normalizeDocumentV1(parent.result)) }] });
    if (changeConfig) await assert.rejects(commit, /対応する設定/);
    else { const saved = await commit; assert.equal(readNormalizedArtifact(ctx.conn, artifactId(saved.derivationKey, 0)).status, "ready"); }
  }
});
it("⑥ N-2: 0ae4fecのWord/Excel保存バイト列を同じ鍵で読み、成功済みの再claimは起きない", async (t) => {
  const { legacyNormalizedFixtures } = await import("../../test/support/normalization-scenario.ts");
  const ctx = await normalizationScenario(t), root = await ctx.addVersion();
  // 可変の⑤デコーダーを壊した別モジュール一式でも、旧⑥の読取はv1だけに依存する。
  const copy = await mkdtemp(join(tmpdir(), "normalize-contract-"));
  t.after(() => rm(copy, { recursive: true, force: true }));
  await cp(new URL("../../src", import.meta.url), join(copy, "src"), { recursive: true });
  await cp(new URL("../../schema.sql", import.meta.url), join(copy, "schema.sql"));
  await writeFile(join(copy, "package.json"), '{"type":"module"}');
  const decoderPath = join(copy, "src/domain/parsed-document.ts");
  const decoder = await readFile(decoderPath, "utf8");
  assert.ok(decoder.includes("return parseDocumentResultV1(value);"));
  await writeFile(decoderPath, decoder.replace("return parseDocumentResultV1(value);", 'throw new Error("changed current decoder");'));
  const changed = await import(pathToFileURL(decoderPath).href);
  assert.throws(() => changed.parseDocumentResult({}), /changed current decoder/);
  const changedReader = await import(pathToFileURL(join(copy, "src/pipeline/normalize.ts")).href);
  for (const [i, fixture] of legacyNormalizedFixtures.entries()) {
    const pd = { processorName: "office-xml", processorVersion: `legacy-${i}`, configHash: canonicalConfigHash({ legacy: true }), inputIds: [root] };
    const pr = await ctx.store.claimRun({ ...pd, rootVersionId: root, workerId, leaseSeconds: 120 }); assert.ok(pr);
    const p = await ctx.store.commitDerivation({ derivation: pd, runId: pr.runId, workerId, artifacts: [{ kind: "inline", ordinal: 0, type: "parsed_document", content: fixture.input }] });
    const parent = readParsedArtifact(ctx.conn, artifactId(p.derivationKey, 0));
    assert.equal(JSON.stringify(normalizeDocumentV1(parent.result)), fixture.output);
    const nd = normalizationDraft(parent.artifactId);
    const nr = await ctx.store.claimRun({ ...nd, rootVersionId: root, workerId, leaseSeconds: 120 }); assert.ok(nr);
    const args = { derivation: nd, runId: nr.runId, workerId, artifacts: [{ kind: "inline" as const, ordinal: 0, type: "normalized_document" as const, content: fixture.output }] };
    const n = await ctx.store.commitDerivation(args);
    const id = artifactId(n.derivationKey, 0), before = ctx.conn.db.prepare("SELECT * FROM artifact ORDER BY rowid").all();
    assert.equal(JSON.stringify(readNormalizedArtifact(ctx.conn, id).result), fixture.output);
    assert.equal(JSON.stringify(changedReader.readNormalizedArtifact(ctx.conn, id).result), fixture.output);
    assert.equal(await ctx.store.claimRun({ ...nd, rootVersionId: root, workerId, leaseSeconds: 120 }), null);
    assert.deepEqual(ctx.conn.db.prepare("SELECT * FROM artifact ORDER BY rowid").all(), before);
  }
  const report = await checkInvariants({ reader: { all: async (sql) => ctx.conn.db.prepare(sql).all() }, blobs: ctx.blobs });
  assert.deepEqual(report.results.filter(r => r.status === "violated"), []);
});
