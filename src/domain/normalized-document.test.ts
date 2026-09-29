import { it } from "node:test";
import assert from "node:assert/strict";
import { normalizeDocumentV1, searchTextV1, verifyNormalizedV1, NORMALIZER_CONFIG, NORMALIZED_MAX_BYTES } from "./normalized-document.ts";
import { canonicalConfigHash } from "./ids.ts";
import type { ParsedDocument, SheetCell } from "./parsed-document.ts";

const cell = (address: string, row: number, column: number, value: string | null, formula: string | null = null): SheetCell => ({ address, row, column, value, valueType: "n", formula, formulaKind: formula === null ? "" : "shared", numberFormat: "yyyy/mm/dd", hiddenRow: false, hiddenColumn: null });
function book(cells: SheetCell[]): ParsedDocument { return { schemaVersion: 1, format: "xlsx", dateSystem: "1904", warnings: ["保存値は再計算しません"], sheets: [{ name: "履歴", part: "xl/worksheets/sheet1.xml", state: "hidden", merges: ["A1:D2"], cells }] }; }

it("⑥ S6-02: 8MiB未満の200万空行を、行配列の複製・unit生成前に拒否する", () => {
  const input: ParsedDocument = { schemaVersion: 1, format: "docx", warnings: [], blocks: Array.from({ length: 100 },
    (_, i) => ({ kind: "table", location: `表${i}`, rows: Array.from({ length: 20000 }, () => []) })) };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 8 * 1024 * 1024);
  for (const block of input.blocks) if (block.kind === "table") Object.defineProperty(block.rows, "map", {
    value: () => { assert.fail("空行配列の複製まで到達した"); },
  });
  assert.throws(() => normalizeDocumentV1(input), /構造だけで.*16MiB/);
});
it("⑥ S6-02: 既存16MiB境界の空行成果物は保持し、1byte超過は複製前に拒否する", () => {
  const rows: [][] = Array.from({ length: 20000 }, () => []);
  const input: ParsedDocument = { schemaVersion: 1, format: "docx", warnings: [""],
    blocks: Array.from({ length: 25 }, (_, i) => ({ kind: "table", location: `空行${i}`, rows })) };
  const base = Buffer.byteLength(JSON.stringify(normalizeDocumentV1(input)));
  input.warnings[0] = "a".repeat(NORMALIZED_MAX_BYTES - base);
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 8 * 1024 * 1024);
  const output = normalizeDocumentV1(input);
  assert.equal(Buffer.byteLength(JSON.stringify(output)), NORMALIZED_MAX_BYTES);
  assert.equal(output.groups[0]!.units.length, 20000);
  input.warnings[0] += "a";
  Object.defineProperty(rows, "map", { value: () => { assert.fail("超過した構造を複製した"); } });
  assert.throws(() => normalizeDocumentV1(input), /構造だけで.*16MiB/);
});
it("⑥ S6-02: 多数の空シートと結合範囲も保存し、座標や値は展開しない", () => {
  const input: ParsedDocument = { schemaVersion: 1, format: "xlsx", warnings: [], dateSystem: "1900",
    sheets: Array.from({ length: 2000 }, (_, i) => ({ name: `S${i}`, part: `s${i}`, state: "visible",
      cells: [], merges: Array.from({ length: 200 }, () => "A1:B1") })) };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) < 8 * 1024 * 1024);
  const out = normalizeDocumentV1(input);
  assert.equal(out.groups.length, 2000);
  assert.equal(out.groups.reduce((n, g) => n + g.units.length, 0), 0);
  assert.equal(out.groups.reduce((n, g) => n + (g.kind === "sheet" ? g.merges.length : 0), 0), 400000);
});

