import { waitingMessage } from "./console-view.js";
// S5-13: 行数だけでなくセル数を制限し、原本の巨大な結合幅をブラウザの表計算へ渡さない。
export function renderWordTable(table, index, offset, esc, number) {
  const total = table.rows.reduce((sum, row) => sum + row.length, 0);
  const start = Math.max(0, Math.min(offset, Math.floor(Math.max(0, total - 1) / 100) * 100));
  const cells = []; let seen = 0;
  for (const row of table.rows) for (const cell of row) {
    if (seen >= start && cells.length < 100) cells.push(cell);
    seen++;
  }
  return `<article class="parsed-block"><small class="source-location">${esc(table.location)} · セル一覧 / ${number(total)}セル</small><div class="table-wrap"><table class="parsed-table"><thead><tr><th>原本の位置</th><th>内容</th><th>結合情報</th></tr></thead><tbody>${cells.map((c) => `<tr><td>${esc(c.location)}</td><td class="parsed-text">${esc(c.text)}</td><td>横${esc(c.columnSpan)}セル${c.verticalMerge ? ` / 縦結合 ${esc(c.verticalMerge)}` : ""}</td></tr>`).join("")}</tbody></table></div>${total > 100 ? `<div class="pager"><button data-action="word-prev" data-index="${index}" ${start === 0 ? "disabled" : ""}>前の100セル</button>${start + 1}–${Math.min(start + 100, total)} / ${total}<button data-action="word-next" data-index="${index}" ${start + 100 >= total ? "disabled" : ""}>次の100セル</button></div>` : ""}</article>`;
}

export function pageWordBlocks(blocks, offset) {
  return blocks.slice(offset, offset + 20).map((block, index) => ({ block, index: offset + index }));
}
export function pageWordEntries(entries, offset) {
  return entries.slice(offset, offset + 20);
}

// 中身検索: 全角の番地・英数字でも探せるよう、比較前に NFKC と小文字で揃える。
const fold = (value) => String(value ?? "").normalize("NFKC").toLowerCase();
// 書式だけのセル（値が未保存・空文字列）は、数式がない限り「値のあるセル」に数えない。
export const hasCellValue = (cell) => (cell.value !== null && cell.value !== "") || cell.formula !== null;

// 番地で指名したセルは、値がなくても隠さない。結合の内側など空の枠を確かめられるようにする。
export function filterSheetCells(sheet, query, valuesOnly) {
  const q = fold(query).trim(), name = fold(sheet.name);
  return sheet.cells.filter((cell) => {
    const address = fold(cell.address);
    if (q && (q === address || q === `${name}!${address}`)) return true;
    if (valuesOnly && !hasCellValue(cell)) return false;
    return !q || fold(cell.value).includes(q) || fold(cell.formula).includes(q);
  });
}

// 元の項目番号を保つ。表のページ位置（wordCellPages）は番号で覚えているため、絞り込みで番号をずらさない。
export function filterWordBlocks(blocks, query) {
  const q = fold(query).trim(), hit = (item) => fold(item.text).includes(q) || fold(item.location).includes(q);
  const entries = blocks.map((block, index) => ({ block, index }));
  if (!q) return entries;
  return entries.flatMap(({ block, index }) => {
    if (block.kind === "paragraph") return hit(block) ? [{ block, index }] : [];
    const rows = block.rows.map((row) => row.filter(hit)).filter((row) => row.length > 0);
    return rows.length > 0 ? [{ block: { ...block, rows }, index }] : [];
  });
}

// S5-14: 自由文の一部分を障害コードへ置換しない。全要素が既知コードのときだけ訳す。
export function formatReason(value, reasons) {
  const raw = String(value ?? ""), parts = raw.split(",");
  return parts.every((part) => Object.hasOwn(reasons, part)) ? parts.map((part) => reasons[part]).join(" / ") : raw;
}
export function parseStatusMessage(value, state) {
  if (state.progress?.phase === "parsing" && state.progress.versionId === value.versionId) return "この版の内容を解析しています。画面は自動更新されます。";
  return state.lastParseError?.versionId === value.versionId ? state.lastParseError.message : waitingMessage(value, state.progress);
}

