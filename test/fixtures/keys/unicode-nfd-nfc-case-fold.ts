/**
 * 攻撃 #23 — 同一の物理ファイルに、2つの document ができる。
 *
 * 元の穴: macOS は名前を NFD で返し、他のツールは NFC で書きます。
 * 正規化しないと `café`（NFC）と `café`（NFD）は別の鍵になり、
 * **同じファイルに2つの documentId が立ちます。** 大文字小文字も同じ形で、
 * Windows / macOS の既定 FS では `Report.txt` と `report.txt` が同じ実体なのに、
 * 畳まなければ2つの文書になります。
 *
 * ## 「正規化する」は「正しくなる」ではありません
 *
 * 畳むと逆向きの問題が出ます。**正規化は単射ではないので、別の実体が
 * 同じ documentId に潰れます。** どちらが正かはシステムには言えないので、
 * 記録だけします（`stable_key_collision`、S-17）。この一式は
 * **潰れたときに1つの文書として一貫している**ことを見ます ——
 * 版が2つ立っても、有効な版へのポインタは1本だけ（`SINGLE_ACTIVE_VERSION`）。
 *
 * ## OS 依存はありません（意図的に）
 *
 * 畳むのは `normalizeStableKey` で、入力は**接続元が報告した文字列**です。
 * ファイルシステムには触れません。`String.prototype.normalize` は ICU 実装で
 * プラットフォーム間で同じ答えを返すので、この一式は ubuntu でも macOS でも
 * 同じ結果になります。**それがこの検査の値打ちです** ——
 * FIXTURES.md D節が「片方でしか回していないと永久に見つからない」と書いている
 * 攻撃に対して、両方で回して同じ答えが出ることを示します。
 *
 * 接続元が NFD と NFC のどちらを報告するかは OS の問題ですが、それは
 * `LocalFolderSourceAdapter` の話（S-7）で、この層の主張ではありません。
 */

import assert from "node:assert/strict";

import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import type { InvariantName, ScanId, SourceId } from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = [
  "CANONICAL_KEY_STABILITY",
  "SINGLE_ACTIVE_VERSION",
];

/** NFC に畳む。大小は畳まない（Linux の既定 FS） */
const NFC_SOURCE = "mac-nfc" as SourceId;
/** 何も畳まない。生存確認のためだけに置く */
const RAW_SOURCE = "raw" as SourceId;
/** 大小を畳む（Windows / macOS の既定 FS） */
const FOLDED_SOURCE = "win-folded" as SourceId;
/**
 * 大小を畳まない接続元。大小の生存確認に使う。
 *
 * **`NFC_SOURCE` を使い回せません。** あちらは café を1件持っているので、
 * `Report.txt` だけを観測する走査は café を欠損と読み、
 * 前回比 100% で安全弁が閉じます（実測: `missing_ratio`）。
 * 弁は正しく働いているので、検査の側が別の接続元を使います。
 */
const CASE_RAW_SOURCE = "linux-nofold" as SourceId;

const NFC = "café.txt".normalize("NFC");
const NFD = "café.txt".normalize("NFD");

async function scanOnce(
  ctx: FixtureContext,
  source: SourceId,
  entries: ReadonlyArray<{ key: string; body: string }>,
): Promise<{ scanId: ScanId; documentIds: string[] }> {
  const scan = await ctx.store.beginScan(source, DEFAULT_THRESHOLDS);
  const documentIds: string[] = [];
  for (const e of entries) {
    const result = await ctx.ingest(scan.scanId, e.key, e.body);
    documentIds.push(String(result.documentId));
  }
  const finished = await ctx.store.finishScan(scan.scanId, {
    enumeratedCount: entries.length,
    distinctCount: new Set(documentIds).size,
    writeFailureCount: 0,
  });
  assert.equal(finished.status, "completed", `fixture scan aborted: ${finished.abortReason}`);
  return { scanId: scan.scanId, documentIds };
}

