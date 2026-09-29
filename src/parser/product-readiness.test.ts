import { it } from "node:test";
import assert from "node:assert/strict";
import { parseOffice, ParseError } from "./office.ts";
import { wordEntries, excelEntries, zipEntries, W } from "../../test/support/office-samples.ts";
import { LIMITS } from "./limits.ts";
import { parseDocumentResult } from "../domain/parsed-document.ts";

const wordBody = (body: string) => zipEntries(wordEntries().map(([n, x]) => [n, n === "word/document.xml" ? x.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${body}</w:body>`) : x]));

it("商品化 S5-73: 旧結果で未記録の列状態を表示列と断定しない", async () => {
  const result = await parseOffice(zipEntries(excelEntries()), "xlsx");
  if (result.format !== "xlsx") assert.fail();
  const legacy = JSON.parse(JSON.stringify(result));
  for (const sheet of legacy.sheets) for (const cell of sheet.cells) delete cell.hiddenColumn;
  const parsed = parseDocumentResult(legacy);
  if (parsed.format !== "xlsx") assert.fail();
  assert.equal(parsed.sheets[0]?.cells[0]?.hiddenColumn, null);
  assert.deepEqual(parseDocumentResult(parsed), parsed);
  legacy.sheets[0].cells[0].hiddenColumn = "false";
  assert.throws(() => parseDocumentResult(legacy), /列の状態/);
});

it("商品化 S5-8/10: ZIP別名拡張と大小文字違いの部品重複を拒否する", async () => {
  // 別名の内容は空。表示の食い違いを起こす入力を使わず、未対応拡張の入口を検査する。
  const extra = Buffer.from([0x75, 0x70, 0, 0]);
  await assert.rejects(parseOffice(zipEntries(wordEntries(), extra), "docx"), /Unicode別名/);
  await assert.rejects(parseOffice(zipEntries([...wordEntries(), ["Word/Document.xml", "unused"]]), "docx"), /重複/);
});

it("商品化 S5-9: 関係が指す改名済み本体を読み、未参照の旧名部品を使わない", async () => {
  for (const format of ["docx", "xlsx"] as const) {
    const base = format === "docx" ? wordEntries("本体の文章") : excelEntries("本体の値");
    const before = format === "docx" ? "word/document.xml" : "xl/workbook.xml";
    const after = format === "docx" ? "word/main.xml" : "xl/book.xml";
    const oldRel = format === "docx" ? "word/_rels/document.xml.rels" : "xl/_rels/workbook.xml.rels";
    const newRel = format === "docx" ? "word/_rels/main.xml.rels" : "xl/_rels/book.xml.rels";
    const entries: [string, string][] = base.map(([n, x]) => [n === before ? after : n === oldRel ? newRel : n, x.replaceAll(before, after)]);
    entries.push([before, "unreferenced old name"]);
    const result = await parseOffice(zipEntries(entries), format);
    assert.deepEqual(result, await parseOffice(zipEntries(base), format));
  }
  await assert.rejects(parseOffice(zipEntries(wordEntries().filter(([n]) => n !== "_rels/.rels")), "docx"), /部品/);
});

it("商品化 S5-10/11: XML1.1と未知必須要素を拒否し、無視可能な拡張は子ごと省略する", async () => {
  const body = '<w:p><w:r><w:t>A</w:t></w:r></w:p><x:extra><w:p><w:r><w:t>B</w:t></w:r></w:p></x:extra><w:p><w:r><w:t>C</w:t></w:r></w:p>';
  const packageWith = (head: string) => zipEntries(wordEntries().map(([n, x]) => [n, n === "word/document.xml" ? `${head}<w:body>${body}</w:body></w:document>` : x]));
  const namespaces = `xmlns:w="${W}" xmlns:x="urn:fixture:extension" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"`;
  await assert.rejects(parseOffice(packageWith(`<w:document ${namespaces}>`), "docx"), /名前空間/);
  await assert.rejects(parseOffice(packageWith(`<?xml version="1.1"?><w:document ${namespaces} mc:Ignorable="x">`), "docx"), /XML 1.0/);
  await assert.rejects(parseOffice(packageWith(`<w:document ${namespaces} mc:Ignorable="x" mc:ProcessContent="x:extra">`), "docx"), /互換性/);
  const result = await parseOffice(packageWith(`<w:document ${namespaces} mc:Ignorable="x">`), "docx");
  if (result.format !== "docx") assert.fail();
  assert.deepEqual(result.blocks.map((b) => b.kind === "paragraph" && b.text), ["A", "C"]);
  assert.deepEqual(result.blocks.map((b) => b.location), ["本文 / 段落 1", "本文 / 段落 2"]);
  assert.ok(result.warnings.some((w) => w.includes("省略")));
});

it("商品化 S5-5/12: ルビは親文字と読みを区別し、空白の保存指定を尊重する", async () => {
  const body = '<w:p><w:r><w:t>  氏名： </w:t><w:ruby><w:rubyPr/><w:rt><w:r><w:t>やまだ</w:t></w:r></w:rt><w:rubyBase><w:r><w:t>山田</w:t></w:r></w:rubyBase></w:ruby><w:t xml:space="preserve"> 太郎  </w:t></w:r></w:p>';
  const bytes = wordBody(body + `<w:tbl><w:tr><w:tc>${body}</w:tc></w:tr></w:tbl>`), result = await parseOffice(bytes, "docx");
  if (result.format !== "docx" || result.blocks[0]?.kind !== "paragraph" || result.blocks[1]?.kind !== "table") assert.fail();
  assert.equal(result.blocks[0].text, "氏名：山田（やまだ） 太郎  ");
  assert.equal(result.blocks[1].rows[0]?.[0]?.text, result.blocks[0].text);
  assert.ok(result.warnings.some((w) => w.includes("ルビ")));
  assert.deepEqual(await parseOffice(bytes, "docx"), result);
});

it("商品化 S5-6/7/12/73: Excel保存文字列を一度だけ復号し、非表示列と保存数式を保持する", async () => {
  const bytes = zipEntries(excelEntries().map(([n, x]) => [n, n === "xl/worksheets/sheet1.xml"
    ? x.replace('<col min="2" max="4"', '<col hidden="1" min="2" max="4"').replace('<sheetData>', '<sheetData><row r="3"><c r="A3" t="inlineStr"><is><t>  _x005F_x000D_  </t></is></c><c r="B3" t="str"><f>_xlfn.CONCAT("a","b")</f><v>a_x000D_b</v></c><c r="C3" t="inlineStr"><is><t xml:space="preserve">_xD83D__xDE00_ _x0009_</t></is></c></row>')
    : n === "xl/sharedStrings.xml" ? x.replace('架空 太郎', '1行目_x000D_&#10;2行目') : x]));
  const result = await parseOffice(bytes, "xlsx"); if (result.format !== "xlsx") assert.fail();
  const cells = result.sheets[0]!.cells;
  assert.equal(cells.find((c) => c.address === "A3")?.value, "_x000D_");
  assert.equal(cells.find((c) => c.address === "B3")?.value, "a\rb");
  assert.equal(cells.find((c) => c.address === "C3")?.value, "😀 \t");
  assert.equal(cells.find((c) => c.address === "B2")?.value, "1行目\r\n2行目");
  assert.equal(cells.find((c) => c.address === "B3")?.formula, '_xlfn.CONCAT("a","b")');
  assert.equal(cells.find((c) => c.address === "B3")?.hiddenColumn, true);
  assert.equal(cells.find((c) => c.address === "A3")?.hiddenColumn, false);
  assert.ok(result.warnings.some((w) => w.includes("_xlfn.")));
  assert.deepEqual(await parseOffice(bytes, "xlsx"), result);
});

it("商品化 S5-15/16: 入れ子セルも総数上限に含み、超えた上限を名指す", async () => {
  const cell = '<w:tc><w:p/></w:tc>';
  const bytes = wordBody(`<w:tbl><w:tr><w:tc><w:tbl><w:tr>${cell.repeat(LIMITS.cells)}</w:tr></w:tbl></w:tc></w:tr></w:tbl>`);
  await assert.rejects(parseOffice(bytes, "docx"), (e: unknown) => e instanceof ParseError && e.code === "limit_exceeded" && /セル数/.test(e.message) && !/原本/.test(e.message));
});

it("商品化 S5-16: 出力の超過をセル数や原本サイズの超過と呼ばない", async () => {
  const bytes = wordBody(`<w:p><w:r><w:t>${"a".repeat(LIMITS.outputBytes)}</w:t></w:r></w:p>`);
  await assert.rejects(parseOffice(bytes, "docx"), (e: unknown) => e instanceof ParseError && e.code === "limit_exceeded" && /出力/.test(e.message) && !/セル/.test(e.message));
});

it("商品化 S5-12/16: xml:spaceの継承と解除、本文ブロック数の上限を検査する", async () => {
  const bytes = wordBody('<w:p xml:space="preserve"><w:r><w:t> 前 </w:t><w:t xml:space="default"> 中 </w:t><w:t> 後 </w:t></w:r></w:p>');
  const result = await parseOffice(bytes, "docx");
  if (result.format !== "docx" || result.blocks[0]?.kind !== "paragraph") assert.fail();
  assert.equal(result.blocks[0].text, " 前 中 後 ");
  await assert.rejects(parseOffice(wordBody("<w:p/>".repeat(LIMITS.blocks + 1)), "docx"), /本文ブロック数/);
});
