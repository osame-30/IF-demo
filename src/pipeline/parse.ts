/** #9/#13: 原本の検証・解析が終わるまで派生を確定しない。失敗した試行は再試行可能にする。 */
import { createHash } from "node:crypto";
import { extname } from "node:path";
import { artifactId, canonicalConfigHash, derivationKey, outputsHash } from "../domain/ids.ts";
import type { BlobKey, BlobStore, ContentHash, LineageStore, VersionId, WorkerId } from "../domain/types.ts";
import { parseDocumentResult } from "../domain/parsed-document.ts";
import type { ParsedDocument } from "../domain/parsed-document.ts";
import type { StoreConnection } from "../store/sqlite/connection.ts";
import { PARSER_CONFIG, PARSER_VERSION, ParserFailure, parseInChildProcess } from "../parser/process.ts";

export interface ParseContext { conn: StoreConnection; store: LineageStore; blobs: BlobStore }
const workerId = "operator-office-parser" as WorkerId;
function version(conn: StoreConnection, id: VersionId) {
  const v = conn.db.prepare(`SELECT v.*, d.stable_key FROM document_version v JOIN document d USING(document_id) WHERE v.version_id=?`).get(id);
  if (!v) throw new Error("保存された版が見つかりません。");
  return v;
}
function materials(conn: StoreConnection, id: VersionId) {
  const row = version(conn, id), format = extname(String(row.stable_key)).toLowerCase().slice(1);
  const draft = { processorName: "office-xml", processorVersion: PARSER_VERSION, configHash: canonicalConfigHash({ ...PARSER_CONFIG, format }), inputIds: [id] };
  return { row, format, draft, key: derivationKey(draft) };
}
export type ContentView = {
  status: "ready"; result: ParsedDocument; artifactId: string; versionId: VersionId; contentHash: string;
} | { status: "not_parsed" | "failed" | "waiting" | "unsupported"; message: string; versionId: VersionId };

export function readParsed(conn: StoreConnection, id: VersionId): ContentView {
  return conn.read(() => {
    const { row, format, draft, key } = materials(conn, id);
    if (format !== "docx" && format !== "xlsx") return { status: "unsupported", versionId: id, message: "⑤の対応形式は .docx と .xlsx です。PDFは原本との照合用です。.doc / .xls は元のアプリで新形式として別名保存してください。" };
    const d = conn.db.prepare("SELECT * FROM derivation WHERE derivation_key=?").get(key);
    const latest = conn.db.prepare("SELECT * FROM processing_run WHERE derivation_key=? ORDER BY attempt DESC LIMIT 1").get(key);
    const succeeded = conn.db.prepare("SELECT * FROM processing_run WHERE derivation_key=? AND status='succeeded' ORDER BY attempt DESC LIMIT 1").get(key);
    if (d) {
      const artifacts = conn.db.prepare("SELECT * FROM artifact WHERE derivation_key=? ORDER BY ordinal").all(key), a = artifacts[0];
      const expectedId = artifactId(key, 0);
      const content = typeof a?.inline_content === "string" ? a.inline_content : "";
      const hash = createHash("sha256").update(content).digest("hex") as ContentHash;
      // 行の存在だけを完了としない。版・材料・全成果物・成功runを同じ読取内で照合する。
      const intact = d.root_version_id === id && d.document_id === row.document_id &&
        d.processor_name === draft.processorName && d.processor_version === draft.processorVersion && d.config_hash === draft.configHash &&
        d.input_ids === JSON.stringify([id]) && d.artifact_count === 1 && artifacts.length === 1 &&
        a?.artifact_id === expectedId && a.root_version_id === id && a.document_id === row.document_id && a.ordinal === 0 &&
        a.type === "parsed_document" && a.blob_key === null && a.content_hash === hash && a.size_bytes === Buffer.byteLength(content) &&
        d.outputs_hash === outputsHash([{ artifactId: expectedId, ordinal: 0, contentHash: hash }]) &&
        succeeded?.root_version_id === id && succeeded.document_id === row.document_id;
      if (!intact) throw new Error("解析結果の保存状態に不一致があります。整合性の点検を実行してください。完了済みとして表示しません。");
      const result = parseDocumentResult(JSON.parse(content));
      if (result.format !== format) throw new Error("保存された解析形式が原本と一致しません。");
      return { status: "ready", result, artifactId: expectedId, versionId: id, contentHash: String(row.content_hash) };
    }
    if (succeeded) throw new Error("成功runに対応する解析結果がありません。整合性の点検が必要です。");
    if (latest?.status === "leased") return { status: "waiting", versionId: id, message: "解析中、または中断した試行の期限待ちです。開始から最長120秒後に「内容を解析」で再試行できます。" };
    if (latest) return { status: "failed", versionId: id, message: String(latest.error_message || "前回の解析は中断しました。「内容を解析」で再試行できます。") };
    return { status: "not_parsed", versionId: id, message: "この版の内容はまだ解析していません。" };
  });
}

