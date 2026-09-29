import { parseDocumentResultV1 } from "./parsed-document.ts";
import type { ParsedDocument, WordParagraph, WordCell, SheetCell } from "./parsed-document.ts";

/** ⑥ v1 は凍結する。規則変更時は別の版を足し、保存済みの出典を再解釈しない。 */
export const NORMALIZER_VERSION = "normalize-1";
export const NORMALIZER_CONFIG = Object.freeze({ schemaVersion: 1, rules: "members-v1", search: "nfkc-space-lower-v1", dates: "raw" });
export const NORMALIZED_MAX_BYTES = 16 * 1024 * 1024;
export type NormalizedMember =
  | { kind: "word_paragraph"; source: WordParagraph; searchText: string }
  | { kind: "word_cell"; source: WordCell; searchText: string }
  | { kind: "sheet_cell"; source: SheetCell; searchText: string; searchFormula: string };
export interface NormalizedUnit { row: number | null; members: NormalizedMember[] }
export type NormalizedGroup =
  | { kind: "paragraph" | "table"; location: string; units: NormalizedUnit[] }
  | { kind: "sheet"; name: string; part: string; state: string; merges: string[]; units: NormalizedUnit[] };
export interface NormalizedDocument {
  schemaVersion: 1;
  format: "docx" | "xlsx";
  dateSystem: "1900" | "1904" | null;
  warnings: string[];
  groups: NormalizedGroup[];
}

// 空白の集合・順序を固定する。検索用の畳み込みを出典IDや元値に適用しない。
export function searchTextV1(value: string): string {
  return value.normalize("NFKC").replace(/[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g, " ").trim().toLowerCase();
}

function unique(seen: Set<string>, value: string): void {
  if (!value || seen.has(value)) throw new Error(`⑥の位置が重複または空です: ${value}`);
  seen.add(value);
}
function coordinates(address: string): [number, number] {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(address);
  if (!match) throw new Error(`⑥のセル番地が不正です: ${address}`);
  let column = 0;
  for (const char of match[1]!) column = column * 26 + char.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column > 16384 || row > 1048576) throw new Error(`⑥のセル番地が範囲外です: ${address}`);
  return [row, column];
}

/** 原本ではなく⑤の抽出範囲を保存する。空欄の矩形補完・結合値の複製はしない。 */
export function normalizeDocumentV1(input: ParsedDocument): NormalizedDocument {
  preflightStructureV1(input);
  const parsed = parseDocumentResultV1(input);
  let members = 0;
  const count = () => { if (++members > 20000) throw new Error("⑥の項目数が上限20000を超えています"); };
  const groups: NormalizedGroup[] = [];
  if (parsed.format === "docx") {
    if (parsed.blocks.length > 20000) throw new Error("⑥の本文項目数が上限を超えています");
    const locations = new Set<string>();
    for (const block of parsed.blocks) {
      unique(locations, block.location);
      if (block.kind === "paragraph") {
        count();
        groups.push({ kind: "paragraph", location: block.location, units: [{ row: null, members: [{ kind: "word_paragraph", source: { ...block }, searchText: searchTextV1(block.text) }] }] });
      } else {
        if (block.rows.length > 20000) throw new Error("⑥の表の行数が上限を超えています");
        groups.push({ kind: "table", location: block.location, units: block.rows.map((row, index) => ({ row: index + 1, members: row.map((cell): NormalizedMember => {
          unique(locations, cell.location); count();
          return { kind: "word_cell", source: { ...cell }, searchText: searchTextV1(cell.text) };
        }) })) });
      }
    }
  } else {
    const parts = new Set<string>(), names = new Set<string>();
    if (parsed.sheets.length > 2000) throw new Error("⑥のシート数が上限を超えています");
    for (const sheet of parsed.sheets) {
      unique(parts, sheet.part); unique(names, sheet.name);
      const addresses = new Set<string>();
      const rows = new Map<number, NormalizedMember[]>();
      for (const cell of [...sheet.cells].sort((a, b) => a.row - b.row || a.column - b.column)) {
        unique(addresses, cell.address); count();
        const [r, c] = coordinates(cell.address);
        if (r !== cell.row || c !== cell.column) throw new Error(`⑥の番地と行列が一致しません: ${sheet.name}!${cell.address}`);
        const row = rows.get(r) ?? [];
        row.push({ kind: "sheet_cell", source: { ...cell }, searchText: searchTextV1(cell.value ?? ""), searchFormula: searchTextV1(cell.formula ?? "") });
        rows.set(r, row);
      }
      if (sheet.merges.length > 20000) throw new Error("⑥の結合範囲数が上限を超えています");
      for (const merge of sheet.merges) {
        const ends = merge.split(":");
        if (ends.length !== 2) throw new Error(`⑥の結合範囲が不正です: ${merge}`);
        const [r1, c1] = coordinates(ends[0]!), [r2, c2] = coordinates(ends[1]!);
        if (r1 > r2 || c1 > c2) throw new Error(`⑥の結合範囲が逆転しています: ${merge}`);
      }
      groups.push({ kind: "sheet", name: sheet.name, part: sheet.part, state: sheet.state, merges: [...sheet.merges], units: [...rows].map(([row, members]) => ({ row, members })) });
    }
  }
  const result: NormalizedDocument = { schemaVersion: 1, format: parsed.format, dateSystem: parsed.format === "xlsx" ? parsed.dateSystem : null, warnings: [...parsed.warnings], groups };
  if (Buffer.byteLength(JSON.stringify(result)) > NORMALIZED_MAX_BYTES) throw new Error("⑥の出力が上限16MiBを超えています");
  return result;
}

