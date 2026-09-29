import { it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { readFile, readdir, rm, stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizationScenario } from "../../../test/support/normalization-scenario.ts";
import { runParse, readParsed, readOriginal } from "../../pipeline/parse.ts";
import { FileBlobStore } from "../blob/file-blob-store.ts";
import { checkInvariants } from "../../audit/invariant-checker.ts";
import { runNormalize } from "../../pipeline/normalize.ts";
import { upgradeStage6Database, stage6SchemaStatus } from "./stage6-upgrade.ts";
import { openStore } from "./connection.ts";
import { SqliteLineageStore } from "./lineage-store.ts";
import { excelSample } from "../../../test/support/office-samples.ts";

const schema = readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8");
function oldArtifact(db: DatabaseSync) {
  const ddl = /CREATE TABLE artifact \([\s\S]*?\n\);/.exec(schema)![0].replace("'parsed_document', 'normalized_document',", "'parsed_document',");
  db.exec("BEGIN");
  db.exec(ddl.replace("CREATE TABLE artifact (", "CREATE TABLE old_artifact ("));
  db.exec("INSERT INTO old_artifact SELECT * FROM artifact; DROP TABLE artifact; ALTER TABLE old_artifact RENAME TO artifact; CREATE INDEX idx_artifact_derivation ON artifact(derivation_key); COMMIT");
  assert.equal(stage6SchemaStatus(db), "stage5");
}
function rows(db: DatabaseSync) { return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => [r.name, db.prepare(`SELECT * FROM ${String(r.name)} ORDER BY rowid`).all()]); }

it("⑥ S6-04: 保全DBとblobsを空の別保存先へ復元し、全行・⑤・原本を読み直せる", async (t) => {
  const ctx = await normalizationScenario(t, true), version = await ctx.addVersion();
  const parsed = await runParse(ctx, version), original = await readOriginal(ctx, version);
  oldArtifact(ctx.conn.db); const before = rows(ctx.conn.db); ctx.close();
  const upgraded = await upgradeStage6Database(ctx.root, ctx.clock); assert.ok(upgraded.backup);
  const destination = await mkdtemp(join(tmpdir(), "stage6-restore-"));
  t.after(() => rm(destination, { recursive: true, force: true }));
  assert.deepEqual(await readdir(destination), []);
  await fsPromises.cp(join(upgraded.backup, "lineage.sqlite"), join(destination, "lineage.sqlite"));
  await fsPromises.cp(join(upgraded.backup, "blobs"), join(destination, "blobs"), { recursive: true });
  const conn = openStore({ clock: ctx.clock, location: join(destination, "lineage.sqlite"), applySchema: false });
  const blobs = new FileBlobStore({ root: join(destination, "blobs"), clock: ctx.clock });
  try {
    assert.equal(stage6SchemaStatus(conn.db), "stage5"); assert.deepEqual(rows(conn.db), before);
    assert.deepEqual(readParsed(conn, version), parsed);
    assert.deepEqual(await readOriginal({ conn, blobs }, version), original);
    const report = await checkInvariants({ reader: { all: async sql => conn.db.prepare(sql).all() }, blobs });
    assert.deepEqual(report.results.filter(r => r.status === "violated"), []);
  } finally { conn.close(); }
});
it("⑥ S6-04: 別writerのロック中は移行せず、解放後に全行を保持して再実行できる", async (t) => {
  const ctx = await normalizationScenario(t, true); await ctx.addVersion();
  oldArtifact(ctx.conn.db); const before = rows(ctx.conn.db); ctx.close();
  const writer = new DatabaseSync(join(ctx.root, "lineage.sqlite"));
  try {
    writer.exec("BEGIN IMMEDIATE");
    await assert.rejects(upgradeStage6Database(ctx.root, ctx.clock), /locked|busy/i);
    writer.exec("ROLLBACK");
    assert.equal(stage6SchemaStatus(writer), "stage5"); assert.deepEqual(rows(writer), before);
  } finally { writer.close(); }
  ctx.clock.advance(1);
  const updated = await upgradeStage6Database(ctx.root, ctx.clock); assert.equal(updated.changed, true);
  const db = new DatabaseSync(join(ctx.root, "lineage.sqlite"));
  try { assert.equal(stage6SchemaStatus(db), "current"); assert.deepEqual(rows(db), before); } finally { db.close(); }
});

