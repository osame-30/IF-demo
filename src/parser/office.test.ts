import { it } from "node:test";
import assert from "node:assert/strict";
import { parseOffice, ParseError } from "./office.ts";
import { parseInChildProcess, PARSER_CONFIG } from "./process.ts";
import { readFile } from "node:fs/promises";
import { LIMITS } from "./limits.ts";
import { wordSample, excelSample, wordEntries, excelEntries, zipEntries, W, wordControlledTableEntries, wordTabEntries, wordSymbolEntries, wordHiddenEntries } from "../../test/support/office-samples.ts";

it("⑤ Opus S5-4 property: 隠し文字設定の経路によらず本文を保持し、抽出方針と設定検出を区別する", async () => {
  for (const mode of ["none", "direct", "off", "character", "paragraph", "defaults"]) {
    const bytes = zipEntries(wordHiddenEntries(mode)), result = await parseOffice(bytes, "docx");
    if (result.format !== "docx" || result.blocks[0]?.kind !== "paragraph" || result.blocks[1]?.kind !== "table") assert.fail();
    assert.equal(result.blocks[0].text, "提出日 （記入例）令和6年5月1日");
    assert.equal(result.blocks[1].rows[0]?.[0]?.text, result.blocks[0].text);
    assert.equal(result.blocks[0].location, "本文 / 段落 1");
    assert.equal(result.blocks[1].rows[0]?.[0]?.location, "本文 / 表 1 / 行 1 / セル 1");
    assert.ok(result.warnings.some((w) => w.includes("隠し文字も含めて抽出")));
    assert.equal(result.warnings.some((w) => w.includes("隠し文字の設定を検出")), mode !== "none");
    assert.deepEqual(await parseOffice(bytes, "docx"), result);
  }
});

it("⑤ Opus S5-4: 実子プロセスでも隠し文字を保持し注意書きを返す", async () => {
  const bytes = zipEntries(wordHiddenEntries()), result = await parseInChildProcess(bytes, "docx");
  if (result.format !== "docx" || result.blocks[0]?.kind !== "paragraph") assert.fail();
  assert.equal(result.blocks[0].text, "提出日 （記入例）令和6年5月1日");
  assert.ok(result.warnings.some((w) => w.includes("隠し文字の設定を検出")));
  assert.deepEqual(await parseInChildProcess(bytes, "docx"), result);
});

it("⑤ Opus S5-3 property: 非改行ハイフンと未再現記号の位置・元情報を段落とセルで保持する", async () => {
  for (const [font, code] of [["Wingdings", "F0FC"], ["Symbol", "F061"], ["Fixture & Font", "0041"]]) {
    for (const wrapper of ["", "hyperlink", "ins", "moveTo"]) {
      const bytes = zipEntries(wordSymbolEntries(font, code, wrapper)), result = await parseOffice(bytes, "docx");
      if (result.format !== "docx" || result.blocks[0]?.kind !== "paragraph" || result.blocks[1]?.kind !== "table") assert.fail();
      const expected = `電話 03\u20111234\u20115678 確認［記号未再現（フォント: ${font} / コード: ${code}）］済`;
      assert.equal(result.blocks[0].text, expected);
      assert.equal(result.blocks[1].rows[0]?.[0]?.text, expected);
      assert.equal(result.blocks[0].location, "本文 / 段落 1");
      assert.equal(result.blocks[1].rows[0]?.[0]?.location, "本文 / 表 1 / 行 1 / セル 1");
      assert.equal(result.warnings.filter((w) => w.includes("記号未再現")).length, 1);
      assert.deepEqual(await parseOffice(bytes, "docx"), result);
    }
  }
});

