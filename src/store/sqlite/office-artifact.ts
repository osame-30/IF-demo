import { createHash } from "node:crypto";
import { artifactId, derivationKey, outputsHash, canonicalConfigHash } from "../../domain/ids.ts";
import { parseDocumentResultV1 } from "../../domain/parsed-document.ts";
import { NORMALIZER_CONFIG, verifyNormalizedV1 } from "../../domain/normalized-document.ts";
import { InvalidArgumentError } from "../../domain/errors.ts";
import type { ArtifactId, VersionId, DocumentId, ContentHash, DerivationDraft, ArtifactDraft } from "../../domain/types.ts";
import type { StoreConnection } from "./connection.ts";

/** 現在のParser版から選び直さず、保存された材料と入力IDで過去の証拠も照合する。 */
export function readOfficeArtifact(conn: StoreConnection, id: string, type: "parsed_document" | "normalized_document") {
  return conn.read(() => {
    const a = conn.db.prepare("SELECT * FROM artifact WHERE artifact_id=?").get(id);
    if (!a || a.type !== type || typeof a.inline_content !== "string" || a.blob_key !== null) throw new Error("指定されたOffice成果物が見つからないか、保存形式が不正です");
    const max = type === "parsed_document" ? 8 * 1024 * 1024 : 16 * 1024 * 1024;
    if (Buffer.byteLength(a.inline_content) > max) throw new Error("保存されたOffice成果物が上限を超えています");
    const d = conn.db.prepare("SELECT * FROM derivation WHERE derivation_key=?").get(a.derivation_key!);
    if (!d) throw new Error("Office成果物の派生がありません");
    const input: unknown = JSON.parse(String(d.input_ids));
    if (!Array.isArray(input) || input.length !== 1 || typeof input[0] !== "string") throw new Error("Office成果物の入力が不正です");
    const inputId = input[0] as ArtifactId;
    const draft = { processorName: String(d.processor_name), processorVersion: String(d.processor_version), configHash: String(d.config_hash), inputIds: [inputId] };
    const key = derivationKey(draft), expected = artifactId(key, 0);
    const hash = createHash("sha256").update(a.inline_content).digest("hex") as ContentHash;
    const root = conn.db.prepare("SELECT document_id FROM document_version WHERE version_id=?").get(d.root_version_id!);
    const count = conn.db.prepare("SELECT count(*) AS n FROM artifact WHERE derivation_key=?").get(key);
    const success = conn.db.prepare("SELECT 1 FROM processing_run WHERE derivation_key=? AND status='succeeded' AND root_version_id=? AND document_id=?").get(key, d.root_version_id!, d.document_id!);
    if (key !== d.derivation_key || expected !== id || a.ordinal !== 0 || d.artifact_count !== 1 || count?.n !== 1 ||
        !root || root.document_id !== d.document_id || a.root_version_id !== d.root_version_id || a.document_id !== d.document_id ||
        a.content_hash !== hash || a.size_bytes !== Buffer.byteLength(a.inline_content) || !success ||
        d.outputs_hash !== outputsHash([{ artifactId: expected, ordinal: 0, contentHash: hash }])) throw new Error("Office成果物の保存証拠が一致しません。整合性を点検してください");
    return { artifactId: expected, rootVersionId: String(d.root_version_id) as VersionId, documentId: String(d.document_id) as DocumentId,
      content: a.inline_content, inputId, ...draft };
  });
}

export function readParsedArtifact(conn: StoreConnection, id: string) {
  return conn.read(() => {
    const a = readOfficeArtifact(conn, id, "parsed_document");
    if (a.processorName !== "office-xml" || String(a.inputId) !== String(a.rootVersionId)) throw new Error("⑤の入力と原本が一致しません");
    // N-2: 現在の⑤の表示契約を通さず、⑥ v1が確定時に使った契約で読む。
    return { ...a, result: parseDocumentResultV1(JSON.parse(a.content)) };
  });
}

/** ⑥の確定境界。通常UI以外の呼出しでも別原本の入力や偽の対応を確定できない。 */
export function assertNormalizationCommit(conn: StoreConnection, draft: DerivationDraft, artifacts: ReadonlyArray<ArtifactDraft>, root: VersionId): void {
  if (draft.processorName !== "office-normalize" && !artifacts.some((a) => a.type === "normalized_document")) return;
  try {
    const a = artifacts[0];
    if (draft.processorName !== "office-normalize" || draft.inputIds.length !== 1 || artifacts.length !== 1 ||
        !a || a.type !== "normalized_document" || a.ordinal !== 0 || a.kind !== "inline" ||
        draft.configHash !== canonicalConfigHash(NORMALIZER_CONFIG)) throw new Error("⑥は対応する設定と単一の入力・出力が必要です");
    const parent = readParsedArtifact(conn, draft.inputIds[0]!);
    if (parent.rootVersionId !== root) throw new Error("⑥の入力とrunの原本が一致しません");
    verifyNormalizedV1(a.content, parent.result);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : "⑥の確定条件が不正です");
  }
}