it("⑥ DB更新 N-06: blobコピー途中の失敗はCOMPLETEを残さず、別の保全先へ再実行できる", async (t) => {
  const ctx = await normalizationScenario(t, true);
  await ctx.addVersion(); await ctx.addVersion("資料.xlsx", excelSample());
  oldArtifact(ctx.conn.db); const before = rows(ctx.conn.db); ctx.close();
  const cp = fsPromises.cp;
  let files = 0;
  // コピー元の欠如ではなく、一つの原本を複製した後、次の原本のコピー前に失敗させる。
  t.mock.method(fsPromises, "cp", async (...[source, destination, options]: Parameters<typeof cp>) => cp(source, destination, {
    ...options,
    filter: async (path) => {
      if ((await stat(path)).isFile() && ++files === 2) throw new Error("injected during blob copy");
      return true;
    },
  }));
  syncBuiltinESMExports();
  try { await assert.rejects(upgradeStage6Database(ctx.root, ctx.clock), /injected during blob copy/); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  const backups = join(ctx.root, "backups"), names = await readdir(backups);
  assert.equal(names.length, 1);
  const partial = join(backups, names[0]!);
  await assert.rejects(stat(join(partial, "COMPLETE.json")), { code: "ENOENT" });
  const entries = await readdir(join(partial, "blobs"), { recursive: true });
  const copied = [];
  for (const entry of entries) if ((await stat(join(partial, "blobs", entry))).isFile()) copied.push(entry);
  assert.equal(copied.length, 1);
  assert.deepEqual(await readFile(join(partial, "blobs", copied[0]!)), await readFile(join(ctx.root, "blobs", copied[0]!)));
  const db = new DatabaseSync(join(ctx.root, "lineage.sqlite"));
  try { assert.equal(stage6SchemaStatus(db), "stage5"); assert.deepEqual(rows(db), before); } finally { db.close(); }
  ctx.clock.advance(1);
  const result = await upgradeStage6Database(ctx.root, ctx.clock);
  assert.ok(result.changed && result.backup && result.backup !== partial);
  assert.ok(await stat(join(result.backup, "COMPLETE.json")));
  const updated = new DatabaseSync(join(ctx.root, "lineage.sqlite"));
  try { assert.equal(stage6SchemaStatus(updated), "current"); assert.deepEqual(rows(updated), before); } finally { updated.close(); }
});

it("⑥ DB更新: 既存全行・原本・⑤を保持し、保全DBは旧CHECKのまま、新DBだけ⑥を保存できる", async (t) => {
  const ctx = await normalizationScenario(t, true), root = await ctx.addVersion();
  assert.equal((await runParse(ctx, root)).status, "ready");
  oldArtifact(ctx.conn.db); const before = rows(ctx.conn.db); ctx.close();
  const result = await upgradeStage6Database(ctx.root, ctx.clock); assert.ok(result.changed && result.backup);
  const backup = new DatabaseSync(join(result.backup, "lineage.sqlite"), { readOnly: true });
  try { assert.equal(stage6SchemaStatus(backup), "stage5"); assert.deepEqual(rows(backup), before); } finally { backup.close(); }
  assert.ok(JSON.parse(await readFile(join(result.backup, "COMPLETE.json"), "utf8")).dataDigest);
  const originalBlob = await readdir(join(ctx.root, "blobs"), { recursive: true });
  assert.deepEqual(await readdir(join(result.backup, "blobs"), { recursive: true }), originalBlob);
  for (const entry of originalBlob) {
    const original = join(ctx.root, "blobs", entry);
    if ((await stat(original)).isFile()) assert.deepEqual(await readFile(join(result.backup, "blobs", entry)), await readFile(original));
  }
  const conn = openStore({ clock: ctx.clock, location: join(ctx.root, "lineage.sqlite"), applySchema: false });
  try {
    assert.deepEqual(rows(conn.db), before);
    assert.equal(stage6SchemaStatus(conn.db), "current");
    assert.equal((await runNormalize({ conn, store: new SqliteLineageStore(conn), blobs: ctx.blobs }, root)).status, "ready");
    assert.equal((await upgradeStage6Database(ctx.root, ctx.clock)).changed, false);
  } finally { conn.close(); }
});
it("⑥ DB更新: DROP後・RENAME前の例外は既存全行と旧スキーマへロールバックする", async (t) => {
  const ctx = await normalizationScenario(t, true), root = await ctx.addVersion();
  await runParse(ctx, root); oldArtifact(ctx.conn.db); const before = rows(ctx.conn.db); ctx.close();
  const exec = DatabaseSync.prototype.exec;
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (sql.startsWith("INSERT INTO artifact_stage6")) {
      exec.call(this, sql.split("; ALTER TABLE")[0]!);
      assert.equal(this.prepare("SELECT name FROM sqlite_master WHERE name='artifact'").get(), undefined);
      assert.ok(this.prepare("SELECT name FROM sqlite_master WHERE name='artifact_stage6'").get());
      throw new Error("injected after DROP before RENAME");
    }
    return exec.call(this, sql);
  });
  await assert.rejects(upgradeStage6Database(ctx.root, ctx.clock), /injected/);
  t.mock.restoreAll();
  const db = new DatabaseSync(join(ctx.root, "lineage.sqlite"));
  try { assert.equal(stage6SchemaStatus(db), "stage5"); assert.deepEqual(rows(db), before); } finally { db.close(); }
});

