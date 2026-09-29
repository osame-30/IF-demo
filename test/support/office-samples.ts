/** 個人資料を含まない固定のOfficeコーパス。ZIPの生成を読取実装から独立させる。 */
import { deflateRawSync } from "node:zlib";
export function zipEntries(entries: ReadonlyArray<readonly [string, string | Buffer]>, extra = Buffer.alloc(0)): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name), bytes = Buffer.from(value), packed = deflateRawSync(bytes);
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    local.writeUInt16LE(extra.length, 28);
    locals.push(local, filename, extra, packed);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(33, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(bytes.length, 24); c.writeUInt16LE(filename.length, 28); c.writeUInt32LE(offset, 42); central.push(c, filename);
    c.writeUInt16LE(extra.length, 30); central.push(extra);
    offset += local.length + filename.length + extra.length + packed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const escapeXml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
export const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const P = "http://schemas.openxmlformats.org/package/2006/relationships";
export function wordEntries(text = "これは架空の労災資料です。手続きの案内ではありません。") : [string, string][] {
  return [
    ["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'],
    ["_rels/.rels", `<Relationships xmlns="${P}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`],
    ["word/_rels/document.xml.rels", `<Relationships xmlns="${P}"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/></Relationships>`],
    ["word/styles.xml", `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="見出し 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style></w:styles>`],
    ["word/document.xml", `<w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>労災に関する記録（架空サンプル）</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single"/><w:left w:val="single"/><w:bottom w:val="single"/><w:right w:val="single"/><w:insideH w:val="single"/><w:insideV w:val="single"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="2400"/><w:gridCol w:w="6000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>項目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>記録</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>確認資料</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>当日の記録と連絡メモ</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>原本の文章と表を見比べてください。</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`],
  ];
}
export function excelEntries(label = "架空 太郎"): [string, string][] {
  return [
    ["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ["_rels/.rels", `<Relationships xmlns="${P}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ["xl/workbook.xml", `<workbook xmlns="${S}" xmlns:r="${R}"><workbookPr date1904="0"/><sheets><sheet name="履歴書" sheetId="1" r:id="rId1"/><sheet name="確認用" sheetId="2" state="hidden" r:id="rId2"/></sheets><calcPr calcId="0" fullCalcOnLoad="1"/></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<Relationships xmlns="${P}"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="strings" Type="${R}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="styles" Type="${R}/styles" Target="styles.xml"/></Relationships>`],
    ["xl/sharedStrings.xml", `<sst xmlns="${S}" count="2" uniqueCount="2"><si><t>氏名（架空）</t></si><si><r><t>${escapeXml(label)}</t></r></si></sst>`],
    ["xl/styles.xml", `<styleSheet xmlns="${S}"><numFmts count="1"><numFmt numFmtId="164" formatCode="000000"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
    ["xl/worksheets/sheet1.xml", `<worksheet xmlns="${S}"><cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="4" width="30" customWidth="1"/></cols><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>履歴書（架空サンプル）</t></is></c></row><row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>1</v></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>2020年4月</t></is></c><c r="B4" t="inlineStr"><is><t>サンプル株式会社 入社</t></is></c></row><row r="5"><c r="A5" t="inlineStr"><is><t>2024年3月</t></is></c><c r="B5" t="inlineStr"><is><t>同社 退職</t></is></c></row><row r="7"><c r="A7" t="inlineStr"><is><t>管理番号（保存値）</t></is></c><c r="B7" s="1"><v>123</v></c></row><row r="8"><c r="A8" t="inlineStr"><is><t>文字列の番号</t></is></c><c r="B8" t="inlineStr"><is><t>00123</t></is></c></row></sheetData><mergeCells count="1"><mergeCell ref="A1:D1"/></mergeCells></worksheet>`],
    ["xl/worksheets/sheet2.xml", `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1"><v>1200</v></c><c r="B1"><v>300</v></c><c r="C1"><f>SUM(A1:B1)</f><v>1500</v></c><c r="D1"><f>SUM(A1:C1)</f></c></row><row r="2" hidden="1"><c r="A2" t="b"><v>1</v></c><c r="B2" t="e"><v>#DIV/0!</v></c></row></sheetData></worksheet>`],
  ];
}
export const wordSample = (text?: string) => zipEntries(wordEntries(text));
export const excelSample = (label?: string) => zipEntries(excelEntries(label));

/** Microsoft 365 の保存形。拡張だけを着脱し、セル・数式・書式が変わらないことを比較する。 */
export function excelExtensionEntries(parts: readonly string[] = ["xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml"]): [string, string][] {
  const extensions: Record<string, string> = {
    "xl/workbook.xml": '<extLst><ext uri="{140A7094-0E35-4892-8432-C4D2E57EDEB5}" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main"><x15:workbookPr chartTrackingRefBase="1"/></ext><ext uri="{B58B0392-4F1F-4190-BB64-5DF3571DCE5F}" xmlns:xcalcf="http://schemas.microsoft.com/office/spreadsheetml/2018/calcfeatures"><xcalcf:calcFeatures><xcalcf:feature name="microsoft.com:RD"/></xcalcf:calcFeatures></ext></extLst>',
    "xl/styles.xml": '<extLst><ext uri="{EB79DEF2-80B8-43e5-95BD-54CBDDF9020C}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:slicerStyles defaultSlicerStyle="SlicerStyleLight1"/></ext><ext uri="{9260A510-F301-46a8-8635-F512D64BE5F5}" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main"><x15:timelineStyles defaultTimelineStyle="TimeSlicerStyleLight1"/></ext></extLst>',
    "xl/worksheets/sheet1.xml": '<extLst><ext uri="fixture" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:conditionalFormattings/><x14:dataValidations/><sheetData><row r="999"><c r="A999"><v>999</v></c></row></sheetData></ext></extLst>',
  };
  return excelEntries().map(([name, xml]) => {
    if (name === "xl/workbook.xml") xml = xml.replace('<workbook ', '<workbook xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" mc:Ignorable="xr" ').replace('</workbook>', '<mc:AlternateContent><mc:Choice Requires="x15ac"><x15ac:absPath url="C:\\synthetic\\"/></mc:Choice></mc:AlternateContent><xr:revisionPtr revIDLastSave="0"/></workbook>');
    if (parts.includes(name)) xml = xml.replace(/(<\/[^>]+>)$/, `${extensions[name]}$1`);
    return [name, xml];
  });
}

/** Opus S5-4: 直接設定だけでなくスタイル・既定値にも隠し文字設定を置く。 */
export function wordHiddenEntries(mode = "direct"): [string, string][] {
  const runProps = mode === "direct" ? "<w:vanish/>" : mode === "off" ? '<w:vanish w:val="0"/>' : mode === "character" ? '<w:rStyle w:val="HiddenChar"/>' : "";
  const paragraph = `<w:p>${mode === "paragraph" ? '<w:pPr><w:pStyle w:val="HiddenPara"/></w:pPr>' : ""}<w:r><w:t xml:space="preserve">提出日 </w:t></w:r><w:r><w:rPr>${runProps}</w:rPr><w:t>（記入例）</w:t></w:r><w:r><w:t>令和6年5月1日</w:t></w:r></w:p>`;
  return wordEntries().map(([name, xml]) => {
    if (name === "word/document.xml") return [name, xml.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${paragraph}<w:tbl><w:tr><w:tc>${paragraph}</w:tc></w:tr></w:tbl></w:body>`)];
    if (name === "word/styles.xml") {
      const style = mode === "character" ? '<w:style w:type="character" w:styleId="HiddenChar"><w:rPr><w:vanish/></w:rPr></w:style>'
        : mode === "paragraph" ? '<w:style w:type="paragraph" w:styleId="HiddenPara"><w:rPr><w:vanish/></w:rPr></w:style>'
        : mode === "defaults" ? '<w:docDefaults><w:rPrDefault><w:rPr><w:vanish/></w:rPr></w:rPrDefault></w:docDefaults>' : "";
      return [name, xml.replace(/(<w:styles[^>]*>)/, `$1${style}`)];
    }
    return [name, xml];
  });
}

/** Opus S5-3: 電話番号とフォント依存記号を本文・表セルの両経路に置く。 */
export function wordSymbolEntries(font = "Wingdings", code = "F0FC", wrapper = ""): [string, string][] {
  const run = `<w:r><w:t>電話 03</w:t><w:noBreakHyphen/><w:t>1234</w:t><w:noBreakHyphen/><w:t>5678 確認</w:t><w:sym w:font="${escapeXml(font)}" w:char="${escapeXml(code)}"/><w:t>済</w:t></w:r>`;
  const paragraph = `<w:p>${wrapper ? `<w:${wrapper}>${run}</w:${wrapper}>` : run}</w:p>`;
  return wordEntries().map(([name, xml]) => [name, name === "word/document.xml"
    ? xml.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${paragraph}<w:tbl><w:tr><w:tc>${paragraph}</w:tc></w:tr></w:tbl></w:body>`)
    : xml]);
}

/** Opus S5-2: 配置設定の数だけを変えても、本文とセルの実タブは変わらない。 */
export function wordTabEntries(stops = 2, tabs = 1, tracked = false): [string, string][] {
  const settings = `<w:tabs>${Array.from({ length: stops }, (_, i) => `<w:tab w:val="${i === 2 ? "clear" : "left"}" w:pos="${2000 * (i + 1)}"/>`).join("")}</w:tabs>`;
  const paragraph = `<w:p><w:pPr><w:pStyle w:val="Heading1"/>${settings}${tracked ? `<w:pPrChange w:id="1" w:author="Fixture"><w:pPr>${settings}</w:pPr></w:pPrChange>` : ""}</w:pPr><w:r><w:t>氏名</w:t>${"<w:tab/>".repeat(tabs)}<w:t>架空 太郎</w:t><w:br/><w:tab/><w:t>続き</w:t></w:r></w:p>`;
  return wordEntries().map(([name, xml]) => [name, name === "word/document.xml"
    ? xml.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body>${paragraph}<w:tbl><w:tr><w:tc>${paragraph}</w:tc></w:tr></w:tbl></w:body>`)
    : xml]);
}

/** S5-72 / Opus S5-1: 行とセルの包装を独立に変えて、同じ3×3表を保持する。 */
export function wordControlledTableEntries(rowWrapper = "sdt", cellWrapper = "sdt"): [string, string][] {
  const wrap = (xml: string, kind: string): string => {
    if (kind === "sdt") return `<w:sdt><w:sdtPr/><w:sdtContent>${xml}</w:sdtContent></w:sdt>`;
    if (kind === "customXml") return `<w:customXml w:uri="urn:fixture" w:element="field">${xml}</w:customXml>`;
    if (kind === "nested") return wrap(wrap(xml, "sdt"), "customXml");
    return xml;
  };
  const rows = ["A", "B", "C"].map((label, r) => {
    const cells = [1, 2, 3].map((c) => {
      const cell = `<w:tc><w:p><w:r><w:t>${label}${c}</w:t></w:r></w:p></w:tc>`;
      return r === 1 && c === 2 ? wrap(cell, cellWrapper) : cell;
    }).join("");
    const row = `<w:tr>${cells}</w:tr>`;
    return r === 1 ? wrap(row, rowWrapper) : row;
  }).join("");
  return wordEntries().map(([name, xml]) => [name, name === "word/document.xml"
    ? xml.replace(/<w:body>[\s\S]*<\/w:body>/, `<w:body><w:tbl>${rows}</w:tbl></w:body>`)
    : xml]);
}
