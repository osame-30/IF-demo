import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { normalizeDocumentV1 } from "../domain/normalized-document.ts";
import type { ParsedDocument } from "../domain/parsed-document.ts";
const { normalizedPage, renderNormalizedPage, renderNormalizedInfo, matchesNormalizedRequest } = await import(new URL("./public/normalized-view.js", import.meta.url).href);
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));

it("⑥ S6-05: A要求→版切替→B応答→A応答でもBの本文・出典・履歴を保持する", async () => {
  const app = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
  const code = app.slice(app.indexOf("async function refreshNormalized()"), app.indexOf("function searchControls("));
  const target = { innerHTML: "" }, control = { addEventListener() {}, onchange: undefined };
  const requests: Array<{ url: string; resolve: (value: unknown) => void }> = [];
  const context = { contentVersion: "v1", normalizedArtifact: "a1", normalizedValue: null, normalizedPolling: false,
    normalizedQuery: "", normalizedPageNumber: 0, normalizedEmpty: false, state: {},
    $: (selector: string) => selector === "#normalized-content" ? target : control,
    document: { querySelector: () => ({ disabled: false }) }, esc, time: String,
    renderNormalizedPage, renderNormalizedInfo, matchesNormalizedRequest,
    api: (url: string) => new Promise(resolve => { requests.push({ url, resolve }); }),
  };
  const response = (versionId: string, id: string, text: string) => ({ status: "ready", versionId, artifactId: id,
    inputArtifactId: `parent-${id}`, canNormalize: true, history: [{ artifact_id: id, processor_version: "v1", created_at: 1 }],
    result: normalizeDocumentV1({ schemaVersion: 1, format: "docx", warnings: [], blocks: [
      { kind: "paragraph", location: `出典-${id}`, style: "", text },
    ] }) });
  const first = runInNewContext(`${code}; refreshNormalized()`, context);
  context.contentVersion = "v2"; context.normalizedArtifact = "a2";
  const second = runInNewContext(`${code}; refreshNormalized()`, context);
  assert.ok(requests[0]!.url.includes("versionId=v1&artifactId=a1"));
  assert.ok(requests[1]!.url.includes("versionId=v2&artifactId=a2"));
  requests[1]!.resolve(response("v2", "a2", "現在の本文")); await second;
  const shown = target.innerHTML;
  assert.ok(shown.includes("現在の本文")); assert.ok(shown.includes("出典-a2")); assert.ok(shown.includes('value="a2"'));
  requests[0]!.resolve(response("v1", "a1", "古い本文")); await first;
  assert.equal(target.innerHTML, shown); assert.ok(!shown.includes("古い本文"));
});