/** S6-02: 空行の複製前に出力の下限を測る。既存16MiBに入る旧成果物を新しい件数閾値で閉じ込めない。 */
function preflightStructureV1(input: ParsedDocument): void {
  let bytes = Buffer.byteLength(JSON.stringify({ schemaVersion: 1, format: input.format,
    dateSystem: input.format === "xlsx" ? input.dateSystem : null, warnings: input.warnings, groups: [] }));
  const add = (size: number) => {
    bytes += size;
    if (bytes > NORMALIZED_MAX_BYTES) throw new Error("⑥の構造だけで出力上限16MiBを超えています");
  };
  if (input.format === "docx") {
    if (input.blocks.length > 20000) throw new Error("⑥の本文項目数が上限を超えています");
    input.blocks.forEach((block, index) => {
      add((index ? 1 : 0) + Buffer.byteLength(JSON.stringify({ kind: block.kind, location: block.location, units: [] })));
      if (block.kind === "table") {
        const rows = block.rows.length;
        if (rows > 20000) throw new Error("⑥の表の行数が上限を超えています");
        // セルを一つも含まなくても必要なJSON。行番号の桁と区切りを数え、各行には触れない。
        let digits = 0;
        for (let start = 1, width = 1; start <= rows; start *= 10, width++) digits += (Math.min(rows, start * 10 - 1) - start + 1) * width;
        add(rows * '{"row":,"members":[]}'.length + digits + Math.max(0, rows - 1));
      } else {
        add('{"row":null,"members":[]}'.length);
      }
    });
  } else if (input.format === "xlsx") {
    if (input.sheets.length > 2000) throw new Error("⑥のシート数が上限を超えています");
    input.sheets.forEach((sheet, index) => {
      if (sheet.merges.length > 20000) throw new Error("⑥の結合範囲数が上限を超えています");
      add((index ? 1 : 0) + Buffer.byteLength(JSON.stringify({ kind: "sheet", name: sheet.name,
        part: sheet.part, state: sheet.state, merges: sheet.merges, units: [] })));
    });
  }
}

/** ハッシュの自己整合だけでなく、固定した⑤の各値との対応も確かめる。 */
export function verifyNormalizedV1(content: string, parsed: ParsedDocument): NormalizedDocument {
  if (Buffer.byteLength(content) > NORMALIZED_MAX_BYTES) throw new Error("⑥の保存結果が上限を超えています");
  const expected = normalizeDocumentV1(parsed);
  if (content !== JSON.stringify(expected)) throw new Error("⑥の保存結果と入力の値・位置・検索文字が一致しません");
  return expected;
}
