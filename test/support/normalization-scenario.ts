import type { TestContext } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore } from "../../src/store/sqlite/connection.ts";
import { SqliteLineageStore } from "../../src/store/sqlite/lineage-store.ts";
import { FileBlobStore } from "../../src/store/blob/file-blob-store.ts";
import { TestClock } from "./clock.ts";
import { wordSample } from "./office-samples.ts";
import type { SourceId } from "../../src/domain/types.ts";

export async function normalizationScenario(t: TestContext, file = false) {
  const root = await mkdtemp(join(tmpdir(), "normalize-test-"));
  const clock = new TestClock();
  await mkdir(join(root, "blobs"));
  const conn = openStore({ clock, location: file ? join(root, "lineage.sqlite") : ":memory:" });
  const store = new SqliteLineageStore(conn), blobs = new FileBlobStore({ root: join(root, "blobs"), clock });
  let closed = false;
  const close = () => { if (!closed) { conn.close(); closed = true; } };
  t.after(async () => { close(); await rm(root, { recursive: true, force: true }); });
  const sourceId = "normalize-source" as SourceId;
  conn.db.prepare("INSERT INTO source (source_id,kind,config_hash,display_name,key_unicode_form,key_case_fold,key_path_separator,key_trim_slashes) VALUES (?,'local-fs','cfg','test','NFC',0,'posix',1)").run(sourceId);
  const scan = await store.beginScan(sourceId, { countRatioThresholdBp: 0, missingRatioThresholdBp: 10000 });
  const addVersion = async (name = "履歴書.docx", bytes = wordSample()) => {
    const put = await blobs.put(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } }), bytes.length);
    const observed = await store.recordObservedDocument(scan.scanId, { stableKey: name, outcome: { kind: "content", contentHash: put.contentHash, sizeBytes: bytes.length } });
    const version = await store.insertVersionIfAbsent({ documentId: observed.documentId, contentHash: put.contentHash, sizeBytes: bytes.length, blobKey: put.blobKey, blobVerifiedAt: put.verifiedAt, mimeType: "application/octet-stream", discoveredByScanId: scan.scanId, pipelineVersion: "v0.2" });
    await store.setActiveVersion({ documentId: observed.documentId, observedHash: put.contentHash, versionId: version.versionId, scanId: scan.scanId });
    return version.versionId;
  };
  return { root, clock, conn, store, blobs, close, addVersion };
}

// N-2: 未変更の0ae4fecで生成した保存バイト列。現在の変換から期待値を作らない。
export const legacyNormalizedFixtures = [
  {
    "input": "{\"schemaVersion\":1,\"format\":\"docx\",\"warnings\":[\"旧Word\"],\"blocks\":[{\"kind\":\"paragraph\",\"location\":\"本文 / 段落 1\",\"style\":\"Title\",\"text\":\"Ａ 旧本文\"},{\"kind\":\"table\",\"location\":\"表1\",\"rows\":[[{\"location\":\"表1/1/1\",\"text\":\"左\",\"columnSpan\":2,\"verticalMerge\":\"restart\"},{\"location\":\"表1/1/2\",\"text\":\"\",\"columnSpan\":1,\"verticalMerge\":\"\"}]]}]}",
    "output": "{\"schemaVersion\":1,\"format\":\"docx\",\"dateSystem\":null,\"warnings\":[\"旧Word\"],\"groups\":[{\"kind\":\"paragraph\",\"location\":\"本文 / 段落 1\",\"units\":[{\"row\":null,\"members\":[{\"kind\":\"word_paragraph\",\"source\":{\"kind\":\"paragraph\",\"location\":\"本文 / 段落 1\",\"text\":\"Ａ 旧本文\",\"style\":\"Title\"},\"searchText\":\"a 旧本文\"}]}]},{\"kind\":\"table\",\"location\":\"表1\",\"units\":[{\"row\":1,\"members\":[{\"kind\":\"word_cell\",\"source\":{\"location\":\"表1/1/1\",\"text\":\"左\",\"columnSpan\":2,\"verticalMerge\":\"restart\"},\"searchText\":\"左\"},{\"kind\":\"word_cell\",\"source\":{\"location\":\"表1/1/2\",\"text\":\"\",\"columnSpan\":1,\"verticalMerge\":\"\"},\"searchText\":\"\"}]}]}]}"
  },
  {
    "input": "{\"schemaVersion\":1,\"format\":\"xlsx\",\"warnings\":[\"旧Excel\"],\"dateSystem\":\"1904\",\"sheets\":[{\"name\":\"旧シート\",\"state\":\"hidden\",\"part\":\"s1\",\"merges\":[\"A1:B1\"],\"cells\":[{\"address\":\"B1\",\"row\":1,\"column\":2,\"value\":null,\"valueType\":\"n\",\"formula\":\"SUM(A1:A1)\",\"formulaKind\":\"\",\"numberFormat\":\"General\",\"hiddenRow\":true,\"hiddenColumn\":false},{\"address\":\"A1\",\"row\":1,\"column\":1,\"value\":\"Ａ\",\"valueType\":\"s\",\"formula\":null,\"formulaKind\":\"\",\"numberFormat\":\"General\",\"hiddenRow\":false}]}]}",
    "output": "{\"schemaVersion\":1,\"format\":\"xlsx\",\"dateSystem\":\"1904\",\"warnings\":[\"旧Excel\"],\"groups\":[{\"kind\":\"sheet\",\"name\":\"旧シート\",\"part\":\"s1\",\"state\":\"hidden\",\"merges\":[\"A1:B1\"],\"units\":[{\"row\":1,\"members\":[{\"kind\":\"sheet_cell\",\"source\":{\"address\":\"A1\",\"row\":1,\"column\":1,\"value\":\"Ａ\",\"valueType\":\"s\",\"formula\":null,\"formulaKind\":\"\",\"numberFormat\":\"General\",\"hiddenRow\":false,\"hiddenColumn\":null},\"searchText\":\"a\",\"searchFormula\":\"\"},{\"kind\":\"sheet_cell\",\"source\":{\"address\":\"B1\",\"row\":1,\"column\":2,\"value\":null,\"valueType\":\"n\",\"formula\":\"SUM(A1:A1)\",\"formulaKind\":\"\",\"numberFormat\":\"General\",\"hiddenRow\":true,\"hiddenColumn\":false},\"searchText\":\"\",\"searchFormula\":\"sum(a1:a1)\"}]}]}]}"
  }
];
