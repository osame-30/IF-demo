/** Office の保存内容を読む。数式・マクロ・外部リンクは実行しない。 */
import { fromBuffer } from "yauzl";
import type { Entry, ZipFile } from "yauzl";
import { SaxesParser } from "saxes";
import { posix } from "node:path";
import type { ParsedDocument, WordParagraph, WordTable, ParsedSheet, SheetCell } from "../domain/parsed-document.ts";
import { LIMITS } from "./limits.ts";

export class ParseError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const fail = (message: string): never => { throw new ParseError("invalid_document", message); };
const limit = (kind: keyof typeof LIMITS): never => {
  const labels = { inputBytes: "原本バイト数", expandedBytes: "展開バイト数", entries: "部品数", nodes: "XMLノード数", depth: "XMLの深さ", cells: "セル数", blocks: "本文ブロック数", outputBytes: "解析結果の出力バイト数", timeoutMs: "解析時間（ミリ秒）" };
  throw new ParseError("limit_exceeded", `${labels[kind]}の上限（${LIMITS[kind]}）を超えました。資料を分けて取り込んでください。`);
};

async function parts(bytes: Buffer): Promise<Map<string, Buffer>> {
  if (bytes.length > LIMITS.inputBytes) limit("inputBytes");
  const zip = await new Promise<ZipFile>((resolve, reject) => fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value!)));
  // アーカイブをファイルシステムへ展開しない。実際に展開したバイト数も数える。
  return new Promise((resolve, reject) => {
    const result = new Map<string, Buffer>(), names = new Set<string>();
    let total = 0, finished = false;
    const abort = (error: unknown) => { if (!finished) { finished = true; zip.close(); reject(error); } };
    zip.on("error", abort);
    zip.on("end", () => { if (!finished) { finished = true; resolve(result); } });
    zip.on("entry", (entry: Entry) => { void (async () => {
      // S5-8/10: Officeと解釈が分かれる別名指定・大文字小文字の重複を受け入れない。
      if (entry.extraFields.some((field) => field.id === 0x7075)) fail("ZIPのUnicode別名指定を含む資料には対応していません。");
      const canonicalName = entry.fileName.toLowerCase();
      if (names.has(canonicalName)) fail("ZIP内で部品名が重複しています（大文字小文字の違いを含む）。");
      names.add(canonicalName);
      if (names.size > LIMITS.entries) limit("entries");
      if (entry.uncompressedSize > LIMITS.expandedBytes) limit("expandedBytes");
      if (entry.generalPurposeBitFlag & 1) throw new ParseError("encrypted", "暗号化された資料には対応していません。");
      if (entry.fileName.endsWith("/")) { zip.readEntry(); return; }
      // 画像を含むすべての部品を読み、宣言値だけで展開量を信じない。
      const stream = await new Promise<import("node:stream").Readable>((resolve, reject) => zip.openReadStream(entry, (error, value) => error ? reject(error) : resolve(value!)));
      const keep = /(?:\.xml|\.rels)$/.test(entry.fileName), chunks: Buffer[] = [];
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk); total += bytes.length;
        if (total > LIMITS.expandedBytes) { stream.destroy(); limit("expandedBytes"); }
        if (keep) chunks.push(bytes);
      }
      if (keep) result.set(entry.fileName, Buffer.concat(chunks));
      if (!finished) zip.readEntry();
    })().catch(abort); });
    zip.readEntry();
  });
}