it("⑥表示: 巨大な1行も100セルに制限し、HTML・区切り文字は文字として表示する", () => {
  const input: ParsedDocument = { schemaVersion: 1, format: "docx", warnings: [], blocks: [{ kind: "table", location: "表1", rows: [Array.from({ length: 201 }, (_, i) => ({ location: `表1 / セル${i + 1}`, text: "<script> ／ |", columnSpan: 99999, verticalMerge: "" }))] }] };
  const result = normalizeDocumentV1(input);
  for (const [page, size] of [[0, 100], [1, 100], [2, 1]]) {
    assert.equal(normalizedPage(result, "", false, page).entries.length, size);
    const html = renderNormalizedPage(result, "", false, page, esc);
    assert.ok(html.includes("&lt;script&gt;")); assert.ok(!html.includes("<script>")); assert.ok(!html.includes("colspan="));
  }
});
it("⑥表示: 数式のある空欄を隠さず、空文字・nullの出典を明示する", () => {
  const result = normalizeDocumentV1({ schemaVersion: 1, format: "xlsx", warnings: [], dateSystem: "1900", sheets: [{ name: "S", part: "s", state: "visible", merges: [], cells: [null, "", "0"].map((value, i) => ({ address: `A${i + 1}`, row: i + 1, column: 1, value, valueType: "n", formula: i === 0 ? "" : null, formulaKind: "shared", numberFormat: "General", hiddenRow: false, hiddenColumn: null })) }] });
  assert.equal(normalizedPage(result, "", false, 0).entries.length, 2);
  assert.equal(normalizedPage(result, "", true, 0).entries.length, 3);
  assert.equal(normalizedPage(result, "Ｓ！Ａ２", false, 0).entries.length, 1);
  const html = renderNormalizedPage(result, "", true, 0, esc);
  assert.ok(html.includes("値が未保存")); assert.ok(html.includes("空文字列")); assert.ok(html.includes("未記録"));
});
it("⑥表示: 原本の版または保存結果を切り替えた後の古い応答は採用しない", () => {
  assert.equal(matchesNormalizedRequest("v1", "a1", "v2", "a1"), false);
  assert.equal(matchesNormalizedRequest("v1", "a1", "v1", "a2"), false);
  assert.equal(matchesNormalizedRequest("v1", "a1", "v1", "a1"), true);
});
it("⑥表示: 空の表・空行・空シートも空欄表示から確認できる", () => {
  const word = normalizeDocumentV1({ schemaVersion: 1, format: "docx", warnings: [], blocks: [{ kind: "table", location: "空表", rows: [] }, { kind: "table", location: "空行", rows: [[]] }] });
  assert.equal(normalizedPage(word, "", true, 0).entries.length, 2);
  assert.ok(renderNormalizedPage(word, "", true, 0, esc).includes("抽出された項目がありません"));
  const sheet = normalizeDocumentV1({ schemaVersion: 1, format: "xlsx", dateSystem: "1900", warnings: [], sheets: [{ name: "空シート", part: "s", state: "visible", merges: [], cells: [] }] });
  assert.equal(normalizedPage(sheet, "", true, 0).entries.length, 1);
  assert.ok(!renderNormalizedPage(sheet, "", true, 0, esc).includes("行 null"));
});
it("⑥表示 N-3: 52万結合と101警告を文書全体で各100件に制限し、保存内容は切らない", () => {
  const result = normalizeDocumentV1({ schemaVersion: 1, format: "xlsx", dateSystem: "1900", warnings: Array.from({ length: 101 }, (_, i) => `警告${i}<>&\"'`), sheets: Array.from({ length: 26 }, (_, i) => ({ name: `S${i}`, part: `s${i}`, state: "visible", cells: [], merges: Array<string>(20000).fill("A1:XFD1048576") })) });
  const before = JSON.stringify(result), html = renderNormalizedInfo(result, esc);
  assert.equal((html.match(/<li>/g) ?? []).length, 200);
  assert.ok(html.includes("結合範囲 520000件（表示 100件・省略 519900件）"));
  assert.ok(html.includes("警告 101件（表示 100件・省略 1件）"));
  assert.ok(html.includes("&lt;&gt;&amp;&quot;&#39;")); assert.ok(!html.includes("警告100"));
  assert.equal(JSON.stringify(result), before); assert.ok(html.length < 20000);
});
it("⑥表示 N-7: 通信失敗と初回失敗でも選択欄が残り、別履歴への古い応答は採用しない", async () => {
  const app = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
  const code = app.slice(app.indexOf("async function refreshNormalized()"), app.indexOf("function searchControls("));
  const target = { innerHTML: "" }, history = { onchange: undefined }, button = { disabled: false };
  const original = { versionId: "v1", status: "read_error", message: "前回", canNormalize: true, history: [{ artifact_id: "old", processor_version: "v1", created_at: 0 }] };
  const context = { contentVersion: "v1", normalizedArtifact: "old", normalizedValue: original, normalizedPolling: false, state: {},
    $: (selector: string) => selector === "#normalized-content" ? target : selector === "#normalized-history" ? history : null,
    document: { querySelector: () => button }, esc, time: String, matchesNormalizedRequest,
    api: async () => { throw new Error("通信失敗"); },
  };
  await runInNewContext(`${code}; refreshNormalized()`, context);
  assert.ok(target.innerHTML.includes('id="normalized-history"')); assert.ok(target.innerHTML.includes('value="old"')); assert.ok(target.innerHTML.includes("通信失敗"));
  assert.equal(button.disabled, false);
  Object.assign(context, { normalizedValue: null });
  await runInNewContext(`${code}; refreshNormalized()`, context);
  assert.ok(target.innerHTML.includes("現在の解析・正規化の版"));
  let resolveResponse!: (v: unknown) => void;
  Object.assign(context, { normalizedValue: original, api: () => new Promise(resolve => { resolveResponse = resolve; }) });
  const pending = runInNewContext(`${code}; refreshNormalized()`, context);
  context.normalizedArtifact = "new";
  const before = target.innerHTML;
  resolveResponse({ ...original, message: "古い応答" }); await pending;
  assert.equal(target.innerHTML, before);
});

const { excelDateDisplay } = await import(new URL("./public/content-view.js", import.meta.url).href);

