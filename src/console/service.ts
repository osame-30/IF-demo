/** 運用判断はここで既存の走査へ渡す。UI から SQL や削除の能力を受け取らない。 */
import { mkdir, realpath, stat, cp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { systemClock } from "../runtime/system-clock.ts";
import { openStore } from "../store/sqlite/connection.ts";
import { SqliteLineageStore } from "../store/sqlite/lineage-store.ts";
import { FileBlobStore } from "../store/blob/file-blob-store.ts";
import { LocalFolderSourceAdapter, isOfficeTemporaryName } from "../source/local-fs/local-folder-adapter.ts";
import { canonicalConfigHash } from "../domain/ids.ts";
import type { ScanId, SourceId, SourceDescriptor, VersionId } from "../domain/types.ts";
import { readParsed, readOriginal, runParse } from "../pipeline/parse.ts";
import { readNormalized, readNormalizedArtifact, runNormalize } from "../pipeline/normalize.ts";
import { runScan } from "../pipeline/scan.ts";
import type { ScanSafetyReview, ScanReport } from "../pipeline/scan.ts";
import { checkInvariants } from "../audit/invariant-checker.ts";
import type { InvariantReport } from "../audit/invariant-checker.ts";

type Row = Record<string, unknown>;
type Decision = { note: string; maxMissingCount: number } | undefined;
const THRESHOLDS = { countRatioThresholdBp: 9000, missingRatioThresholdBp: 1000 };

/**
 * 件数比・欠損率の弁が鳴る値か。式は finishScan と同じ交差積。
 *
 * 運用画面の承認は比率の弁を免除する（lineage-store の excusable）。鳴る値のまま一押しで
 * 反映させると、フォルダの一時的な欠落が大量の墓標になる（攻撃レビュー DF-2、実測）。
 */
export function ratioValveWouldFire(review: Pick<ScanSafetyReview, "previousDistinctCount" | "distinctCount" | "missingCount">): boolean {
  return ratioValveReasons(review).length > 0;
}

function ratioValveReasons(review: Pick<ScanSafetyReview, "previousDistinctCount" | "distinctCount" | "missingCount">): string[] {
  const reasons: string[] = [];
  if (review.previousDistinctCount > 0) {
    if (review.distinctCount * 10000 < review.previousDistinctCount * THRESHOLDS.countRatioThresholdBp) reasons.push("count_ratio");
    if (review.missingCount * 10000 > review.previousDistinctCount * THRESHOLDS.missingRatioThresholdBp) reasons.push("missing_ratio");
  }
  return reasons;
}

export function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) throw new Error(`${label}を入力してください`);
  return value.trim();
}

function overlaps(a: string, b: string): boolean {
  const within = (x: string, y: string) => {
    const path = relative(x, y);
    return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
  };
  return within(a, b) || within(b, a);
}

