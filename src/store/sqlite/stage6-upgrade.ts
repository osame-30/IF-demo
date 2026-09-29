/** 75456b4のDBに⑥の型だけを追加する。未知の履歴へ推測でDDLを適用しない。 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { mkdir, cp, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock } from "../../domain/clock.ts";
import { systemClock } from "../../runtime/system-clock.ts";

const schema = readFileSync(new URL("../../../schema.sql", import.meta.url), "utf8");
const operator = "CREATE TABLE operator_source (source_id TEXT PRIMARY KEY REFERENCES source(source_id), root TEXT NOT NULL UNIQUE)";
const compact = (s: string) => s.replace(/--[^\r\n]*/g, "").replace(/"([a-z_]+)"/g, "$1").replace(/\s+/g, " ").trim();
function structure(db: DatabaseSync): string {
  return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
    .map((r) => ({ ...r, sql: compact(String(r.sql)) })));
}
function expected(ddl: string, withOperator: boolean): string {
  const db = new DatabaseSync(":memory:");
  try { db.exec(ddl); if (withOperator) db.exec(operator); return structure(db); } finally { db.close(); }
}
const current = [expected(schema, false), expected(schema, true)];
// 75456b4の構造を固定する。今後schema.sqlが変わっても移行元を勝手に広げない。
const old = ["137909a4af271eb987263040bf8aa03e253bb90af5d78fa8d3617e704db6a598", "3c2173c3ab74133ee4f70f72720a99da7fd3385e5cb11f9e2b35dd5da9524a56"];
export function stage6SchemaStatus(db: DatabaseSync): "current" | "stage5" | "unsupported" {
  const s = structure(db);
  return current.includes(s) ? "current" : old.includes(createHash("sha256").update(s).digest("hex")) ? "stage5" : "unsupported";
}

// 件数ではなく全列の値を読む。観測・削除済み原本・過去の成果物も比較対象から外さない。
function dataDigest(db: DatabaseSync): string {
  const hash = createHash("sha256");
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  for (const table of tables) {
    const name = String(table.name); hash.update(JSON.stringify(name));
    for (const row of db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).iterate()) hash.update(JSON.stringify(row));
  }
  return hash.digest("hex");
}
function healthy(db: DatabaseSync): void {
  const integrity = db.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok" || db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("DBの整合性が不正です。更新せず復旧を判断してください");
}

export async function upgradeStage6Database(dataDir: string, clock: Clock): Promise<{ changed: boolean; backup?: string }> {
  const path = join(resolve(dataDir), "lineage.sqlite");
  await stat(path); // パス違いで空DBを生成しない。
  const db = new DatabaseSync(path);
  let transaction = false;
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL");
    const status = stage6SchemaStatus(db);
    if (status === "current") return { changed: false };
    if (status !== "stage5") throw new Error("この更新は75456b4の⑤スキーマ専用です。未知のDBは変更しません");
    healthy(db);
    const backup = join(resolve(dataDir), "backups", `before-stage6-${clock.now()}`);
    await mkdir(backup, { recursive: true });
    const backupDb = join(backup, "lineage.sqlite");
    db.prepare("VACUUM INTO ?").run(backupDb);
    await cp(join(resolve(dataDir), "blobs"), join(backup, "blobs"), { recursive: true, errorOnExist: true, force: false });
    const saved = new DatabaseSync(backupDb, { readOnly: true });
    let before: string;
    try { healthy(saved); before = dataDigest(saved); } finally { saved.close(); }
    await writeFile(join(backup, "COMPLETE.json"), JSON.stringify({ completedAt: clock.now(), source: path, stage: 5, dataDigest: before, database: "lineage.sqlite", blobs: "blobs" }));
    // コピー後の書込競合は、排他区間に入ってから全行を比較して反証する。
    db.exec("BEGIN EXCLUSIVE"); transaction = true;
    if (stage6SchemaStatus(db) !== "stage5" || dataDigest(db) !== before) throw new Error("バックアップ中にDBが変わりました。他のアプリを終了して再実行してください");
    const ddl = /CREATE TABLE artifact \([\s\S]*?\n\);/.exec(schema)?.[0];
    if (!ddl) throw new Error("⑥のDDLが見つかりません");
    db.exec(ddl.replace("CREATE TABLE artifact (", "CREATE TABLE artifact_stage6 ("));
    db.exec("INSERT INTO artifact_stage6 SELECT * FROM artifact ORDER BY rowid; DROP TABLE artifact; ALTER TABLE artifact_stage6 RENAME TO artifact; CREATE INDEX idx_artifact_derivation ON artifact(derivation_key)");
    if (stage6SchemaStatus(db) !== "current" || dataDigest(db) !== before) throw new Error("移行後の構造または既存行が一致しません");
    healthy(db);
    db.exec("COMMIT"); transaction = false;
    return { changed: true, backup };
  } catch (error) {
    if (transaction) {
      try { db.exec("ROLLBACK"); } catch (rollback) { throw new AggregateError([error, rollback], "更新とロールバックに失敗しました。保全DBを確認してください"); }
    }
    throw error;
  } finally { db.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--data-dir"), dir = at >= 0 ? process.argv[at + 1] : undefined;
  if (!dir || !process.argv.includes("--app-stopped")) throw new Error("アプリと他の書込処理を終了し、--data-dir 保存先 --app-stopped を指定してください");
  console.log(await upgradeStage6Database(dir, systemClock()));
}
