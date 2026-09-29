import { excelDateDisplay } from "./content-view.js";
// ⑥は行を表示のまとまりとして扱う。セル境界は文字列の区切りに置き換えない。
const fold = (s) => String(s ?? "").normalize("NFKC").replace(/[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g, " ").trim().toLowerCase();
export function normalizedPage(result, query, showEmpty, page) {
  const q = fold(query), entries = [];
  let total = 0, empty = 0;
  result.groups.forEach((group, gi) => {
    if (!group.units.length && showEmpty && !q) entries.push({ group, unit: { row: null, members: [] }, member: null, gi, ui: 0 });
    group.units.forEach((unit, ui) => {
    // 空の表・行はデータが消えたのではないことを示すため、空表示のときに残す。
    if (!unit.members.length && showEmpty && !q) entries.push({ group, unit, member: null, gi, ui });
    unit.members.forEach((member, mi) => {
      const source = member.source, sheet = member.kind === "sheet_cell";
      const vacant = sheet ? (source.value === null || source.value === "") && source.formula === null : source.text === "";
      total++; if (vacant) empty++;
      const location = sheet ? `${group.name}!${source.address}` : source.location;
      const positionHit = q && fold(location) === q;
      if (vacant && !showEmpty && !positionHit) return;
      if (q && !fold(location).includes(q) && !member.searchText.includes(q) && !(member.searchFormula ?? "").includes(q)) return;
      entries.push({ group, unit, member, gi, ui, mi });
    });
    });
  });
  const offset = Math.max(0, Math.min(page, Math.floor(Math.max(0, entries.length - 1) / 100))) * 100;
  return { entries: entries.slice(offset, offset + 100), matched: entries.length, offset, total, empty };
}
export function renderNormalizedPage(result, query, showEmpty, page, esc) {
  const data = normalizedPage(result, query, showEmpty, page);
  let previous = "";
  const body = data.entries.map(({ group, unit, member, gi, ui }) => {
    const key = `${gi}/${ui}`, title = group.kind === "sheet" ? `${group.name}${unit.row === null ? "" : ` · 行 ${unit.row}`}${group.state !== "visible" ? "（非表示シート）" : ""}` : `${group.location}${unit.row === null ? "" : ` · 行 ${unit.row}`}`;
    const heading = key !== previous ? `<h4>${esc(title)}</h4>` : ""; previous = key;
    if (!member) return `${heading}<p class="muted">${unit.row === null ? "抽出された項目がありません" : "空の行"}</p>`;
    const s = member.source, sheet = member.kind === "sheet_cell", value = sheet ? s.value : s.text;
    const label = sheet ? `${group.name}!${s.address}` : s.location;
    const asDate = sheet ? excelDateDisplay(s.value, s.valueType, s.numberFormat, result.dateSystem) : "";
    const sourceInfo = sheet ? `<dl><dt>保存値</dt><dd class="parsed-text">${s.value === null ? "値が未保存" : s.value === "" ? "空文字列" : esc(s.value)}</dd><dt>数式</dt><dd class="parsed-text">${s.formula === null ? "なし" : s.formula === "" ? "式本体は未保存" : esc(s.formula)}</dd><dt>型 / 数式の種類</dt><dd>${esc(s.valueType)} / ${esc(s.formulaKind || "なし")}</dd><dt>書式</dt><dd>${esc(s.numberFormat)}</dd>${asDate ? `<dt>日付として読むと</dt><dd>${esc(asDate)}<small>${esc(result.dateSystem ?? "1900")}年方式の連番から計算した値です。Excelの表示書式は適用していません。</small></dd>` : ""}<dt>表示状態</dt><dd>行: ${s.hiddenRow ? "非表示" : "表示"} / 列: ${s.hiddenColumn === null ? "未記録" : s.hiddenColumn ? "非表示" : "表示"}</dd></dl>` : `<p class="parsed-text">${esc(s.text)}</p><p>${member.kind === "word_cell" ? `横結合: ${esc(s.columnSpan)} / 縦結合: ${esc(s.verticalMerge || "なし")}` : `スタイル: ${esc(s.style || "未指定")}`}</p>`;
    return `${heading}<article class="normalized-member"><div class="parsed-text">${value === null ? '<span class="muted">値が未保存</span>' : value === "" ? '<span class="muted">空文字列</span>' : esc(value)}</div>${sheet && s.formula !== null ? `<small>数式: ${esc(s.formula || "式本体は未保存")}</small>` : ""}<details><summary>出典を見る · ${esc(label)}</summary><p>この正規化結果を作った⑤の保存記録です。上の原本取得から、同じ版を開いて照合できます。</p>${sourceInfo}</details></article>`;
  }).join("");
  return `<p>${data.matched}件が一致 / 全${data.total}件（値・式のない空欄 ${data.empty}件）</p>${body || '<p class="muted">表示する項目がありません。空欄の表示や検索条件を確認してください。</p>'}<div class="pager"><button data-action="normalized-prev" ${data.offset === 0 ? "disabled" : ""}>前の100件</button>${data.matched ? data.offset + 1 : 0}–${Math.min(data.offset + 100, data.matched)} / ${data.matched}<button data-action="normalized-next" ${data.offset + 100 >= data.matched ? "disabled" : ""}>次の100件</button></div>`;
}

export const matchesNormalizedRequest = (requestedVersion, requestedArtifact, version, artifact) => requestedVersion === version && requestedArtifact === artifact;

// N-3: 項目数に含まれない結合・警告も文書全体で制限する。保存JSONは切り捨てない。
export function renderNormalizedInfo(result, esc) {
  let total = 0;
  const shown = [];
  for (const group of result.groups) {
    if (group.kind !== "sheet") continue;
    total += group.merges.length;
    for (const merge of group.merges.slice(0, Math.max(0, 100 - shown.length))) shown.push(`<li>${esc(group.name)}: ${esc(merge)}</li>`);
  }
  const warnings = result.warnings.slice(0, 100);
  return `<details><summary>読み取りの範囲・結合情報</summary><p>警告 ${result.warnings.length}件（表示 ${warnings.length}件・省略 ${result.warnings.length - warnings.length}件）</p><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul><p>結合範囲 ${total}件（表示 ${shown.length}件・省略 ${total - shown.length}件）</p><ul>${shown.join("")}</ul><p>省略した情報も保存JSONに保持しています。保存値は連番のままで、日付は画面で計算して併記しています。${result.dateSystem ? `${esc(result.dateSystem)}年方式。` : ""}</p></details>`;
}
