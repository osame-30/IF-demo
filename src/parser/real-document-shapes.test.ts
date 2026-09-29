/** 実資料でよく使う形（履歴書のチェック欄・和暦の表・労災の様式）を通し、照合できるかを見る。
 *  題材はすべて架空。私有資料の内容・パスは置かない。 */
import { it } from "node:test";
import assert from "node:assert/strict";
import { parseOffice } from "./office.ts";
import { wordEntries, excelEntries, zipEntries, S, R, P } from "../../test/support/office-samples.ts";

const wordBody = (body: string) => zipEntries(wordEntries().map(([n, x]) => [n, n === "word/document.xml" ? x.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${body}</w:body>`) : x]));
const paragraphs = async (body: string) => {
  const result = await parseOffice(wordBody(body), "docx");
  if (result.format !== "docx") assert.fail("docxとして読めていない");
  return { texts: result.blocks.flatMap((b) => b.kind === "paragraph" ? [b.text] : []), warnings: result.warnings };
};

it("実資料 記号: 私用領域のチェック欄をw:symと同じ注記に揃える", async () => {
  // 履歴書のチェック欄は w:sym にも、記号フォント付きの w:t の私用領域文字にもなる。
  // 同じ見た目の2つが、片方だけ無言で消えると照合できない。
  const bySym = `<w:p><w:r><w:sym w:font="Wingdings" w:char="F0FE"/></w:r><w:r><w:t>扶養家族あり</w:t></w:r></w:p>`;
  const byText = `<w:p><w:r><w:rPr><w:rFonts w:ascii="Wingdings" w:hAnsi="Wingdings"/></w:rPr><w:t></w:t></w:r><w:r><w:t>扶養家族あり</w:t></w:r></w:p>`;
  const sym = await paragraphs(bySym), text = await paragraphs(byText);
  assert.deepEqual(text.texts, sym.texts);
  assert.match(text.texts[0]!, /記号未再現（フォント: Wingdings \/ コード: F0FE）/);
  assert.ok(text.warnings.some((w) => w.includes("記号未再現")), "注記の説明を画面へ出す");
  // チェック済みと未チェックが同じ文字列に潰れない。
  const empty = await paragraphs(byText.replace("", ""));
  assert.notEqual(empty.texts[0], text.texts[0]);
  assert.match(empty.texts[0]!, /コード: F0A8/);
});

it("実資料 記号: 私用領域でない本文と、書体のない私用領域を取り違えない", async () => {
  const plain = await paragraphs(`<w:p><w:r><w:t>氏名は山田です。</w:t></w:r></w:p>`);
  assert.deepEqual(plain.texts, ["氏名は山田です。"]);
  assert.ok(!plain.warnings.some((w) => w.includes("記号未再現")), "普通の本文で注記を出さない");
  // 外字のように書体指定がない私用領域も、位置と符号だけは残す。
  const gaiji = await paragraphs(`<w:p><w:r><w:t>様</w:t></w:r></w:p>`);
  assert.equal(gaiji.texts[0], "［記号未再現（フォント: 未指定 / コード: E000）］様");
});

it("実資料 自動番号: 採番と行頭記号を補わないことを画面で断る", async () => {
  const numbered = `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>普通自動車第一種運転免許</w:t></w:r></w:p>`;
  const { texts, warnings } = await paragraphs(numbered);
  assert.deepEqual(texts, ["普通自動車第一種運転免許"], "番号を本文へ作らない");
  assert.ok(warnings.some((w) => w.includes("自動採番")), "番号が出ない理由を残す");
  const plain = await paragraphs(`<w:p><w:r><w:t>普通自動車第一種運転免許</w:t></w:r></w:p>`);
  assert.ok(!plain.warnings.some((w) => w.includes("自動採番")), "採番のない資料では出さない");
});

it("実資料 フィールド: 表示するのが保存済みの結果であることを断る", async () => {
  const field = `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> DATE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>令和6年5月1日</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
  const { texts, warnings } = await paragraphs(field);
  assert.deepEqual(texts, ["令和6年5月1日"], "命令文を本文に混ぜず、保存結果だけを出す");
  assert.ok(warnings.some((w) => w.includes("フィールド")), "古い可能性を残す");
});

const CT = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
/** 組み込み書式は styles.xml に formatCode を持たない。実資料の日付・通貨はこの形で保存される。 */
async function formatted(ids: string[], values: string[], extraFormats = "") {
  const xfs = ids.map((id) => `<xf numFmtId="${id}"/>`).join("");
  const rows = values.map((v, i) => `<row r="${i + 1}"><c r="A${i + 1}" s="${i}"><v>${v}</v></c></row>`).join("");
  const book = zipEntries([
    ["[Content_Types].xml", CT],
    ["_rels/.rels", `<Relationships xmlns="${P}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="計算" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<Relationships xmlns="${P}"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rIdS" Type="${R}/styles" Target="styles.xml"/></Relationships>`],
    ["xl/styles.xml", `<styleSheet xmlns="${S}">${extraFormats}<cellXfs count="${ids.length}">${xfs}</cellXfs></styleSheet>`],
    ["xl/worksheets/sheet1.xml", `<worksheet xmlns="${S}"><sheetData>${rows}</sheetData></worksheet>`],
  ]);
  const result = await parseOffice(book, "xlsx");
  if (result.format !== "xlsx") assert.fail("xlsxとして読めていない");
  return { cells: result.sheets[0]!.cells, warnings: result.warnings };
}

it("実資料 書式: 組み込み番号を仕様の書式コードとして報告する", async () => {
  // 14=日付 38=桁区切り 9=百分率 20=時刻。番号のままでは原本と突き合わせられない。
  const { cells } = await formatted(["14", "38", "9", "20", "0"], ["45413", "9876543", "0.6", "0.39", "12"]);
  assert.deepEqual(cells.map((c) => c.numberFormat), ["mm-dd-yy", "#,##0_);[Red](#,##0)", "0%", "h:mm", "General"]);
  assert.deepEqual(cells.map((c) => c.value), ["45413", "9876543", "0.6", "0.39", "12"], "保存値を書式で置き換えない");
});

it("実資料 書式: 独自の書式コードは組み込み表より優先する", async () => {
  const numFmts = `<numFmts count="1"><numFmt numFmtId="14" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/></numFmts>`;
  const { cells, warnings } = await formatted(["14"], ["45413"], numFmts);
  assert.equal(cells[0]!.numberFormat, 'yyyy"年"m"月"d"日"');
  assert.ok(warnings.some((w) => w.includes("連番")), "独自の日付書式でも連番であることを断る");
});

it("実資料 書式: 和暦などの地域依存の番号は書式コードを名乗らない", async () => {
  // 27〜36 は和暦を含む地域依存。仕様が形を固定していないので推測しない。
  const { cells, warnings } = await formatted(["27"], ["45413"]);
  assert.match(cells[0]!.numberFormat, /組み込み書式 27（地域依存/);
  assert.ok(warnings.some((w) => w.includes("連番")), "地域依存でも連番であることは断る");
});

it("実資料 書式: 日付でない書式を連番として警告しない", async () => {
  const { warnings } = await formatted(["38", "9", "49"], ["9876543", "0.6", "1"]);
  assert.ok(!warnings.some((w) => w.includes("連番")), "桁区切り・百分率・文字列を日付と呼ばない");
});

it("実資料 書式: 既存の合成資料の保存書式が変わっていない", async () => {
  const result = await parseOffice(zipEntries(excelEntries()), "xlsx");
  if (result.format !== "xlsx") assert.fail();
  const cell = result.sheets[0]!.cells.find((c) => c.address === "B7");
  assert.equal(cell?.numberFormat, "000000", "独自書式はそのまま");
});