export function setup(ctx: FixtureContext): Promise<void> {
  // 前提。この2つが同じ文字列なら、この一式は何も検査していません
  assert.notEqual(NFC, NFD, "前提: NFC と NFD が別の文字列であること");
  assert.equal(NFC.normalize("NFC"), NFD.normalize("NFC"), "前提: 畳めば一致すること");

  ctx.addSource(NFC_SOURCE, { unicodeForm: "NFC", caseFold: false });
  ctx.addSource(RAW_SOURCE, { unicodeForm: "none", caseFold: false });
  ctx.addSource(FOLDED_SOURCE, { unicodeForm: "NFC", caseFold: true });
  ctx.addSource(CASE_RAW_SOURCE, { unicodeForm: "NFC", caseFold: false });
  return Promise.resolve();
}

export async function execute(ctx: FixtureContext): Promise<void> {
  // --- 生存確認: 畳まない接続元では、同じ2つが別の文書になる ---
  //
  // これが無いと、**鍵を見ずに常に同じ ID を返す実装でも緑になります。**
  const raw = await scanOnce(ctx, RAW_SOURCE, [
    { key: NFD, body: "written on a mac" },
    { key: NFC, body: "written elsewhere" },
  ]);
  assert.equal(
    new Set(raw.documentIds).size,
    2,
    "unicodeForm:'none' でも畳まれている。ポリシーが効いていない",
  );

  // --- NFC に畳む接続元では、同じ1つの文書になる ---
  ctx.clock.advance(1000);
  const folded = await scanOnce(ctx, NFC_SOURCE, [
    { key: NFD, body: "written on a mac" },
    { key: NFC, body: "written elsewhere" },
  ]);
  assert.equal(
    new Set(folded.documentIds).size,
    1,
    "NFD と NFC が別の documentId になった（#23 そのもの）",
  );
  assert.equal(ctx.count("document WHERE source_id=?", NFC_SOURCE), 1);

  // **潰れたことは記録されます。** どちらが正かはシステムには言えないので（S-17）
  assert.ok(
    ctx.observationCount("stable_key_collision") >= 1,
    "同じ走査で鍵が潰れたのに記録が無い",
  );

  // 内容が違うので版は2つ。**有効な版へのポインタは1本だけ**
  assert.equal(
    ctx.count(
      "document_version dv JOIN document d USING(document_id) WHERE d.source_id=?",
      NFC_SOURCE,
    ),
    2,
    "潰れた2件が同じ版になっている",
  );
  const pointer = ctx.one<{ active_version_id: string | null }>(
    "SELECT active_version_id FROM document WHERE source_id=?",
    NFC_SOURCE,
  )!;
  assert.notEqual(pointer.active_version_id, null, "ポインタが立っていない");

  // --- 大文字小文字。同じ形の問題で、別のポリシーが受け持つ ---
  ctx.clock.advance(1000);
  const notFolded = await scanOnce(ctx, CASE_RAW_SOURCE, [
    { key: "Report.txt", body: "R" },
    { key: "report.txt", body: "r" },
  ]);
  assert.equal(
    new Set(notFolded.documentIds).size,
    2,
    "caseFold:false なのに大小が畳まれている",
  );

  ctx.clock.advance(1000);
  const caseFolded = await scanOnce(ctx, FOLDED_SOURCE, [
    { key: "Report.txt", body: "R" },
    { key: "report.txt", body: "r" },
  ]);
  assert.equal(
    new Set(caseFolded.documentIds).size,
    1,
    "caseFold:true なのに大小が畳まれていない（#23 の大小版）",
  );
  assert.equal(ctx.count("document WHERE source_id=?", FOLDED_SOURCE), 1);

  // --- 2つのポリシーは独立している ---
  //
  // 片方の実装がもう片方を巻き込んでいないこと。`unicodeForm` が
  // 大小まで畳んでいたら、上の notFolded が 1 になって落ちます
  assert.equal(
    ctx.count("document"),
    ctx.count("document WHERE source_id=?", RAW_SOURCE) +
      ctx.count("document WHERE source_id=?", NFC_SOURCE) +
      ctx.count("document WHERE source_id=?", CASE_RAW_SOURCE) +
      ctx.count("document WHERE source_id=?", FOLDED_SOURCE),
    "どの接続元にも属さない文書がある",
  );
}