it("⑥ property: 100組の疎なセルで元の位置・値・式を一対一で保ち、再実行しても変わらない", () => {
  let seed = 7;
  for (let trial = 0; trial < 100; trial++) {
    const cells: SheetCell[] = [];
    for (let r = 1; r <= 30; r++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const column = seed % 26 + 1, value = [null, "", "0", " 同値 ", "Ａ①\t\nＢ", "|／<script>"][seed % 6]!;
      cells.push(cell(`${String.fromCharCode(column + 64)}${r * 3}`, r * 3, column, value, r % 4 === 0 ? "" : null));
    }
    const input = book(cells), before = JSON.stringify(input), out = normalizeDocumentV1(input);
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(out.groups.flatMap((g) => g.units.flatMap((u) => u.members.map((m) => m.source))), cells);
    assert.deepEqual(normalizeDocumentV1(input), out);
    assert.deepEqual(verifyNormalizedV1(JSON.stringify(out), input), out);
    assert.equal(out.dateSystem, "1904");
  }
});
it("⑥: NFKC・固定空白・小文字化のベクタ。ゼロ幅文字は消さない", () => {
  assert.equal(canonicalConfigHash(NORMALIZER_CONFIG), "ed2ad18f2abb020721c4090870381bdc8e13c3badff5b617a7cf7baf70db0945");
  assert.equal(searchTextV1("　Ａ①\r\nＢ\u00a0 C　"), "a1 b c");
  assert.equal(searchTextV1("a\u200bb"), "a\u200bb");
  assert.equal(searchTextV1("İ"), "i\u0307");
});
it("⑥: 同数でも欠落と二重化、値の位置交換、検索文字の改変を拒否する", () => {
  const input = book([cell("A1", 1, 1, "左"), cell("B1", 1, 2, "右")]);
  const out = normalizeDocumentV1(input), members = out.groups[0]!.units[0]!.members;
  members[1] = members[0]!;
  assert.throws(() => verifyNormalizedV1(JSON.stringify(out), input), /一致しません/);
  const swapped = normalizeDocumentV1(input);
  const pair = swapped.groups[0]!.units[0]!.members;
  if (pair[0]!.kind !== "sheet_cell" || pair[1]!.kind !== "sheet_cell") assert.fail();
  [pair[0]!.source.value, pair[1]!.source.value] = [pair[1]!.source.value, pair[0]!.source.value];
  assert.throws(() => verifyNormalizedV1(JSON.stringify(swapped), input), /一致しません/);
  const changed = normalizeDocumentV1(input);
  changed.groups[0]!.units[0]!.members[0]!.searchText = "偽";
  assert.throws(() => verifyNormalizedV1(JSON.stringify(changed), input), /一致しません/);
});

it("⑥: 20000項目を保持し、超過とNFKCによる16MiB超の膨張を拒否する", () => {
  const cells = Array.from({ length: 20000 }, (_, i) => cell(`A${i + 1}`, i + 1, 1, "㍿"));
  const result = normalizeDocumentV1(book(cells));
  assert.equal(result.groups[0]!.units.length, 20000);
  cells.push(cell("A20001", 20001, 1, "超過"));
  assert.throws(() => normalizeDocumentV1(book(cells)), /上限20000/);
  // ⑤の8MiB以内でも検索文字が膨張する。末尾を切らず⑥全体を失敗にする。
  const expansion = book([cell("A1", 1, 1, "㍿".repeat(1200000))]);
  assert.ok(Buffer.byteLength(JSON.stringify(expansion)) < 8 * 1024 * 1024);
  assert.throws(() => normalizeDocumentV1(expansion), /16MiB/);
});
it("⑥: 重複位置・番地の食い違いを補正せず拒否する", () => {
  assert.throws(() => normalizeDocumentV1(book([cell("A1", 1, 1, "a"), cell("A1", 1, 1, "b")])), /重複/);
  assert.throws(() => normalizeDocumentV1(book([cell("A1", 2, 3, "a")])), /一致しません/);
  assert.throws(() => normalizeDocumentV1(book([cell("XFE1", 1, 16385, "a")])), /範囲外/);
});
it("⑥: Word空段落・空表・空行・横縦結合・警告とスタイルを保持する", () => {
  const input: ParsedDocument = { schemaVersion: 1, format: "docx", warnings: ["隠し文字も含む"], blocks: [
    { kind: "paragraph", location: "本文 / 段落 1", text: "", style: "Title" },
    { kind: "table", location: "表1", rows: [[], [{ location: "表1 / 行2 / セル1", text: "a ／ b\n|", columnSpan: 2, verticalMerge: "restart" }]] },
    { kind: "table", location: "表2", rows: [] },
  ] };
  const out = normalizeDocumentV1(input);
  assert.equal(out.groups.length, 3); assert.equal(out.groups[1]!.units[0]!.members.length, 0);
  assert.deepEqual(out.groups[1]!.units[1]!.members[0]!.source, input.blocks[1]!.kind === "table" ? input.blocks[1]!.rows[1]![0] : null);
  assert.deepEqual(out.warnings, input.warnings);
  input.blocks.push({ kind: "paragraph", location: "本文 / 段落 1", text: "別", style: "" });
  assert.throws(() => normalizeDocumentV1(input), /重複/);
});
it("⑥: 結合の非左上値も保持し、巨大結合を矩形へ展開しない", () => {
  const input = book([cell("A1", 1, 1, "氏名"), cell("B1", 1, 2, "非左上に保存された値")]);
  if (input.format !== "xlsx") throw new Error("fixture");
  input.sheets[0]!.merges = ["A1:XFD1048576"];
  assert.equal(normalizeDocumentV1(input).groups[0]!.units[0]!.members.length, 2);
});