export async function createConsoleService(dataDirectory: string) {
  await mkdir(dataDirectory, { recursive: true });
  const dataDir = await realpath(dataDirectory);
  const database = join(dataDir, "lineage.sqlite");
  const clock = systemClock();
  const conn = openStore({ clock, location: database, applySchema: !existsSync(database) });
  // 旧スキーマへ勝手に承認上限を補完しない。運用の登録先だけを追加する。
  try {
    conn.db.prepare("SELECT approved_max_missing_count, deletion_state FROM scan_run LIMIT 0").all();
    conn.db.exec("CREATE TABLE IF NOT EXISTS operator_source (source_id TEXT PRIMARY KEY REFERENCES source(source_id), root TEXT NOT NULL UNIQUE)");
  } catch (error) { conn.close(); throw error; }
  const store = new SqliteLineageStore(conn);
  const blobRoot = join(dataDir, "blobs");
  await mkdir(blobRoot, { recursive: true });
  await mkdir(join(dataDir, "backups"), { recursive: true });
  const blobs = new FileBlobStore({ root: blobRoot, clock });
  let busy = false;
  let closing = false;
  let task: Promise<void> | undefined;
  let pending: { review: ScanSafetyReview; summary: ReturnType<typeof summarizeMissing>; decide: (value: Decision) => void } | undefined;
  let progress: { sourceId: string; versionId?: string; phase: string; seen: number; startedAt: number } | undefined;
  let lastReport: ScanReport | undefined;
  let lastScanError: string | undefined;
  let lastParseError: { versionId: string; message: string } | undefined;
  let lastNormalizeError: { versionId: string; message: string } | undefined;
  let audit: { checkedAt: number; report: InvariantReport } | undefined;

  const idle = () => { if (closing) throw new Error("終了処理中です"); if (busy) throw new Error("処理中です。完了または承認待ちの判断を先に行ってください"); };
  const all = (sql: string, ...args: string[]) => conn.db.prepare(sql).all(...args);
  const source = (id: string) => {
    const row = conn.db.prepare("SELECT s.*, o.root FROM source s LEFT JOIN operator_source o USING(source_id) WHERE s.source_id=?").get(id);
    if (!row) throw new Error("接続フォルダが見つかりません");
    return row;
  };
  const missing = (scanId: string, offset = 0) => all(
    `SELECT d.document_id, d.stable_key, d.last_seen_at, v.size_bytes FROM document d
     LEFT JOIN document_version v ON v.version_id=d.active_version_id
     WHERE d.source_id=(SELECT source_id FROM scan_run WHERE scan_id=?)
     AND d.state='active' AND d.last_seen_scan_id<>? ORDER BY d.stable_key LIMIT 100 OFFSET ${offset}`, scanId, scanId)
    .map((row) => ({ ...row, temporaryName: isOfficeTemporaryName(String(row.stable_key).split("/").at(-1)!) }));
  function summarizeMissing(review: ScanSafetyReview) {
    // DF-1/3/4: 件数は全候補の値。ページ長ではない。承認待ち中は書込を止め、要約は記録用に残す。
    const hash = createHash("sha256");
    let hashHasId = false;
    const folders = new Map<string, number>();
    let otherFolderCount = 0;
    for (const row of conn.db.prepare(`SELECT document_id,stable_key FROM document
      WHERE source_id=(SELECT source_id FROM scan_run WHERE scan_id=?) AND state='active' AND last_seen_scan_id<>?
      ORDER BY document_id`).iterate(review.scanId, review.scanId)) {
      if (hashHasId) hash.update("\n");
      hash.update(String(row.document_id)); hashHasId = true;
      const key = String(row.stable_key), folder = key.includes("/") ? key.split("/")[0]! : "";
      if (folders.has(folder) || folders.size < 100) folders.set(folder, (folders.get(folder) ?? 0) + 1);
      else otherFolderCount++;
    }
    const reasons = ratioValveReasons(review);
    // 改名を推測せず、同じ走査で起きた発見だけを参考表示する。承認候補の数・要約には混ぜない。
    const discovered = {
      total: conn.db.prepare("SELECT count(*) AS n FROM observation WHERE scan_id=? AND kind='document_discovered'").get(review.scanId)!.n,
      rows: all(`SELECT d.document_id, d.stable_key FROM observation o JOIN document d USING(document_id)
        WHERE o.scan_id=? AND o.kind='document_discovered' ORDER BY d.stable_key, o.observation_seq LIMIT 20`, review.scanId),
    };
    return { reasons, candidateHash: hash.digest("hex"), folders: [...folders].map(([folder, count]) => ({ folder, count })).sort((a, b) => b.count - a.count || (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0)), otherFolderCount, discovered };
  }

  return {
    dataDir,
    async register(input: Row) {
      idle();
      const raw = requiredText(input.root, "フォルダの絶対パス");
      if (!isAbsolute(raw)) throw new Error("絶対パスを指定してください");
      const root = await realpath(raw);
      if (!(await stat(root)).isDirectory()) throw new Error("フォルダを指定してください");
      if (overlaps(dataDir, root)) throw new Error("保存先と接続フォルダを重ねられません。自己取り込みを防ぐため別の場所を選んでください");
      // フォルダを受け取る口は1つ。ID・設定ハッシュ・名前のポリシーはここから導出する。
      const configHash = canonicalConfigHash({ root });
      const id = createHash("sha256").update(`operator-local:${configHash}`).digest("hex") as SourceId;
      const name = typeof input.name === "string" && input.name.trim() ? requiredText(input.name, "表示名") : basename(root);
      conn.transaction(() => {
        conn.db.prepare(`INSERT INTO source(source_id,kind,config_hash,display_name,key_unicode_form,key_case_fold,key_path_separator,key_trim_slashes)
          VALUES (?,'local-fs',?,?,'NFC',0,'posix',1) ON CONFLICT(source_id) DO NOTHING`).run(id, configHash, name);
        conn.db.prepare("INSERT INTO operator_source(source_id,root) VALUES (?,?) ON CONFLICT(source_id) DO NOTHING").run(id, root);
      });
      return { sourceId: id };
    },
    state() {
      return conn.read(() => ({
        dataDir, busy, progress, lastScanError, lastParseError, lastNormalizeError, lastReport, audit,
        pending: pending ? { ...pending.review, ...pending.summary, ratioValveWouldFire: ratioValveWouldFire(pending.review), candidates: missing(pending.review.scanId) } : null,
        counts: conn.db.prepare(`SELECT (SELECT count(*) FROM source) AS sources,
          (SELECT count(*) FROM document WHERE state='active') AS active,
          (SELECT count(*) FROM document_version) AS versions,
          (SELECT count(*) FROM document WHERE state='tombstoned') AS tombstoned`).get(),
        sources: all(`SELECT s.*, o.root,
          (SELECT count(*) FROM document d WHERE d.source_id=s.source_id AND d.state='active') AS active_count,
          (SELECT status FROM scan_run r WHERE r.source_id=s.source_id ORDER BY start_seq DESC LIMIT 1) AS latest_status,
          (SELECT abort_reason FROM scan_run r WHERE r.source_id=s.source_id ORDER BY start_seq DESC LIMIT 1) AS latest_abort_reason,
          (SELECT approved_max_missing_count FROM scan_run r WHERE r.source_id=s.source_id ORDER BY start_seq DESC LIMIT 1) AS latest_approved_max_missing_count,
          (SELECT scan_id FROM scan_run r WHERE r.source_id=s.source_id AND status='running') AS running_id
          FROM source s LEFT JOIN operator_source o USING(source_id) ORDER BY display_name`),
        scans: all(`SELECT r.*, s.display_name FROM scan_run r JOIN source s USING(source_id)
          ORDER BY r.started_at DESC, r.start_seq DESC LIMIT 50`),
      }));
    },
    documents(query: string, offset: number, includeDeleted = false) {
      const term = `%${query.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
      const visible = includeDeleted ? "1=1" : "d.state<>'tombstoned'";
      return conn.read(() => ({ rows: conn.db.prepare(`SELECT d.*,s.display_name,v.size_bytes,v.content_hash FROM document d
        JOIN source s USING(source_id) LEFT JOIN document_version v ON v.version_id=d.active_version_id
        WHERE d.stable_key LIKE ? ESCAPE '!' AND ${visible} ORDER BY d.stable_key LIMIT 50 OFFSET ?`).all(term, offset),
        total: conn.db.prepare(`SELECT count(*) AS n FROM document d WHERE d.stable_key LIKE ? ESCAPE '!' AND ${visible}`).get(term)?.n,
        hiddenDeleted: includeDeleted ? 0 : conn.db.prepare("SELECT count(*) AS n FROM document WHERE stable_key LIKE ? ESCAPE '!' AND state='tombstoned'").get(term)?.n }));
    },
    document(id: string) {
      return conn.read(() => {
        const row = conn.db.prepare("SELECT * FROM document WHERE document_id=?").get(id);
        if (!row) throw new Error("文書が見つかりません");
        // S5-76: 古い版への復帰でも現行版を候補から落とさず、同じ読取時点のポインタと対応させる。
        return { document: row,
          versionCount: conn.db.prepare("SELECT count(*) AS n FROM document_version WHERE document_id=?").get(id)?.n,
          versions: conn.db.prepare(`SELECT * FROM document_version WHERE document_id=?
            ORDER BY CASE WHEN version_id=? THEN 0 ELSE 1 END, ingested_at DESC, version_id DESC LIMIT 100`).all(id, row.active_version_id ?? null),
          observations: all("SELECT * FROM observation WHERE document_id=? ORDER BY observation_seq DESC LIMIT 100", id) };
      });
    },
    content(versionId: string) { return readParsed(conn, requiredText(versionId, "原本の版") as VersionId); },
    normalized(versionId: string, artifactId?: string) {
      return conn.read(() => {
        const id = requiredText(versionId, "原本の版") as VersionId;
        if (!conn.db.prepare("SELECT 1 FROM document_version WHERE version_id=?").get(id)) throw new Error("保存された版が見つかりません");
        // N-7: 別原本の指定は拒否したまま、同じ原本の壊れた履歴だけを表示エラーにする。
        if (artifactId && !conn.db.prepare("SELECT 1 FROM artifact WHERE artifact_id=? AND root_version_id=? AND type='normalized_document'").get(artifactId, id)) throw new Error("選択した原本と⑥の版が一致しません");
        const history = all(`SELECT a.artifact_id,d.processor_version,a.created_at FROM artifact a JOIN derivation d USING(derivation_key)
          WHERE a.root_version_id=? AND a.type='normalized_document' ORDER BY a.created_at DESC,a.artifact_id LIMIT 100`, id);
        const schema = conn.db.prepare("SELECT sql FROM sqlite_master WHERE name='artifact' AND type='table'").get();
        const metadata = { history, canNormalize: String(schema?.sql).includes("'normalized_document'") };
        try {
          const value = artifactId ? readNormalizedArtifact(conn, artifactId) : readNormalized(conn, id);
          if (value.versionId !== id) throw new Error("選択した原本と⑥の版が一致しません");
          return { ...value, ...metadata };
        } catch (error) {
          return { status: "read_error" as const, versionId: id, message: error instanceof Error ? error.message : "⑥の読取に失敗しました", ...metadata };
        }
      });
    },
    async normalize(input: Row) {
      idle();
      const id = requiredText(input.versionId, "原本の版") as VersionId;
      const schema = conn.db.prepare("SELECT sql FROM sqlite_master WHERE name='artifact' AND type='table'").get();
      if (!String(schema?.sql).includes("'normalized_document'")) throw new Error("⑥には保存DBの更新が必要です。アプリを終了して⑥の更新手順を実行してください。⑤は引き続き利用できます。");
      const existing = readNormalized(conn, id);
      if (existing.status === "ready" || existing.status === "unsupported") return existing;
      busy = true; lastNormalizeError = undefined; audit = undefined;
      progress = { sourceId: "", versionId: id, phase: "normalizing", seen: 0, startedAt: clock.now() };
      task = runNormalize({ conn, store, blobs }, id).then(() => undefined, (error: unknown) => {
        lastNormalizeError = { versionId: id, message: error instanceof Error ? error.message : String(error) };
      }).finally(() => { busy = false; progress = undefined; });
      return { started: true };
    },
    original(versionId: string, signal?: AbortSignal) { return readOriginal({ conn, blobs }, requiredText(versionId, "原本の版") as VersionId, signal); },
    async parse(input: Row) {
      idle();
      const id = requiredText(input.versionId, "原本の版") as VersionId;
      // 完了済みは全成果物を照合して返す。解析はバックグラウンドで行いUIの応答を保つ。
      const existing = readParsed(conn, id);
      if (existing.status === "ready" || existing.status === "unsupported") return existing;
      busy = true; lastParseError = undefined; audit = undefined;
      progress = { sourceId: "", versionId: id, phase: "parsing", seen: 0, startedAt: clock.now() };
      task = runParse({ conn, store, blobs }, id).then(() => undefined, (error: unknown) => {
        lastParseError = { versionId: id, message: error instanceof Error ? error.message : String(error) };
      }).finally(() => { busy = false; progress = undefined; });
      return { started: true };
    },
    observations(scanId: string) { return all("SELECT o.*, d.stable_key FROM observation o LEFT JOIN document d USING(document_id) WHERE o.scan_id=? ORDER BY observation_seq DESC LIMIT 100", scanId); },
    skippedSummary(scanId: string) {
      // DF-8: 直近100観測から押し出されても、走査全体の種類別件数は再起動後も見える。
      const counts = new Map<string, number>();
      for (const row of conn.db.prepare("SELECT detail FROM observation WHERE scan_id=? AND kind='entry_skipped'").iterate(scanId)) {
        const detail: unknown = JSON.parse(String(row.detail));
        const kind = typeof detail === "object" && detail !== null && "kind" in detail ? String(detail.kind) : "unknown";
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
      return [...counts].map(([kind, count]) => ({ kind, count }));
    },
    candidates(scanId: string, offset: number) {
      if (pending?.review.scanId !== scanId) throw new Error("この承認待ちは終了しています");
      return { rows: missing(scanId, offset), total: pending.review.missingCount, folders: pending.summary.folders };
    },
    async start(input: Row) {
      idle();
      const id = requiredText(input.sourceId, "接続先");
      const row = source(id);
      if (typeof row.root !== "string") throw new Error("この接続先にはフォルダの登録がありません");
      const running = await store.findRunningScan(id as SourceId);
      let interrupted: { scanId: ScanId; reason: string } | undefined;
      if (running) {
        if (input.interruptedScanId !== running.scanId || input.stopped !== true) throw new Error("中断した走査のプロセス停止を確認し、対象を指定してください");
        interrupted = { scanId: running.scanId, reason: requiredText(input.reason, "復旧理由") };
      } else if (input.interruptedScanId) throw new Error("その走査は既に終了しています。画面を更新してください");
      if (input.repair === true && input.repairConfirmed !== true) throw new Error("原本の再取得による修復を確認してください");
      const descriptor: SourceDescriptor = { sourceId: id as SourceId, kind: String(row.kind), configHash: String(row.config_hash),
        displayName: String(row.display_name), keyNormalization: { unicodeForm: "NFC", caseFold: false, pathSeparator: "posix", trimSlashes: true } };
      const adapter = new LocalFolderSourceAdapter({ root: row.root, descriptor });
      busy = true; lastScanError = undefined; lastReport = undefined; audit = undefined;
      progress = { sourceId: id, phase: "scanning", seen: 0, startedAt: clock.now() };
      task = runScan({ store, blobs, pipelineVersion: "v0.2", fallbackMimeType: "application/octet-stream",
        adapter: { descriptor, fetch: (key) => adapter.fetch(key), async *enumerate() {
          for await (const item of adapter.enumerate()) { if (progress) progress.seen++; yield item; }
        } } }, THRESHOLDS, {
        ...(interrupted ? { interruptedScan: interrupted } : {}), repairCorruptBlobs: input.repair === true,
        reviewSafety: async (review) => {
          // DF-15関連: 終了要求が列挙中に届いても、後から承認待ちを作って終了を塞がない。
          if (closing) return { note: "運用画面の終了により削除を見送り", maxMissingCount: 0 };
          // 通常の少量削除も見せる。見送りは上限0を使い、比率内の削除も進めない。
          if (!review.missingCount || review.writeFailureCount || review.unlistableSubtreeCount) return undefined;
          if (progress) progress.phase = "review";
          return new Promise<Decision>((decide) => { pending = { review, summary: summarizeMissing(review), decide }; });
        },
      }).then((report) => { lastReport = report; }, (error: unknown) => {
        lastScanError = error instanceof Error ? error.message : String(error);
      }).finally(() => { busy = false; pending = undefined; progress = undefined; });
      return { started: true };
    },
    decide(input: Row) {
      if (!pending || input.scanId !== pending.review.scanId) throw new Error("この承認待ちは終了しています。画面を更新してください");
      if (input.approve === true) {
        const count = pending.review.missingCount;
        if (input.confirmedCount !== count) throw new Error("表示された削除候補の総件数が一致しません。画面を更新してください");
        // DF-2: 比率の弁を免除する承認には、件数の手入力と接続確認を必須にする。
        if (pending.summary.reasons.length && (input.typedCount !== count || input.largeLossConfirmed !== true)) throw new Error("欠損が基準を超えています。接続元を確認し、総件数を入力してください");
        const decision = { note: `運用画面で削除候補 ${count} 件を確認して反映（候補 sha256:${pending.summary.candidateHash}）${pending.summary.reasons.length ? "。件数入力と接続確認あり" : ""}`, maxMissingCount: count };
        const next = pending; pending = undefined; if (progress) progress.phase = "finishing"; next.decide(decision);
      } else {
        // 上限0の承認は、比率内でも欠損を通さない。拒否の理由も走査の行に残る。
        const next = pending; pending = undefined; if (progress) progress.phase = "finishing";
        next.decide({ note: "運用画面で削除を見送り", maxMissingCount: 0 });
      }
      return { accepted: true };
    },
    async inspect() {
      idle(); busy = true;
      // 長い blob 検証の間も同じ DB 状態を読むため、別接続の読み取りスナップショットを使う。
      const snapshot = new DatabaseSync(database, { readOnly: true });
      try {
        snapshot.exec("BEGIN");
        const report = await checkInvariants({ reader: { all: async (sql) => snapshot.prepare(sql).all() }, blobs });
        audit = { checkedAt: clock.now(), report };
        return audit;
      } finally { snapshot.close(); busy = false; }
    },
    async backup() {
      idle(); busy = true;
      const destination = join(dataDir, "backups", String(clock.now()));
      try {
        await mkdir(destination, { recursive: false });
        conn.db.prepare("VACUUM INTO ?").run(join(destination, "lineage.sqlite"));
        await cp(blobRoot, join(destination, "blobs"), { recursive: true, errorOnExist: true, force: false });
        await writeFile(join(destination, "COMPLETE.json"), JSON.stringify({ completedAt: clock.now(), database: "lineage.sqlite", blobs: "blobs" }));
        return { destination };
      } finally { busy = false; }
    },
    async close() {
      closing = true;
      if (pending) { const current = pending; pending = undefined; current.decide({ note: "運用画面の終了により削除を見送り", maxMissingCount: 0 }); }
      await task;
      conn.close();
    },
  };
}