export async function readOriginal(context: Pick<ParseContext, "conn" | "blobs">, id: VersionId, signal?: AbortSignal): Promise<{ bytes: Buffer; filename: string }> {
  signal?.throwIfAborted();
  const row = version(context.conn, id);
  if (Number(row.size_bytes) > PARSER_CONFIG.inputBytes) throw new ParserFailure("limit_exceeded", "画面で扱う原本は20MiBまでです。元のフォルダから原本を確認してください。");
  const read = await context.blobs.get(String(row.blob_key) as BlobKey, String(row.content_hash) as ContentHash);
  // 途中で上限に達した場合もcompletedの拒否を回収し、未検証バイトを返さない。
  const completed = read.completed.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
  const chunks: Buffer[] = []; let size = 0;
  // S5-74: pipeToは切断・出力側の失敗時に元ストリームをcancelし、読取ロックも解放する。
  await read.stream.pipeTo(new WritableStream<Uint8Array>({
    write(chunk) {
      size += chunk.length;
      if (size > PARSER_CONFIG.inputBytes) throw new ParserFailure("limit_exceeded", "原本が20MiBを超えています。");
      chunks.push(Buffer.from(chunk));
    },
  }), signal ? { signal } : {});
  signal?.throwIfAborted();
  const verified = await completed;
  if (!verified.ok) throw verified.error;
  if (size !== row.size_bytes) throw new Error("原本のサイズと保存された版が一致しません。");
  return { bytes: Buffer.concat(chunks), filename: String(row.stable_key).split(/[\\/]/).at(-1)! };
}

export async function runParse(context: ParseContext, id: VersionId): Promise<ContentView> {
  const cached = readParsed(context.conn, id);
  if (cached.status === "ready" || cached.status === "unsupported") return cached;
  const { format, draft } = materials(context.conn, id);
  if (format !== "docx" && format !== "xlsx") return cached;
  const run = await context.store.claimRun({ ...draft, rootVersionId: id, workerId, leaseSeconds: 120 });
  if (!run) return readParsed(context.conn, id);
  try {
    const { bytes } = await readOriginal(context, id);
    const parsed = await parseInChildProcess(bytes, format);
    await context.store.commitDerivation({ derivation: draft, artifacts: [{ kind: "inline", ordinal: 0, type: "parsed_document", content: JSON.stringify(parsed) }], runId: run.runId, workerId });
  } catch (error) {
    const kind = error instanceof ParserFailure ? error.code : "parse_failed";
    const message = error instanceof Error ? error.message : "内容解析に失敗しました。";
    // 原本修復後の再試行や、期限切れrunの再取得への入口を閉じない（#9/#13）。
    const completed = await context.store.completeRun({ runId: run.runId, workerId, status: "failed", error: { kind, message, permanent: false } });
    if (!completed.ok) throw new Error(`解析は確定されませんでした。試行の期限が切れています。再試行してください。原因: ${message}`);
    throw error;
  }
  return readParsed(context.conn, id);
}
