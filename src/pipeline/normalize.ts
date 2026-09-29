import { artifactId, canonicalConfigHash, derivationKey } from "../domain/ids.ts";
import { NORMALIZER_CONFIG, NORMALIZER_VERSION, normalizeDocumentV1, verifyNormalizedV1 } from "../domain/normalized-document.ts";
import { readOfficeArtifact, readParsedArtifact } from "../store/sqlite/office-artifact.ts";
import type { StoreConnection } from "../store/sqlite/connection.ts";
import type { NormalizedDocument } from "../domain/normalized-document.ts";
import type { ArtifactId, VersionId, WorkerId } from "../domain/types.ts";
import { readParsed, runParse } from "./parse.ts";
import type { ParseContext } from "./parse.ts";

const workerId = "operator-office-normalizer" as WorkerId;
export const normalizationDraft = (input: ArtifactId) => ({ processorName: "office-normalize", processorVersion: NORMALIZER_VERSION, configHash: canonicalConfigHash(NORMALIZER_CONFIG), inputIds: [input] });
export type NormalizedView = { status: "ready"; versionId: VersionId; artifactId: ArtifactId; inputArtifactId: ArtifactId; processorVersion: string; result: NormalizedDocument }
  | { status: "not_normalized" | "waiting" | "failed" | "unsupported"; versionId: VersionId; message: string };

export function readNormalizedArtifact(conn: StoreConnection, id: string): Extract<NormalizedView, { status: "ready" }> {
  return conn.read(() => {
    const a = readOfficeArtifact(conn, id, "normalized_document");
    if (a.processorName !== "office-normalize" || a.configHash !== canonicalConfigHash(NORMALIZER_CONFIG)) throw new Error("未対応の⑥設定です。対応するアプリで履歴を確認してください");
    const parent = readParsedArtifact(conn, a.inputId);
    if (parent.rootVersionId !== a.rootVersionId || parent.documentId !== a.documentId) throw new Error("⑥と入力の原本が一致しません");
    return { status: "ready", versionId: a.rootVersionId, artifactId: a.artifactId, inputArtifactId: parent.artifactId, processorVersion: a.processorVersion, result: verifyNormalizedV1(a.content, parent.result) };
  });
}
export function readNormalized(conn: StoreConnection, id: VersionId): NormalizedView {
  return conn.read(() => {
    const parsed = readParsed(conn, id);
    if (parsed.status !== "ready") return { status: parsed.status === "unsupported" ? "unsupported" : "not_normalized", versionId: id, message: parsed.status === "unsupported" ? parsed.message : "⑤の解析後に読みやすい形を保存できます。作成ボタンで順に実行します。" };
    const parent = readParsedArtifact(conn, parsed.artifactId), key = derivationKey(normalizationDraft(parent.artifactId));
    const d = conn.db.prepare("SELECT 1 FROM derivation WHERE derivation_key=?").get(key);
    if (d) return readNormalizedArtifact(conn, artifactId(key, 0));
    const run = conn.db.prepare("SELECT status,error_message FROM processing_run WHERE derivation_key=? ORDER BY attempt DESC LIMIT 1").get(key);
    if (conn.db.prepare("SELECT 1 FROM processing_run WHERE derivation_key=? AND status='succeeded'").get(key)) throw new Error("⑥の成功runに成果物がありません。整合性を点検してください");
    if (run?.status === "leased") return { status: "waiting", versionId: id, message: "⑥の処理中、または中断した試行の期限待ちです。開始から120秒後に再試行できます。" };
    return { status: run ? "failed" : "not_normalized", versionId: id, message: run ? String(run.error_message || "⑥は中断しました。再試行できます。") : "この版の読みやすい形はまだ作成していません。" };
  });
}
export async function runNormalize(context: ParseContext, id: VersionId): Promise<NormalizedView> {
  const parsed = await runParse(context, id);
  if (parsed.status !== "ready") return readNormalized(context.conn, id);
  const cached = readNormalized(context.conn, id);
  if (cached.status === "ready") return cached;
  const parent = readParsedArtifact(context.conn, parsed.artifactId), draft = normalizationDraft(parent.artifactId);
  const run = await context.store.claimRun({ ...draft, rootVersionId: parent.rootVersionId, workerId, leaseSeconds: 120 });
  if (!run) return readNormalized(context.conn, id);
  try {
    const content = JSON.stringify(normalizeDocumentV1(parent.result));
    await context.store.commitDerivation({ derivation: draft, artifacts: [{ kind: "inline", ordinal: 0, type: "normalized_document", content }], runId: run.runId, workerId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "⑥に失敗しました";
    const done = await context.store.completeRun({ runId: run.runId, workerId, status: "failed", error: { kind: "normalize_failed", message, permanent: false } });
    if (!done.ok) throw new Error(`⑥の確定前にリースが切れました。再試行してください: ${message}`);
    throw error;
  }
  return readNormalized(context.conn, id);
}