interface X { name: string; uri: string; attrs: Record<string, string>; children: X[]; text: string; space: string; skip: boolean; omitted: boolean; ignorable: Set<string> }
const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const SHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const XML = "http://www.w3.org/XML/1998/namespace";
const understood = new Set([WORD, SHEET, REL, OFFICE_REL, CT, MC, XML, "http://www.w3.org/2000/xmlns/", ""]);
const opaque = new Set(["http://schemas.openxmlformats.org/drawingml/2006/main", "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing", "http://schemas.openxmlformats.org/drawingml/2006/picture", "http://schemas.openxmlformats.org/officeDocument/2006/math", "urn:schemas-microsoft-com:vml", "urn:schemas-microsoft-com:office:office", "urn:schemas-microsoft-com:office:word"]);
const children = (x: X | undefined, name: string, uri?: string): X[] => x?.children.filter((c) => !c.skip && c.name === name && (uri === undefined || c.uri === uri)) ?? [];
const child = (x: X | undefined, name: string, uri?: string) => children(x, name, uri)[0];
const descendants = (x: X, name: string, uri?: string): X[] => x.children.flatMap((c) => c.skip ? [] : [...(c.name === name && (uri === undefined || c.uri === uri) ? [c] : []), ...descendants(c, name, uri)]);
const attr = (x: X | undefined, name: string, uri = "") => x?.attrs[`${uri}|${name}`] ?? "";
const wval = (x: X | undefined) => attr(x, "val", WORD);
// S5-6/12: XMLの保存指定を適用してから、一度だけUTF-16のエスケープを復号する。
const savedText = (x: X) => x.space === "preserve" ? x.text : x.text.replace(/^[\x20\t\r\n]+|[\x20\t\r\n]+$/g, "");
const xstring = (s: string) => s.replace(/_x([0-9a-fA-F]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
function xml(data: Map<string, Buffer>, name: string, uri: string, rootName: string): X {
  const bytes = data.get(name);
  if (!bytes) return fail(`必要な部品 ${name} がありません。`);
  // UTF-16 は保存形式として許可する。DTD・外部実体の拡張は許可しない。
  let encoding = "utf-8";
  if ((bytes[0] === 255 && bytes[1] === 254) || (bytes[0] === 60 && bytes[1] === 0)) encoding = "utf-16le";
  if ((bytes[0] === 254 && bytes[1] === 255) || (bytes[0] === 0 && bytes[1] === 60)) encoding = "utf-16be";
  const source = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  const stack: X[] = []; let root: X | undefined, count = 0, wordCells = 0;
  const parser = new SaxesParser({ xmlns: true, defaultXMLVersion: "1.0", forceXMLVersion: true });
  parser.on("xmldecl", (decl) => { if (decl.version !== "1.0") fail("XML 1.0以外の資料には対応していません。"); });
  parser.on("doctype", () => fail("DTDを含む資料には対応していません。"));
  parser.on("opentag", (tag) => {
    if (++count > LIMITS.nodes) limit("nodes");
    if (stack.length >= LIMITS.depth) limit("depth");
    if (tag.uri === WORD && tag.local === "tc" && ++wordCells > LIMITS.cells) limit("cells");
    const parent = stack.at(-1);
    const x: X = { name: tag.local, uri: tag.uri, attrs: Object.create(null) as Record<string, string>, children: [], text: "", space: parent?.space ?? "default", skip: parent?.skip ?? false, omitted: false, ignorable: new Set(parent?.ignorable) };
    for (const a of Object.values(tag.attributes)) x.attrs[`${a.uri}|${a.local}`] = a.value;
    const space = attr(x, "space", "http://www.w3.org/XML/1998/namespace");
    if (space && space !== "preserve" && space !== "default") fail("xml:spaceの指定が不正です。");
    if (space) x.space = space;
    // S5-10/11: 無視可能な拡張は丸ごと省略し、それ以外の未知構造は明示的に拒否する。
    if (!x.skip) {
      for (const prefix of attr(x, "Ignorable", MC).split(/\s+/).filter(Boolean)) {
        const ns = parser.resolve(prefix); if (!ns) fail("互換性指定の名前空間が見つかりません。"); x.ignorable.add(ns!);
      }
      for (const a of Object.values(tag.attributes)) {
        if (a.uri === MC && a.local !== "Ignorable") fail("未対応の互換性指定があります。原本で確認してください。");
        if (!understood.has(a.uri) && !opaque.has(a.uri) && !x.ignorable.has(a.uri)) fail("未対応の名前空間の属性があります。");
      }
      // ExcelのextLstは拡張用の容器。子の本体要素も拾わず、S5-10の未知要素拒否は外側で維持する。
      // 部品自体もSpreadsheetMLの場合だけ対象にし、Wordの受理範囲は変えない。
      if ((uri === SHEET && x.uri === SHEET && x.name === "extLst") || (x.uri === MC && x.name === "AlternateContent") || opaque.has(x.uri) || (!understood.has(x.uri) && x.ignorable.has(x.uri))) x.skip = true;
      else if (!x.uri || !understood.has(x.uri)) fail("未対応の名前空間の要素があります。");
      if (x.skip && root) root.omitted = true;
    }
    if (stack.length) stack.at(-1)!.children.push(x); else root = x;
    stack.push(x);
  });
  parser.on("text", (text) => { if (stack.length) stack.at(-1)!.text += text; });
  parser.on("cdata", (text) => { if (stack.length) stack.at(-1)!.text += text; });
  parser.on("closetag", () => { stack.pop(); });
  parser.write(source).close();
  if (!root || root.name !== rootName || root.uri !== uri) return fail(`部品 ${name} の形式に対応していません（Strict形式を含む）。`);
  return root;
}
// Opus S5-3 続き: w:sym と、フォント依存の私用領域の文字を同じ注記に揃える。
const SYMBOL_WARNING = "本文中の「［記号未再現（…）］」は原本の文字ではなく、表示できない記号の位置を示す注記です。フォントとコードを残しています。記号の形・意味は原本で確認してください。";
const symbolNote = (font: string, code: string) => `［記号未再現（フォント: ${font || "未指定"} / コード: ${code || "未指定"}）］`;
/** 私用領域は表示するフォントでしか意味が決まらない。字形を推測せず位置と符号を残す。 */
const isPrivateUse = (code: number) => (code >= 0xe000 && code <= 0xf8ff) || (code >= 0xf0000 && code <= 0xffffd) || (code >= 0x100000 && code <= 0x10fffd);
function markPrivateUse(text: string, warnings: string[], font: string): string {
  if (![...text].some((c) => isPrivateUse(c.codePointAt(0)!))) return text;
  if (!warnings.includes(SYMBOL_WARNING)) warnings.push(SYMBOL_WARNING);
  return [...text].map((c) => {
    const code = c.codePointAt(0)!;
    return isPrivateUse(code) ? symbolNote(font, code.toString(16).toUpperCase().padStart(4, "0")) : c;
  }).join("");
}
const runFont = (x: X, inherited: string) => {
  const fonts = child(child(x, "rPr", WORD), "rFonts", WORD);
  return attr(fonts, "ascii", WORD) || attr(fonts, "hAnsi", WORD) || attr(fonts, "eastAsia", WORD) || inherited;
};
function wordText(x: X, warnings: string[], font = ""): string {
  if (x.skip) return "";
  if (x.name === "AlternateContent") return "";
  if (x.uri === WORD) {
    // Opus S5-2: 段落設定とその変更前の設定は本文ではない。同名のw:tabを文字にしない。
    if (x.name === "pPr" || x.name === "rPr") return "";
    if (x.name === "del" || x.name === "moveFrom" || x.name === "txbxContent") return "";
    // 記号の書体は文字の親の run にしかない。子へ運んでから t を読む。
    if (x.name === "r") { const next = runFont(x, font); return x.children.map((c) => wordText(c, warnings, next)).join(""); }
    if (x.name === "t") return markPrivateUse(savedText(x), warnings, font);
    if (x.name === "ruby") {
      const base = child(x, "rubyBase", WORD), reading = child(x, "rt", WORD);
      if (!base || !reading) return fail("ルビの親文字または読みがありません。");
      const warning = "ルビは親文字（読み）の形で表示します。括弧は読みを区別するための表示で、原本の文字ではありません。";
      if (!warnings.includes(warning)) warnings.push(warning);
      return `${wordText(base, warnings, font)}（${wordText(reading, warnings, font)}）`;
    }
    // Opus S5-3: 数字を連結せず、非改行という意味をUnicodeの非改行ハイフンで保持する。
    if (x.name === "noBreakHyphen") return "\u2011";
    if (x.name === "sym") {
      // フォント依存のコードをUnicodeだと推測しない。欠落位置と原本の指定を明示する。
      if (!warnings.includes(SYMBOL_WARNING)) warnings.push(SYMBOL_WARNING);
      return symbolNote(attr(x, "font", WORD) || font, attr(x, "char", WORD));
    }
    if (x.name === "tab") return "\t";
    if (x.name === "br" || x.name === "cr") return "\n";
  }
  return x.children.map((c) => wordText(c, warnings, font)).join("");
}
function cellParagraphs(x: X, warnings: string[]): string[] {
  if (x.skip) return [];
  // 削除履歴・テキストボックスの祖先を飛び越えて段落を拾わない。
  if (x.name === "AlternateContent" || (x.uri === WORD && ["del", "moveFrom", "txbxContent"].includes(x.name))) return [];
  if (x.uri === WORD && x.name === "p") return [wordText(x, warnings)];
  return x.children.flatMap((c) => cellParagraphs(c, warnings));
}
function* tableChildren(x: X, name: "tr" | "tc"): Iterable<X> {
  // S5-72 / Opus S5-1: 同じ階層の行・セルを包む要素だけを透過する。
  // 全子孫を集めると、入れ子表・削除履歴・設定要素まで外側の位置に混ざる。
  for (const c of x.children) {
    if (c.skip) continue;
    if (c.uri !== WORD) continue;
    if (c.name === name) yield c;
    else if (c.name === "customXml") yield* tableChildren(c, name);
    else if (c.name === "sdt") {
      const content = child(c, "sdtContent", WORD);
      if (content) yield* tableChildren(content, name);
    }
  }
}
function relsFor(data: Map<string, Buffer>, owner: string, required = true): Map<string, X> {
  const path = owner ? posix.join(posix.dirname(owner), "_rels", `${posix.basename(owner)}.rels`) : "_rels/.rels";
  if (!required && !data.has(path)) return new Map();
  const rels = new Map<string, X>();
  for (const rel of children(xml(data, path, REL, "Relationships"), "Relationship", REL)) {
    const id = attr(rel, "Id"); if (!id || rels.has(id)) fail("部品参照IDが不正または重複しています。"); rels.set(id, rel);
  }
  return rels;
}
function targetOf(rel: X, owner: string): string {
  if (attr(rel, "TargetMode") && attr(rel, "TargetMode") !== "Internal") return fail("外部の部品は読み取れません。");
  const raw = attr(rel, "Target");
  if (!raw || /[\\:%#?]/.test(raw)) return fail("部品参照の形式に対応していません。");
  const path = posix.normalize(raw.startsWith("/") ? raw.slice(1) : posix.join(posix.dirname(owner), raw));
  if (path === "." || path === ".." || path.startsWith("../") || path.startsWith("/")) return fail("パッケージの外を参照しています。");
  return path;
}
function relByType(rels: Map<string, X>, suffix: string): X | undefined {
  const found = [...rels.values()].filter((r) => attr(r, "Type") === `${OFFICE_REL}/${suffix}`);
  if (found.length > 1) return fail("同じ種類の部品参照が重複しています。");
  return found[0];
}
function mainPart(data: Map<string, Buffer>, format: "docx" | "xlsx"): string {
  const rel = relByType(relsFor(data, ""), "officeDocument"); if (!rel) return fail("本体部品への参照がありません。");
  const path = targetOf(rel, "");
  const types = xml(data, "[Content_Types].xml", CT, "Types");
  const overrides = children(types, "Override", CT).filter((t) => attr(t, "PartName") === `/${path}`);
  const expected = format === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
  if (overrides.length !== 1 || attr(overrides[0], "ContentType") !== expected) return fail("本体部品の形式と拡張子が一致しません。");
  return path;
}
function word(data: Map<string, Buffer>, main: string): ParsedDocument {
  const doc = xml(data, main, WORD, "document"), body = child(doc, "body", WORD);
  if (!body) return fail("Wordの本文がありません。");
  // S5-15: XML読取時点で、入れ子・省略対象を含む全セルを上限に数えている。
  const warnings = ["印刷レイアウト・ページ番号は再現しません。出典は本文内の段落・表の位置です。画像・図形・ヘッダー・フッター・脚注・コメントは抽出対象外です。"];
  if (doc.omitted) warnings.push("未対応の拡張・代替要素を省略しています。その中の文字は表示しません。原本で確認してください。");
  // Opus S5-4: Word側の表示設定やスタイルの継承を解釈せず、抽出方針をすべての文書で明示する。
  warnings.push("抽出対象の本文は隠し文字も含めて抽出します。Wordの表示・印刷と異なる場合があります。隠し文字の範囲表示や、表示設定に合わせた文字の省略は行いません。");
  if (["drawing", "pict", "txbxContent", "altChunk", "object", "AlternateContent"].some((name) => descendants(doc, name).length)) warnings.push("画像・図形・埋め込み・代替要素があります。その中の文字は読み取っていません。原本を確認してください。");
  if (["ins", "del", "moveFrom", "moveTo"].some((name) => descendants(doc, name, WORD).length)) warnings.push("変更履歴があります。挿入後の文章を表示し、削除・移動元の文章は表示しません。承認済みを意味しません。");
  // フィールドの表示文字は保存された結果。Excelの数式と同じく、開いた時点より古い場合がある。
  if (["fldChar", "fldSimple", "instrText"].some((name) => descendants(doc, name, WORD).length)) warnings.push("差し込み・日付・ページ番号などのフィールドがあります。表示するのは原本に保存された結果で、Wordで開き直すと変わる場合があります。フィールドの計算はしません。");
  const styles = new Map<string, string>();
  const styleRel = relByType(relsFor(data, main, false), "styles");
  const styleRoot = styleRel ? xml(data, targetOf(styleRel, main), WORD, "styles") : undefined;
  if (styleRoot) for (const s of children(styleRoot, "style", WORD)) styles.set(attr(s, "styleId", WORD), wval(child(s, "name", WORD)));
  // 設定の存在と実際に隠れる文字の判定を混同しない。解除や未使用スタイルも検出対象。
  if (descendants(doc, "vanish", WORD).length || (styleRoot && descendants(styleRoot, "vanish", WORD).length)) {
    warnings.push("文書またはスタイルに隠し文字の設定を検出しました。解除設定や未使用スタイルも含むため、実際に非表示になる箇所は原本で確認してください。");
  }
  // 箇条書き・段落番号はWordが表示時に振る。本文に保存された文字ではないので補わない。
  if (descendants(doc, "numPr", WORD).length || (styleRoot && descendants(styleRoot, "numPr", WORD).length)) {
    warnings.push("箇条書き・段落番号の自動採番があります。番号や行頭記号は原本の本文に保存されていないため表示しません。番号で参照する資料は原本を確認してください。");
  }
  const blocks: (WordParagraph | WordTable)[] = [];
  let p = 0, table = 0, cellCount = 0;
  const visit = (x: X) => {
    if (x.skip) return;
    if (x.name === "AlternateContent") return;
    if (x.uri === WORD && (x.name === "del" || x.name === "moveFrom")) return;
    if (x.uri === WORD && x.name === "p") {
      const style = wval(child(child(x, "pPr", WORD), "pStyle", WORD));
      blocks.push({ kind: "paragraph", location: `本文 / 段落 ${++p}`, text: wordText(x, warnings), style: styles.get(style) ?? style });
    } else if (x.uri === WORD && x.name === "tbl") {
      const location = `本文 / 表 ${++table}`;
      const rows = [...tableChildren(x, "tr")].map((tr, r) => [...tableChildren(tr, "tc")].map((tc, c) => {
        if (++cellCount > LIMITS.cells) limit("cells");
        const props = child(tc, "tcPr", WORD), span = Number(wval(child(props, "gridSpan", WORD)) || 1);
        if (!Number.isSafeInteger(span) || span < 1 || span > 1000) return fail("表のセル結合が不正です。");
        if (descendants(tc, "tbl", WORD).length) warnings.push(`${location}に入れ子の表があります。セル内の文章として表示します。`);
        return { location: `${location} / 行 ${r + 1} / セル ${c + 1}`, text: cellParagraphs(tc, warnings).join("\n"), columnSpan: span, verticalMerge: child(props, "vMerge", WORD) ? wval(child(props, "vMerge", WORD)) || "continue" : "" };
      }));
      blocks.push({ kind: "table", location, rows });
    } else for (const c of x.children) visit(c);
  };
  for (const x of body.children) visit(x);
  if (blocks.length > LIMITS.blocks) limit("blocks");
  if (!blocks.some((b) => b.kind === "paragraph" ? b.text : b.rows.some((r) => r.some((c) => c.text)))) warnings.push("抽出対象の文字はありません。画像だけの資料や空の資料では、原本を確認してください。");
  return { schemaVersion: 1, format: "docx", warnings: [...new Set(warnings)], blocks };
}

// ECMA-376 18.8.30 が固定している組み込み書式。表示の適用ではなく、保存書式の報告に使う。
const BUILT_IN_FORMATS = new Map<string, string>(Object.entries({
  "0": "General", "1": "0", "2": "0.00", "3": "#,##0", "4": "#,##0.00",
  "5": "$#,##0_);($#,##0)", "6": "$#,##0_);[Red]($#,##0)", "7": "$#,##0.00_);($#,##0.00)", "8": "$#,##0.00_);[Red]($#,##0.00)",
  "9": "0%", "10": "0.00%", "11": "0.00E+00", "12": "# ?/?", "13": "# ??/??",
  "14": "mm-dd-yy", "15": "d-mmm-yy", "16": "d-mmm", "17": "mmm-yy", "18": "h:mm AM/PM", "19": "h:mm:ss AM/PM",
  "20": "h:mm", "21": "h:mm:ss", "22": "m/d/yy h:mm",
  "37": "#,##0_);(#,##0)", "38": "#,##0_);[Red](#,##0)", "39": "#,##0.00_);(#,##0.00)", "40": "#,##0.00_);[Red](#,##0.00)",
  "45": "mm:ss", "46": "[h]:mm:ss", "47": "mmss.0", "48": "##0.0E+0", "49": "@",
}));
/** 23-36 / 41-44 / 50-58 は地域依存。和暦などは環境で変わるため書式コードを名乗らない。 */
const isLocaleFormat = (id: number) => (id >= 23 && id <= 36) || (id >= 41 && id <= 44) || (id >= 50 && id <= 58);
/** 書式コードの日付・時刻らしさ。引用符・角括弧・エスケープは書式指定ではない。 */
const isDateFormat = (code: string) => /[ymdhs]/i.test(code.replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"/g, "").replace(/\\./g, ""));

function workbook(data: Map<string, Buffer>, main: string): ParsedDocument {
  const book = xml(data, main, SHEET, "workbook"), rels = relsFor(data, main);
  const target = (rel: X) => targetOf(rel, main);
  const byType = (suffix: string) => relByType(rels, suffix);
  const sharedRel = byType("sharedStrings"), styleRel = byType("styles");
  const richText = (x: X): string => x.children.map((c) => c.skip || c.uri !== SHEET ? "" : c.name === "t" ? xstring(savedText(c)) : c.name === "r" ? richText(c) : "").join("");
  const sharedRoot = sharedRel ? xml(data, target(sharedRel), SHEET, "sst") : undefined;
  const shared = children(sharedRoot, "si", SHEET).map(richText);
  const styles = styleRel ? xml(data, target(styleRel), SHEET, "styleSheet") : undefined;
  const formats = new Map(children(child(styles, "numFmts", SHEET), "numFmt", SHEET).map((f) => [attr(f, "numFmtId"), attr(f, "formatCode")]));
  const xfs = children(child(styles, "cellXfs", SHEET), "xf", SHEET);
  const warnings = ["値はファイルに保存された値です。数式は再計算せず、結果が古い可能性があります。日付・通貨・桁区切りなどの表示書式は適用せず、保存値と書式を併記します。画像・グラフ・コメントは抽出対象外です。", "非表示のシート・行・列も抽出対象です。フィルターや印刷範囲による省略は行いません。"];
  const dateSystem = attr(child(book, "workbookPr", SHEET), "date1904") === "1" || attr(child(book, "workbookPr", SHEET), "date1904") === "true" ? "1904" : "1900";
  const omittedParts = new Set<string>();
  if (book.omitted) omittedParts.add("ブック設定");
  if (styles?.omitted) omittedParts.add("書式");
  if (sharedRoot?.omitted) omittedParts.add("共有文字列");
  const sheets: ParsedSheet[] = []; let cellCount = 0;
  const sheetNames = new Set<string>(), partNames = new Set<string>();
  for (const s of children(child(book, "sheets", SHEET), "sheet", SHEET)) {
    const name = xstring(attr(s, "name")), rel = rels.get(attr(s, "id", OFFICE_REL));
    if (!rel || attr(rel, "Type") !== `${OFFICE_REL}/worksheet`) return fail("ワークシート以外のシート、または参照切れがあります。");
    const part = target(rel);
    if (!name || sheetNames.has(name) || partNames.has(part)) return fail("シートの名前または参照が重複しています。");
    sheetNames.add(name); partNames.add(part);
    const sheet = xml(data, part, SHEET, "worksheet"), cells: SheetCell[] = [], addresses = new Set<string>(), serialCells: string[] = [];
    if (sheet.omitted) omittedParts.add(`シート「${name}」`);
    const hiddenColumns = new Uint8Array(16385), definedColumns = new Uint8Array(16385);
    for (const col of children(child(sheet, "cols", SHEET), "col", SHEET)) {
      const min = Number(attr(col, "min")), max = Number(attr(col, "max"));
      if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max > 16384 || min > max) return fail("列の範囲が不正です。");
      for (let i = min; i <= max; i++) {
        if (definedColumns[i]) return fail("列の設定範囲が重複しています。");
        definedColumns[i] = 1; hiddenColumns[i] = ["1", "true"].includes(attr(col, "hidden")) ? 1 : 0;
      }
    }
    for (const row of children(child(sheet, "sheetData", SHEET), "row", SHEET)) for (const c of children(row, "c", SHEET)) {
      if (++cellCount > LIMITS.cells) limit("cells");
      const address = attr(c, "r"), match = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(address);
      if (!match || addresses.has(address)) return fail("セル位置が不正または重複しています。");
      addresses.add(address);
      const column = [...match[1]!].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0), r = Number(match[2]);
      if (column > 16384 || r > 1048576 || (attr(row, "r") && Number(attr(row, "r")) !== r)) return fail("セル位置と行が一致しません。");
      const type = attr(c, "t") || "n", stored = child(c, "v", SHEET), f = child(c, "f", SHEET);
      let value: string | null = stored ? stored.text : null;
      if (type === "s") {
        if (value === null || !/^\d+$/.test(value) || shared[Number(value)] === undefined) return fail("共有文字列の参照が壊れています。");
        value = shared[Number(value)]!;
      } else if (type === "inlineStr") { const inline = child(c, "is", SHEET); value = inline ? richText(inline) : ""; }
      else if (!["n", "b", "d", "e", "str"].includes(type)) return fail("未対応のセル型です。");
      if (type === "str" && value !== null) value = xstring(value);
      const style = attr(c, "s");
      if (style && (!/^\d+$/.test(style) || !xfs[Number(style)])) return fail("セル書式の参照が壊れています。");
      const formatId = attr(xfs[Number(style || 0)], "numFmtId") || "0";
      // 書式コードが分かるものはコードで、地域依存の番号は番号の範囲で日付を判定する。
      const knownCode = formats.get(formatId) ?? BUILT_IN_FORMATS.get(formatId), locale = isLocaleFormat(Number(formatId));
      const numberFormat = knownCode ?? (locale ? `組み込み書式 ${formatId}（地域依存。Excelの表示は環境によって変わります）` : `組み込み書式 ${formatId}`);
      if (type === "n" && value !== null && (knownCode !== undefined ? isDateFormat(knownCode) : locale)) serialCells.push(address);
      cells.push({ address, row: r, column, value, valueType: type, formula: f ? f.text : null, formulaKind: f ? attr(f, "t") || "normal" : "", numberFormat, hiddenRow: ["1", "true"].includes(attr(row, "hidden")), hiddenColumn: hiddenColumns[column] === 1 });
    }
    const merges = children(child(sheet, "mergeCells", SHEET), "mergeCell", SHEET).map((m) => attr(m, "ref"));
    // 日付・時刻の保存値は連番のまま。Excelの画面と一致しないことを、照合の前に伝える。
    if (serialCells.length) warnings.push(`「${name}」の${serialCells.slice(0, 5).join("、")}${serialCells.length > 5 ? ` ほか${serialCells.length - 5}件` : ""}は日付・時刻の書式です。値は${dateSystem}年方式の連番で保存されており、Excelの画面表示とは異なります。書式を適用した日付に変換しません。`);
    if (cells.some((c) => c.formula !== null && c.value === null)) warnings.push(`「${name}」には保存された計算結果のない数式があります。値を推測して補いません。`);
    if (cells.some((c) => c.formulaKind === "shared" || c.formulaKind === "array")) warnings.push(`「${name}」の共有・配列数式は、保存されている式だけを表示します。空の式は未保存であり、数式なしを意味しません。`);
    if (cells.some((c) => c.formula?.includes("_xlfn."))) warnings.push(`「${name}」の数式には保存用の接頭辞 _xlfn. が含まれます。保存式をそのまま示し、Excel画面の式への変換や再計算は行いません。`);
    sheets.push({ name, part, state: attr(s, "state") || "visible", cells, merges });
  }
  if (!sheets.length) return fail("ワークシートがありません。");
  if (omittedParts.size) warnings.push(`未対応の拡張・代替要素を省略しています。省略した部品: ${[...omittedParts].join("、")}。その中の値や設定は表示しません。原本で確認してください。`);
  return { schemaVersion: 1, format: "xlsx", warnings, dateSystem, sheets };
}

export async function parseOffice(bytes: Buffer, format: "docx" | "xlsx"): Promise<ParsedDocument> {
  try {
    const data = await parts(bytes);
    const main = mainPart(data, format);
    const result = format === "docx" ? word(data, main) : workbook(data, main);
    if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.outputBytes) limit("outputBytes");
    return result;
  } catch (error) {
    if (error instanceof ParseError) throw error;
    throw new ParseError("invalid_document", "Officeの内容を読み取れません。破損・暗号化・拡張子と内容の不一致を原本で確認してください。");
  }
}