it("⑤ Opus S5-3: 実子プロセスで記号の脱落を防ぎ、削除・移動元には未再現表示を加えない", async () => {
  const bytes = zipEntries(wordSymbolEntries()), result = await parseInChildProcess(bytes, "docx");
  if (result.format !== "docx" || result.blocks[0]?.kind !== "paragraph") assert.fail();
  assert.equal(result.blocks[0].text, "電話 03\u20111234\u20115678 確認［記号未再現（フォント: Wingdings / コード: F0FC）］済");
  assert.deepEqual(await parseInChildProcess(bytes, "docx"), result);
  for (const wrapper of ["del", "moveFrom"]) {
    const removed = await parseOffice(zipEntries(wordSymbolEntries("Wingdings", "F0FC", wrapper)), "docx");
    if (removed.format !== "docx" || removed.blocks[0]?.kind !== "paragraph" || removed.blocks[1]?.kind !== "table") assert.fail();
    assert.equal(removed.blocks[0].text, "");
    assert.equal(removed.blocks[1].rows[0]?.[0]?.text, "");
    assert.equal(removed.warnings.some((w) => w.includes("記号未再現")), false);
  }
});

it("⑤ Opus S5-2 property: タブ位置設定を変えても段落・セルの本文と実タブを保持する", async () => {
  for (const stops of [0, 2, 3]) for (const tabs of [0, 1, 2]) for (const tracked of [false, true]) {
    const bytes = zipEntries(wordTabEntries(stops, tabs, tracked));
    const result = await parseOffice(bytes, "docx");
    if (result.format !== "docx" || result.blocks[0]?.kind !== "paragraph" || result.blocks[1]?.kind !== "table") assert.fail();
    const expected = `氏名${"\t".repeat(tabs)}架空 太郎\n\t続き`;
    assert.equal(result.blocks[0].text, expected, `${stops}/${tabs}/${tracked}`);
    assert.equal(result.blocks[0].style, "見出し 1");
    assert.equal(result.blocks[0].location, "本文 / 段落 1");
    assert.equal(result.blocks[1].rows[0]?.[0]?.text, expected);
    assert.equal(result.blocks[1].rows[0]?.[0]?.location, "本文 / 表 1 / 行 1 / セル 1");
    assert.deepEqual(await parseOffice(bytes, "docx"), result);
  }
});

it("⑤ Opus S5-2: 実子プロセスでも配置設定と本文タブを区別する", async () => {
  const bytes = zipEntries(wordTabEntries(2, 1, true));
  const result = await parseInChildProcess(bytes, "docx");
  if (result.format !== "docx" || result.blocks[0]?.kind !== "paragraph" || result.blocks[1]?.kind !== "table") assert.fail();
  assert.equal(result.blocks[0].text, "氏名\t架空 太郎\n\t続き");
  assert.equal(result.blocks[1].rows[0]?.[0]?.text, result.blocks[0].text);
  assert.deepEqual(await parseInChildProcess(bytes, "docx"), result);
});

it("⑤ S5-72 property: 行・セルの包装16通りで内容と位置が変わらず、再解析も一致する", async () => {
  for (const row of ["none", "sdt", "customXml", "nested"]) for (const cell of ["none", "sdt", "customXml", "nested"]) {
    const bytes = zipEntries(wordControlledTableEntries(row, cell));
    const result = await parseOffice(bytes, "docx");
    if (result.format !== "docx" || result.blocks[0]?.kind !== "table") assert.fail();
    assert.deepEqual(result.blocks[0].rows.map((r) => r.map((c) => c.text)), [["A1", "A2", "A3"], ["B1", "B2", "B3"], ["C1", "C2", "C3"]], `${row}/${cell}`);
    for (const [r, cells] of result.blocks[0].rows.entries()) for (const [c, value] of cells.entries()) {
      assert.equal(value.location, `本文 / 表 1 / 行 ${r + 1} / セル ${c + 1}`);
    }
    assert.deepEqual(await parseOffice(bytes, "docx"), result);
  }
});