export function renderVersionList(versions, selected, active, esc, time, number) {
  return `<div class="table-wrap"><table><thead><tr><th>原本の版</th><th>初めて保存した日時</th><th>大きさ</th><th>選択</th></tr></thead><tbody>${versions.map((v) => `<tr><td>${v.version_id === active ? "現行版" : "過去の版"}<small class="mono">${esc(v.content_hash.slice(0, 12))}</small></td><td>${time(v.ingested_at)}</td><td>${number(v.size_bytes)} B</td><td><button data-action="select-version" data-id="${esc(v.version_id)}" aria-pressed="${v.version_id === selected}">${v.version_id === selected ? "選択中" : "この版を見る"}</button></td></tr>`).join("")}</tbody></table></div>`;
}

// 日付は⑤が保存した連番のままなので、それだけでは何日か分からない。書式と日付基準は保存済みで、
// ⑤の凍結された契約(v1)に無い情報は要らないため、画面で計算して保存値の隣に併記する。
// 保存値は置き換えない。既存の成果物も作り直さずにそのまま読める。
const DAY_MS = 86400000;
const pad = (n, width = 2) => String(n).padStart(width, "0");
/** 書式コードの日付・時刻らしさ。引用符・角括弧・エスケープは書式指定ではないので先に外す。 */
const formatParts = (code) => {
  const bare = String(code ?? "").replace(/\[[^\]]*\]/g, "").replace(/"[^"]*"/g, "").replace(/\./g, "");
  const time = /[hs]/i.test(bare);
  // m は h・s と並ぶときは「分」。月と読めるのは時刻の指定が無いときだけ。
  return { date: /[yd]/i.test(bare) || (/m/i.test(bare) && !time), time };
};
/**
 * 書式コードがファイルに無い組み込み書式のうち、東アジアの日付・時刻。
 * 23-26は未定義、41-44は会計書式なので日付として読まない。
 * Excelが何と表示するかは環境依存で分からないが、日付であることと何日かは連番から分かる。
 */
const localeDateId = (id) => (id >= 27 && id <= 36) || (id >= 50 && id <= 58);

/**
 * セルの保存値を日付・時刻として読む。日付書式でないセルや読めない値は空文字を返す。
 * 表示書式は適用しない（Excelの見た目の再現ではない）。
 */
export function excelDateDisplay(value, valueType, numberFormat, dateSystem) {
  if (valueType !== "n" || value === null || value === "") return "";
  const serial = Number(value);
  // 1900年方式の上限は9999-12-31。負の連番はExcelでも日付にならない。
  if (!Number.isFinite(serial) || serial < 0 || serial > 2958465) return "";
  const builtIn = /^組み込み書式 (\d+)/.exec(String(numberFormat ?? ""));
  const parts = builtIn ? (localeDateId(Number(builtIn[1])) ? { date: true, time: true } : { date: false, time: false }) : formatParts(numberFormat);
  if (!parts.date && !parts.time) return "";
  let day = Math.floor(serial), seconds = Math.round((serial - day) * 86400);
  if (seconds >= 86400) { seconds -= 86400; day += 1; }
  // 1900年方式の連番0は日付にならず、時刻だけを表す。1904年方式では連番0が1904-01-01。
  const showDate = parts.date && day >= (dateSystem === "1904" ? 0 : 1);
  const showTime = parts.time && (seconds !== 0 || !showDate);
  if (!showDate && !showTime) return "";
  const clock = `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
  if (!showDate) return clock;
  // Excelは存在しない1900-02-29を連番60として持つ。59以下と61以上で起点が1日ずれる。
  if (dateSystem !== "1904" && day === 60) return `1900-02-29（Excelにしか存在しない日）${showTime ? ` ${clock}` : ""}`;
  const epoch = dateSystem === "1904" ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, day <= 59 ? 31 : 30);
  const at = new Date(epoch + day * DAY_MS);
  const date = `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
  return showTime ? `${date} ${clock}` : date;
}
