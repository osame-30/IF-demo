import { it } from "node:test";
import assert from "node:assert/strict";
import { parseOffice } from "./office.ts";
import { parseInChildProcess, PARSER_VERSION } from "./process.ts";
import { LIMITS } from "./limits.ts";
import { excelExtensionEntries, excelEntries, wordEntries, zipEntries, S } from "../../test/support/office-samples.ts";

const names = ["xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml"];
for (const part of names) it(`Excel extLst: ${part} の拡張を省略し保存値・数式・書式を保持する`, async () => {
  const expected = await parseOffice(zipEntries(excelEntries()), "xlsx");
  const result = await parseOffice(zipEntries(excelExtensionEntries([part])), "xlsx");
  assert.equal(result.format, "xlsx"); assert.equal(expected.format, "xlsx");
  if (result.format !== "xlsx" || expected.format !== "xlsx") assert.fail();
  assert.deepEqual(result.sheets, expected.sheets);
  assert.ok(result.warnings.some((w) => w.includes("未対応の拡張・代替要素を省略")));
});

it("Excel extLst: 実子プロセスで全拡張を一つの具体的な警告にまとめ、繰り返しの結果が一致する", async () => {
  assert.equal(PARSER_VERSION, "office-xml-9");
  const bytes = zipEntries(excelExtensionEntries());
  const result = await parseInChildProcess(bytes, "xlsx");
  assert.deepEqual(await parseInChildProcess(bytes, "xlsx"), result);
  const expected = await parseOffice(zipEntries(excelEntries()), "xlsx");
  if (result.format !== "xlsx" || expected.format !== "xlsx") assert.fail();
  assert.deepEqual(result.sheets, expected.sheets);
  const omitted = result.warnings.filter((w) => w.includes("未対応の拡張・代替要素を省略"));
  assert.equal(omitted.length, 1);
  assert.match(omitted[0]!, /ブック設定/);
  assert.match(omitted[0]!, /書式/);
  assert.match(omitted[0]!, /シート「履歴書」/);
});

it("Excel extLst: 省略の外側と偽の名前空間は引き続き拒否する（S5-10）", async () => {
  for (const part of names) for (const element of ['<unknown xmlns="urn:unsupported"/>', '<extLst xmlns="urn:unsupported"><ext/></extLst>']) {
    const entries = excelExtensionEntries().map(([name, xml]): [string, string] => [name, name === part ? xml.replace(/(<\/[^>]+>)$/, `${element}$1`) : xml]);
    await assert.rejects(parseOffice(zipEntries(entries), "xlsx"), /未対応の名前空間/);
  }
  // Excelの受理拡張を、Word本文の未知要素を隠す口にしない。
  const word = wordEntries().map(([name, xml]): [string, string] => [name, name === "word/document.xml" ? xml.replace('</w:body>', `<s:extLst xmlns:s="${S}"><unknown xmlns="urn:unsupported"/></s:extLst></w:body>`) : xml]);
  await assert.rejects(parseOffice(zipEntries(word), "docx"), /未対応の名前空間/);
});

it("Excel extLst: 省略部分にもXML深度上限とDTD拒否を適用する", async () => {
  for (const content of [`<extLst>${'<x>'.repeat(LIMITS.depth)}${'</x>'.repeat(LIMITS.depth)}</extLst>`, '<extLst><ext></extLst>']) {
    const entries = excelEntries().map(([name, xml]): [string, string] => [name, name === names[0] ? xml.replace('</workbook>', `${content}</workbook>`) : xml]);
    await assert.rejects(parseOffice(zipEntries(entries), "xlsx"));
  }
  const entries = excelExtensionEntries().map(([name, xml]): [string, string] => [name, name === names[0] ? `<!DOCTYPE workbook [<!ENTITY value "fixture">]>${xml}` : xml]);
  await assert.rejects(parseOffice(zipEntries(entries), "xlsx"), /DTD/);
});