it("⑤ S5-72: 包装セルの入れ子表・削除履歴・結合情報を外側の行やセルへ混ぜない", async () => {
  const entries = wordControlledTableEntries("nested", "nested").map(([name, xml]): [string, string] => [name, name === "word/document.xml"
    ? xml.replace('<w:t>B2</w:t>', '<w:t>B2</w:t></w:r><w:del><w:r><w:delText>削除済み</w:delText></w:r></w:del><w:r><w:t></w:t>')
      .replace('<w:tc><w:p><w:r><w:t>B2', '<w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>B2')
      .replace('<w:t>B3</w:t></w:r></w:p>', '<w:t>B3</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>入れ子</w:t></w:r></w:p></w:tc></w:tr></w:tbl>')
    : xml]);
  const bytes = zipEntries(entries), result = await parseInChildProcess(bytes, "docx");
  if (result.format !== "docx" || result.blocks[0]?.kind !== "table") assert.fail();
  assert.equal(result.blocks.length, 1);
  assert.deepEqual(result.blocks[0].rows.map((r) => r.map((c) => c.text)), [["A1", "A2", "A3"], ["B1", "B2", "B3\n入れ子"], ["C1", "C2", "C3"]]);
  assert.equal(result.blocks[0].rows[1]?.[1]?.columnSpan, 2);
  assert.equal(result.blocks[0].rows[1]?.[1]?.verticalMerge, "restart");
  assert.ok(result.warnings.some((w) => w.includes("入れ子")));
  assert.ok(result.warnings.some((w) => w.includes("変更履歴")));
  assert.deepEqual(await parseInChildProcess(bytes, "docx"), result);
});

