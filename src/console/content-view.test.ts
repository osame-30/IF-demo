import { it } from "node:test";
import assert from "node:assert/strict";
const { renderWordTable, pageWordBlocks, formatReason, parseStatusMessage, renderVersionList, pageWordEntries, filterSheetCells, filterWordBlocks, hasCellValue } = await import(new URL("./public/content-view.js", import.meta.url).href);
const esc = (value: unknown) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

it("商品化 S5-13: 一行の表も100セルずつ表示し、結合幅をレイアウトに適用しない", () => {
  const cells = Array.from({ length: 201 }, (_, i) => ({ location: `セル${i}`, text: `<値${i}>`, columnSpan: 1000, verticalMerge: "" }));
  const table = { location: "表1", rows: [cells] };
  for (const [offset, count] of [[0, 100], [100, 100], [200, 1]]) {
    const html = renderWordTable(table, 0, offset, esc, String);
    assert.equal((html.match(/class="parsed-text"/g) ?? []).length, count);
    assert.equal(html.includes("colspan"), false);
    assert.ok(html.includes(`&lt;値${offset}&gt;`));
    assert.ok(html.includes("横1000セル"));
  }
  assert.equal(pageWordBlocks(Array.from({ length: 43 }, (_, i) => i), 0).length, 20);
  assert.deepEqual(pageWordBlocks([0, 1, 2], 2), [{ block: 2, index: 2 }]);
});

it("DF-12: 別の版の解析中でも、期限待ちを隠さない", () => {
  const parsing = { progress: { phase: "parsing", versionId: "x" } };
  assert.match(parseStatusMessage({ versionId: "x", message: "期限待ち" }, parsing), /解析しています/);
  assert.equal(parseStatusMessage({ versionId: "y", message: "期限待ち" }, parsing), "期限待ち");
});

it("DF-13: 現行版Aへの復帰と選択中の過去版Bを別々に示す", () => {
  const versions = [{ version_id: "a", content_hash: "aaaa", ingested_at: 100, size_bytes: 4 }, { version_id: "b", content_hash: "bbbb", ingested_at: 200, size_bytes: 8 }];
  const html = renderVersionList(versions, "b", "a", esc, String, String);
  assert.match(html, /現行版[\s\S]*100[\s\S]*data-id="a" aria-pressed="false"/);
  assert.match(html, /過去の版[\s\S]*200[\s\S]*data-id="b" aria-pressed="true"/);
});

it("商品化 S5-14: ファイル名に含まれる障害コードを翻訳せず自由文を保持する", () => {
  const reasons = { blob_divergence: "原本不一致", ERR_SQLITE_ERROR: "DB障害" };
  const message = "必要な部品 xl/worksheets/,blob_divergence,ERR_SQLITE_ERROR,.xml がありません。";
  assert.equal(formatReason(message, reasons), message);
  assert.equal(formatReason("blob_divergence,ERR_SQLITE_ERROR", reasons), "原本不一致 / DB障害");
});

const cell = (address: string, value: string | null, formula: string | null = null) => ({ address, value, formula });

it("中身検索: 値のあるセルだけに絞り、値が未保存・空文字列を隠す", () => {
  const sheet = { name: "Sheet1", cells: [cell("B2", "履歴書"), cell("N2", null), cell("O2", ""), cell("C3", null, "SUM(A1:A2)")] };
  assert.deepEqual(filterSheetCells(sheet, "", true).map((c: { address: string }) => c.address), ["B2", "C3"]);
  assert.equal(filterSheetCells(sheet, "", false).length, 4);
  assert.equal(hasCellValue(cell("A1", "0")), true);
});

it("中身検索: 番地・シート名付き番地・全角入力で探せて、番地指定は値のない枠も見せる", () => {
  const sheet = { name: "Sheet1", cells: [cell("M2", "学歴・職歴"), cell("M20", "M2を参照"), cell("N2", null)] };
  const addresses = (q: string, valuesOnly = true) => filterSheetCells(sheet, q, valuesOnly).map((c: { address: string }) => c.address);
  assert.deepEqual(addresses("m2"), ["M2", "M20"]);
  assert.deepEqual(addresses("Ｎ２"), ["N2"]);
  assert.deepEqual(addresses("sheet1!n2"), ["N2"]);
  assert.deepEqual(addresses("職歴"), ["M2"]);
  assert.deepEqual(addresses("sum"), []);
  assert.deepEqual(filterSheetCells({ name: "S", cells: [cell("C3", null, "SUM(A1)")] }, "sum", true).map((c: { address: string }) => c.address), ["C3"]);
});

it("中身検索: Word は元の項目番号を保ち、表は一致したセルだけを残す", () => {
  const blocks = [
    { kind: "paragraph", location: "本文 / 段落 1", text: "志望動機" },
    { kind: "table", location: "表1", rows: [[{ location: "表1 / 行 1 / セル 1", text: "氏名" }, { location: "表1 / 行 1 / セル 2", text: "志望" }], [{ location: "表1 / 行 2 / セル 1", text: "住所" }]] },
    { kind: "paragraph", location: "本文 / 段落 2", text: "趣味" },
  ];
  const hits = filterWordBlocks(blocks, "志望");
  assert.deepEqual(hits.map((h: { index: number }) => h.index), [0, 1]);
  assert.deepEqual(hits[1].block.rows, [[blocks[1]!.rows![0]![1]]]);
  assert.equal(blocks[1]!.rows![0]!.length, 2);
  assert.deepEqual(filterWordBlocks(blocks, "段落 2").map((h: { index: number }) => h.index), [2]);
  assert.equal(filterWordBlocks(blocks, "  ").length, 3);
  const many = Array.from({ length: 25 }, (_, i) => ({ block: i, index: i * 2 }));
  assert.deepEqual(pageWordEntries(many, 20).map((e: { index: number }) => e.index), [40, 42, 44, 46, 48]);
  assert.equal(pageWordEntries(many, 0).length, 20);
});