it("⑥ DB更新: 保全後の別接続の書込みを検出し、旧構造と追加行を含む全行を保持する", async (t) => {
  const ctx = await normalizationScenario(t, true); await ctx.addVersion();
  oldArtifact(ctx.conn.db); ctx.close();
  const exec = DatabaseSync.prototype.exec;
  let afterWrite: ReturnType<typeof rows> | undefined;
  t.mock.method(DatabaseSync.prototype, "exec", function(this: DatabaseSync, sql: string) {
    if (sql === "BEGIN EXCLUSIVE") {
      const other = new DatabaseSync(join(ctx.root, "lineage.sqlite"));
      try {
        other.prepare("INSERT INTO source (source_id,kind,config_hash,display_name,key_unicode_form,key_case_fold,key_path_separator,key_trim_slashes) VALUES ('concurrent','local-fs','cfg','probe','NFC',0,'posix',1)").run();
        afterWrite = rows(other);
      } finally { other.close(); }
    }
    return exec.call(this, sql);
  });
  await assert.rejects(upgradeStage6Database(ctx.root, ctx.clock), /バックアップ中にDBが変わりました/);
  t.mock.restoreAll();
  const db = new DatabaseSync(join(ctx.root, "lineage.sqlite"));
  try { assert.ok(afterWrite); assert.equal(stage6SchemaStatus(db), "stage5"); assert.deepEqual(rows(db), afterWrite); } finally { db.close(); }
});
it("⑥ DB更新: 未知のスキーマは保全前に拒否し、blob保全の失敗もDBを変更しない", async (t) => {
  const ctx = await normalizationScenario(t, true); await ctx.addVersion(); oldArtifact(ctx.conn.db);
  ctx.conn.db.exec("CREATE TABLE surprise (id TEXT)"); ctx.close();
  await assert.rejects(upgradeStage6Database(ctx.root, ctx.clock), /未知/);
  const db = new DatabaseSync(join(ctx.root, "lineage.sqlite")); db.exec("DROP TABLE surprise"); const before = rows(db); db.close();
  await rm(join(ctx.root, "blobs"), { recursive: true });
  await assert.rejects(upgradeStage6Database(ctx.root, ctx.clock), /ENOENT/);
  const after = new DatabaseSync(join(ctx.root, "lineage.sqlite"));
  try { assert.equal(stage6SchemaStatus(after), "stage5"); assert.deepEqual(rows(after), before); } finally { after.close(); }
});