it("⑤ S5-72: 包装内のセルも既存のセル上限に含める", async () => {
  const cell = '<w:sdt><w:sdtContent><w:tc><w:p><w:r><w:t>x</w:t></w:r></w:p></w:tc></w:sdtContent></w:sdt>';
  for (const count of [LIMITS.cells, LIMITS.cells + 1]) {
    const bytes = zipEntries(wordEntries().map(([name, xml]) => [name, name === "word/document.xml"
      ? xml.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body><w:tbl><w:tr>${cell.repeat(count)}</w:tr></w:tbl></w:body>`)
      : xml]));
    if (count > LIMITS.cells) await assert.rejects(parseOffice(bytes, "docx"), (e: unknown) => e instanceof ParseError && e.code === "limit_exceeded");
    else {
      const result = await parseOffice(bytes, "docx");
      if (result.format !== "docx" || result.blocks[0]?.kind !== "table") assert.fail();
      assert.equal(result.blocks[0].rows[0]?.length, count);
    }
  }
});

it("⑤ property: 入力文を変えても、二度の抽出内容・順序・位置が一致する", async () => {
  let seed = 617;
  const chars = ["日", "本", " ", "é", "e\u0301", "😀", "&", "<", ">", "0", "\t"];
  for (let i = 0; i < 20; i++) {
    let text = "";
    for (let j = 0; j < 30; j++) { seed = (seed * 1664525 + 1013904223) >>> 0; text += chars[seed % chars.length]; }
    const bytes = wordSample(text), first = await parseOffice(bytes, "docx");
    assert.deepEqual(await parseOffice(bytes, "docx"), first);
    assert.equal(first.format, "docx");
    if (first.format !== "docx") assert.fail();
    assert.equal(first.blocks[1]?.kind === "paragraph" && first.blocks[1].text, text);
    assert.deepEqual(first.blocks.map((b) => b.kind), ["paragraph", "paragraph", "table", "paragraph"]);
    const table = first.blocks[2]; assert.equal(table?.kind, "table");
    if (table?.kind !== "table") assert.fail();
    assert.equal(table.rows[1]?.[1]?.text, "当日の記録と連絡メモ");
    assert.equal(table.rows[1]?.[1]?.location, "本文 / 表 1 / 行 2 / セル 2");
  }
});
it("⑤ Excel: 非表示シート・セル位置・文字列の0・書式・数式と未保存結果を区別する", async () => {
  const result = await parseOffice(excelSample(), "xlsx");
  if (result.format !== "xlsx") assert.fail();
  assert.deepEqual(result.sheets.map((s) => s.name), ["履歴書", "確認用"]);
  assert.equal(result.sheets[0]?.cells.find((c) => c.address === "B2")?.value, "架空 太郎");
  const code = result.sheets[0]?.cells.find((c) => c.address === "B7");
  assert.equal(code?.value, "123"); assert.equal(code?.numberFormat, "000000");
  assert.equal(result.sheets[0]?.cells.find((c) => c.address === "B8")?.value, "00123");
  assert.deepEqual(result.sheets[0]?.merges, ["A1:D1"]);
  const hidden = result.sheets[1]!; assert.equal(hidden.state, "hidden");
  assert.equal(hidden.cells[2]?.formula, "SUM(A1:B1)"); assert.equal(hidden.cells[2]?.value, "1500");
  assert.equal(hidden.cells[3]?.value, null); assert.equal(hidden.cells[4]?.hiddenRow, true);
  assert.ok(result.warnings.some((w) => w.includes("計算結果のない")));
  assert.deepEqual(await parseOffice(excelSample(), "xlsx"), result);
});
it("⑤ 実際の子プロセス二回でも抽出結果が一致する", async () => {
  for (const format of ["docx", "xlsx"] as const) {
    const bytes = format === "docx" ? wordSample() : excelSample();
    const result = await parseInChildProcess(bytes, format);
    assert.deepEqual(await parseInChildProcess(bytes, format), result);
    assert.deepEqual(result, await parseOffice(bytes, format));
  }
});
it("⑤ 壊れたZIP・XML・DTD・深すぎる構造・重複部品を成功にしない", async () => {
  const entries = wordEntries();
  const withDocument = (document: string) => zipEntries(entries.map(([name, value]) => [name, name === "word/document.xml" ? document : value]));
  for (const bytes of [Buffer.from("broken"), wordSample().subarray(0, 100), zipEntries([...entries, entries[0]!]),
    withDocument(`<w:document xmlns:w="${W}"><w:body></w:document>`),
    withDocument(`<!DOCTYPE document [<!ENTITY x "unsafe">]><w:document xmlns:w="${W}"><w:body/></w:document>`),
    withDocument(`<w:document xmlns:w="${W}">${"<w:body>".repeat(65)}${"</w:body>".repeat(65)}</w:document>`)]) {
    await assert.rejects(parseOffice(bytes, "docx"), ParseError);
  }
});
it("⑤ Excel: 外部参照・壊れた文字列参照・重複セルを拒む", async () => {
  for (const mutate of [
    (name: string, text: string) => name.endsWith("workbook.xml.rels") ? text.replace('Target="worksheets/sheet1.xml"', 'Target="https://invalid.example/sheet.xml" TargetMode="External"') : text,
    (name: string, text: string) => name.endsWith("sheet1.xml") ? text.replace("<v>0</v>", "<v>999</v>") : text,
    (name: string, text: string) => name.endsWith("sheet1.xml") ? text.replace('r="B2"', 'r="A2"') : text,
  ]) await assert.rejects(parseOffice(zipEntries(excelEntries().map(([n, t]) => [n, mutate(n, t)])), "xlsx"), ParseError);
});
it("⑤ Word: 名前空間の接頭辞変更とUTF-16保存で文章を失わない", async () => {
  const entries = wordEntries().map(([n, text]): [string, string | Buffer] => [n, n === "word/document.xml" ? Buffer.from('\uFEFF' + text.replaceAll("w:", "q:").replace("xmlns:w", "xmlns:q"), "utf16le") : text]);
  assert.deepEqual(await parseOffice(zipEntries(entries), "docx"), await parseOffice(wordSample(), "docx"));
});
it("⑤ Word: 表の中の削除履歴と代替内容を現在の文章へ混ぜない", async () => {
  const document = `<w:document xmlns:w="${W}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:body><w:tbl><w:tr><w:tc><w:del><w:p><w:r><w:t>消した内容</w:t></w:r></w:p></w:del><w:p><w:r><w:t>現在の内容</w:t></w:r></w:p></w:tc></w:tr></w:tbl><mc:AlternateContent><mc:Choice Requires="w"><w:p><w:r><w:t>代替1</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>代替2</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent></w:body></w:document>`;
  const result = await parseOffice(zipEntries(wordEntries().map(([n, x]) => [n, n === "word/document.xml" ? document : x])), "docx");
  if (result.format !== "docx" || result.blocks[0]?.kind !== "table") assert.fail();
  assert.equal(result.blocks.length, 1); assert.equal(result.blocks[0].rows[0]?.[0]?.text, "現在の内容");
  assert.ok(result.warnings.some((w) => w.includes("変更履歴")));
  assert.ok(result.warnings.some((w) => w.includes("代替要素")));
});
it("⑤ 依存版は解析キーの設定とpackage-lockの実体で一致する", async () => {
  const lock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
  for (const [name, version] of Object.entries(PARSER_CONFIG.dependencies)) assert.equal(lock.packages[`node_modules/${name}`].version, version);
});
