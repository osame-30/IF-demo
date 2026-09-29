/** ⑤の抽出結果。表示用の推測値で原本の保存値を置き換えない。 */
export interface WordParagraph {
  kind: "paragraph";
  location: string;
  text: string;
  style: string;
}
export interface WordCell {
  location: string;
  text: string;
  columnSpan: number;
  verticalMerge: string;
}
export interface WordTable {
  kind: "table";
  location: string;
  rows: WordCell[][];
}
export interface SheetCell {
  address: string;
  row: number;
  column: number;
  value: string | null;
  valueType: string;
  formula: string | null;
  formulaKind: string;
  numberFormat: string;
  hiddenRow: boolean;
  hiddenColumn: boolean | null;
}
export interface ParsedSheet {
  name: string;
  state: string;
  part: string;
  cells: SheetCell[];
  merges: string[];
}
export type ParsedDocument = {
  schemaVersion: 1;
  format: "docx";
  warnings: string[];
  blocks: (WordParagraph | WordTable)[];
} | {
  schemaVersion: 1;
  format: "xlsx";
  warnings: string[];
  dateSystem: "1900" | "1904";
  sheets: ParsedSheet[];
};

/** 現在の⑤の出力・表示用。将来この入口を変更しても、保存済み⑥のv1読取は変更しない。 */
export function parseDocumentResult(value: unknown): ParsedDocument {
  return parseDocumentResultV1(value);
}

/** N-2: 保存済み⑥の入力契約。項目・既定値・キー順を変更せず、将来の⑤は別の読取を使う。 */
export function parseDocumentResultV1(value: unknown): ParsedDocument {
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("解析結果の形式が不正です");
    return v as Record<string, unknown>;
  };
  const text = (v: unknown): string => { if (typeof v !== "string") throw new Error("解析結果の文字列が不正です"); return v; };
  const array = (v: unknown): unknown[] => { if (!Array.isArray(v)) throw new Error("解析結果の配列が不正です"); return v; };
  const integer = (v: unknown): number => { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new Error("解析結果の位置が不正です"); return v; };
  const nullable = (v: unknown) => v === null ? null : text(v);
  const root = object(value);
  if (root.schemaVersion !== 1) throw new Error("未対応の解析結果です");
  const warnings = array(root.warnings).map(text);
  if (root.format === "docx") return { schemaVersion: 1, format: "docx", warnings, blocks: array(root.blocks).map((entry) => {
    const b = object(entry), location = text(b.location);
    if (b.kind === "paragraph") return { kind: "paragraph", location, text: text(b.text), style: text(b.style) };
    if (b.kind !== "table") throw new Error("未対応の文書要素です");
    return { kind: "table", location, rows: array(b.rows).map((row) => array(row).map((entry) => {
      const c = object(entry);
      return { location: text(c.location), text: text(c.text), columnSpan: integer(c.columnSpan), verticalMerge: text(c.verticalMerge) };
    })) };
  }) };
  if (root.format !== "xlsx" || (root.dateSystem !== "1900" && root.dateSystem !== "1904")) throw new Error("未対応のブックです");
  return { schemaVersion: 1, format: "xlsx", warnings, dateSystem: root.dateSystem, sheets: array(root.sheets).map((entry) => {
    const s = object(entry);
    return { name: text(s.name), state: text(s.state), part: text(s.part), merges: array(s.merges).map(text), cells: array(s.cells).map((entry) => {
      const c = object(entry);
      if (typeof c.hiddenRow !== "boolean") throw new Error("行の状態が不正です");
      if (c.hiddenColumn !== undefined && c.hiddenColumn !== null && typeof c.hiddenColumn !== "boolean") throw new Error("列の状態が不正です");
      // S5-73: 旧成果物の未記録を「表示列」と推測しない。
      return { address: text(c.address), row: integer(c.row), column: integer(c.column), value: nullable(c.value), valueType: text(c.valueType), formula: nullable(c.formula), formulaKind: text(c.formulaKind), numberFormat: text(c.numberFormat), hiddenRow: c.hiddenRow, hiddenColumn: c.hiddenColumn ?? null };
    }) };
  }) };
}