it("⑤⑥表示: 日付書式のセルは保存値の連番を日付として併記する", () => {
  // 保存値・書式・日付基準はすべて⑤の凍結された契約(v1)にあり、画面だけで計算できる。
  assert.equal(excelDateDisplay("46284", "n", "yyyy/mm/dd", "1900"), "2026-09-19");
  assert.equal(excelDateDisplay("46284.57291666666", "n", "m/d/yy h:mm", "1900"), "2026-09-19 13:45:00");
  assert.equal(excelDateDisplay("0.5732638888888889", "n", "h:mm:ss", "1900"), "13:45:30");
  assert.equal(excelDateDisplay("0.001", "n", "mm:ss", "1900"), "00:01:26", "mm:ss の m は分であって月ではない");
  assert.equal(excelDateDisplay("46284", "n", 'yyyy"年"m"月"d"日"', "1900"), "2026-09-19", "引用符の中は書式指定ではない");
});

it("⑤⑥表示: Excelにしかない1900-02-29の前後で起点がずれる", () => {
  assert.equal(excelDateDisplay("1", "n", "yyyy/mm/dd", "1900"), "1900-01-01");
  assert.equal(excelDateDisplay("59", "n", "yyyy/mm/dd", "1900"), "1900-02-28");
  assert.equal(excelDateDisplay("60", "n", "yyyy/mm/dd", "1900"), "1900-02-29（Excelにしか存在しない日）");
  assert.equal(excelDateDisplay("61", "n", "yyyy/mm/dd", "1900"), "1900-03-01");
  // 1904年方式は連番0が1904-01-01で、うるう年のずれがない。
  assert.equal(excelDateDisplay("0", "n", "yyyy/mm/dd", "1904"), "1904-01-01");
  assert.equal(excelDateDisplay("0", "n", "yyyy/mm/dd", "1900"), "", "1900年方式の連番0は日付にならない");
});

it("⑤⑥表示: 日付でないセルと読めない値には日付を出さない", () => {
  assert.equal(excelDateDisplay("123", "n", "#,##0", "1900"), "");
  assert.equal(excelDateDisplay("2026-09-19T00:00:00", "d", "General", "1900"), "", "t=d は保存値がすでに日付");
  assert.equal(excelDateDisplay("あ", "s", "yyyy/mm/dd", "1900"), "");
  assert.equal(excelDateDisplay(null, "n", "yyyy/mm/dd", "1900"), "");
  assert.equal(excelDateDisplay("", "n", "yyyy/mm/dd", "1900"), "");
  assert.equal(excelDateDisplay("-1", "n", "yyyy/mm/dd", "1900"), "");
  assert.equal(excelDateDisplay("2958466", "n", "yyyy/mm/dd", "1900"), "", "9999-12-31より後は日付にならない");
});

it("⑤⑥表示: 書式コードがファイルに無い組み込み書式は、日付の番号だけ日付として読む", () => {
  const locale = (id: number) => `組み込み書式 ${id}（地域依存。Excelの表示は環境によって変わります）`;
  // 27-36・50-58は東アジアの日付・時刻。Excelの見た目は分からないが、何日かは連番から分かる。
  assert.equal(excelDateDisplay("46000", "n", locale(27), "1900"), "2025-12-09");
  assert.equal(excelDateDisplay("46000", "n", locale(55), "1900"), "2025-12-09");
  assert.equal(excelDateDisplay("0.5", "n", locale(32), "1900"), "12:00:00", "時刻だけの書式で連番0を日付にしない");
  // 41-44は会計書式、23-26は未定義。日付として読むと嘘になる。
  assert.equal(excelDateDisplay("46000", "n", locale(42), "1900"), "");
  assert.equal(excelDateDisplay("46000", "n", locale(24), "1900"), "");
});

it("⑥表示: 出典欄に日付を併記し、保存値は連番のまま残す", () => {
  const result = normalizeDocumentV1({ schemaVersion: 1, format: "xlsx", warnings: [], dateSystem: "1900", sheets: [{ name: "S", part: "s", state: "visible", merges: [], cells: [{ address: "A1", row: 1, column: 1, value: "46284", valueType: "n", formula: null, formulaKind: "", numberFormat: "yyyy/mm/dd", hiddenRow: false, hiddenColumn: null }] }] });
  const html = renderNormalizedPage(result, "", false, 0, esc);
  assert.ok(html.includes("日付として読むと"));
  assert.ok(html.includes("2026-09-19"));
  assert.ok(html.includes("46284"), "保存値の連番を消さない");
  assert.ok(html.includes("Excelの表示書式は適用していません"));
});
