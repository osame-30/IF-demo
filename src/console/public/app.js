import { renderWordTable, pageWordEntries, formatReason, parseStatusMessage, renderVersionList, filterSheetCells, filterWordBlocks, excelDateDisplay } from "./content-view.js";
import { renderNormalizedPage, renderNormalizedInfo, matchesNormalizedRequest } from "./normalized-view.js";
import { sourceStatus, scanStatus, attentionCount, scanReason, renderReviewLists, renderLiveNotice, observationTitle } from "./console-view.js";
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const hash = location.hash.slice(1);
if (/^[a-f0-9]{64}$/.test(hash)) { sessionStorage.setItem("operator-token", hash); history.replaceState(null, "", "/"); }
const token = sessionStorage.getItem("operator-token");
let state, page = "home", query = "", offset = 0, refreshing = false, renderedState = "", renderedLive = "";
let contentVersion = null, contentPolling = false, contentValue = null, sheetIndex = 0, cellPage = 0;
const wordCellPages = new Map();
let contentQuery = "", valuesOnly = true;
let normalizedValue = null, normalizedArtifact = "", normalizedQuery = "", normalizedPageNumber = 0, normalizedEmpty = false, normalizedPolling = false;
let wordBlockOffset = 0, includeDeleted = false, versionDetail = null, pickerController = null;
const titles = { home: "全体状況", sources: "接続フォルダ", documents: "文書・中身", audit: "整合性の点検", maintenance: "メンテナンス" };
const statuses = { completed: ["完了", "good"], applied: ["削除反映済み", "good"], pending: ["削除反映が未完了", "warn"], superseded: ["後続走査で反映", "good"], review: ["削除の承認待ち", "blue"], scanning: ["走査中", "blue"], running: ["中断の可能性", "warn"], aborted_safety: ["安全弁で停止", "warn"], failed: ["失敗", "bad"], active: ["有効", "good"], tombstoned: ["削除済み（履歴のみ）", ""], quarantined: ["隔離", "warn"], ok: ["確認済み", "good"], violated: ["不一致あり", "bad"], not_checked: ["未検査", ""] };
const names = { LINEAGE_COMPLETE: "原本までのつながり", NO_ORPHAN_ARTIFACT: "親のない派生物", IDEMPOTENT_REPLAY: "再実行前後の状態一致", NO_WORK_WITHOUT_CHANGE: "無変更時の書き込み", SINGLE_ACTIVE_VERSION: "有効な版の一意性", SAFETY_ABORT_WRITES_NOTHING: "安全弁停止中の削除防止", HASH_MATCHES_BLOB: "保存原本とハッシュの一致", ACL_DOES_NOT_VERSION: "権限と版の分離", ONE_RUNNING_SCAN_PER_SOURCE: "接続先ごとの走査の一意性", DELETION_ONLY_FROM_COMPLETED_SCAN: "削除反映の根拠", NO_VERSION_WITHOUT_VERIFIED_BLOB: "版が参照する原本の検証証拠", DERIVATION_OUTPUT_STABLE: "派生結果の安定性", POINTER_MATCHES_OBSERVATION: "有効な版と最新観測の一致", CANONICAL_KEY_STABILITY: "設定キーの固定値検算", DERIVATION_KEY_MATCHES_MATERIALS: "派生キーと保存材料の一致" };
const observations = { document_discovered: "文書を発見", version_created: "新しい版を保存", version_reverted: "以前の版を再観測", document_missing: "接続元に見つからない", document_tombstoned: "削除を反映", document_revived: "文書が再び見つかった", document_unreadable: "読み取り失敗", scan_aborted_safety: "安全弁が停止", scan_approved_by_operator: "運用者が承認", unlistable_subtree: "一覧できないフォルダ", entry_skipped: "取り込めない項目", blob_reference_broken: "原本参照に異常", stable_key_collision: "名前の衝突" };
const reasons = { count_ratio: "観測した文書数が前回より大きく減っています", missing_ratio: "前回に対する欠損率が基準を超えています", approval_missing_limit: "運用者が許可した欠損件数を超えています", write_failures: "記録できなかった項目があります", unlistable_subtree: "一覧できないフォルダがあります", blob_divergence: "保存済みの原本と内容が一致しません", enumeration_failed: "接続元の一覧を取得できませんでした", ERR_SQLITE_ERROR: "DB の書き込みに失敗しました。ロック・保存先を確認してください" };
const reason = (text) => formatReason(text, reasons);
const badge = (key) => { const [label, color] = statuses[key] ?? [key ?? "未実行", ""]; return `<span class="badge ${color}">${esc(label)}</span>`; };
const time = (value) => value ? new Intl.DateTimeFormat("ja-JP", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(value) : "—";
const number = (value) => Number(value ?? 0).toLocaleString("ja-JP");
const disabled = () => state?.busy ? "disabled" : "";
const heading = (eyebrow, title, lead, actions = "") => `<div class="page-head"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p class="lead">${lead}</p></div><div class="actions">${actions}</div></div>`;
const panel = (title, body, aside = "") => `<section class="panel"><div class="panel-head"><h2>${title}</h2>${aside}</div>${body}</section>`;
const empty = (title, description, button = "") => `<div class="empty"><div class="empty-symbol">▧</div><h3>${title}</h3>${description}<br>${button}</div>`;
async function api(path, data, signal) {
  const response = await fetch(`/api/${path}`, { signal, headers: { Authorization: `Bearer ${token}`, ...(data === undefined ? {} : { "Content-Type": "application/json" }) }, ...(data === undefined ? {} : { method: "POST", body: JSON.stringify(data) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "操作に失敗しました");
  return value;
}
function error(message) { $("#error").textContent = message; $("#error").hidden = false; }
function toast(message) { $("#toast").textContent = message; $("#toast").hidden = false; setTimeout(() => { $("#toast").hidden = true; }, 6000); }
function dialog(title, body) { pickerController?.abort(); contentVersion = null; contentPolling = false; $("#dialog-title").textContent = title; $("#dialog-body").innerHTML = body; if (!$("#modal").open) $("#modal").showModal(); }
function close() { pickerController?.abort(); contentVersion = null; contentPolling = false; $("#modal").close(); }
function sourceTable(sources) {
  if (!sources.length) return empty("最初のフォルダを接続しましょう", "取り込みたいローカルフォルダを登録すると、ここから走査を開始できます。", '<button class="primary" data-action="add">フォルダを接続</button>');
  // 承認待ちの行は確認へ案内し、中断の復旧ボタンを出さない。強制終了後の running は従来どおり復旧を出す（DF-11）。
  return `<div class="table-wrap"><table><thead><tr><th>接続フォルダ</th><th>有効な文書</th><th>最新の状態</th><th>操作</th></tr></thead><tbody>${sources.map((s) => { const status = sourceStatus(s, state); return `<tr><td><span class="file-name">${esc(s.display_name)}</span><small>${esc(s.root ?? "フォルダ未登録・表示のみ")}</small></td><td>${number(s.active_count)} 件</td><td><span class="badge ${status.color}">${esc(status.label)}</span></td><td><div class="actions">${status.action === "review" ? '<button class="primary" data-action="review">削除候補を確認</button>' : `<button data-action="${status.action}" data-id="${esc(s.source_id)}" ${disabled()} ${s.root ? "" : "disabled"}>${status.action === "recover" ? "中断を確認・復旧" : "走査する"}</button>`}<button data-action="repair" data-id="${esc(s.source_id)}" ${disabled()} ${s.root ? "" : "disabled"}>原本の修復</button></div></td></tr>`; }).join("")}</tbody></table></div>`;
}
function scanTable() {
  if (!state.scans.length) return empty("走査はまだありません", "接続フォルダから走査すると、結果と判断の履歴が残ります。");
  return `<div class="table-wrap"><table><thead><tr><th>実行日時 / 接続先</th><th>結果</th><th>観測 / 前回</th><th>削除反映</th><th></th></tr></thead><tbody>${state.scans.map((s) => `<tr><td>${time(s.started_at)}<small>${esc(s.display_name)}</small></td><td>${((status) => `<span class="badge ${status.color}">${esc(status.label)}</span>`)(scanStatus(s, state))}${s.abort_reason ? `<small>${esc(scanReason(s, reason))}</small>` : ""}</td><td>${number(state.pending?.scanId === s.scan_id ? state.pending.distinctCount : s.distinct_count)} <span class="muted">/ ${number(s.previous_distinct_count)}</span></td><td>${s.deletion_state ? badge(s.deletion_state) : '<span class="muted">未確定</span>'}</td><td><button data-action="history" data-id="${esc(s.scan_id)}">詳細</button></td></tr>`).join("")}</tbody></table></div>`;
}
async function render() {
  $("#breadcrumb").textContent = titles[page];
  document.querySelectorAll("[data-page]").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
  if (page === "home") {
    const unfinished = state.scans.filter((s) => s.deletion_state === "pending").length;
    const stopped = attentionCount(state);
    $("#content").innerHTML = heading("WORKSPACE OVERVIEW", "全体状況", "取り込みの状態と、いま人間の判断が必要なことを確認します。", `<button data-action="export">診断情報を書き出す</button><button class="primary" data-action="add" ${disabled()}>＋ フォルダを接続</button>`) +
      `<div class="metrics">${[["接続フォルダ", state.counts.sources, "このPCで管理"], ["有効な文書", state.counts.active, "削除反映済みを除く"], ["保存された版", state.counts.versions, "原本を追記して保持"], ["停止・失敗した接続先", stopped, "承認待ちは上の通知で確認"]].map(([label, count, note]) => `<div class="metric"><div class="metric-label">${label}</div><strong>${number(count)}</strong><small>${note}</small></div>`).join("")}</div>` +
      `<div class="grid-two">${panel("判断と次のアクション", `<div class="status-card"><div class="status-icon">${stopped || unfinished ? "!" : "○"}</div><div><h3>${state.pending ? "削除の確認を待っています" : stopped || unfinished ? "確認が必要な状態があります" : state.counts.sources ? "現在、承認待ちはありません" : "まだデータを取り込んでいません"}</h3><p>${unfinished ? "未反映の削除があります。次の走査で再開します。" : "走査結果と保存原本の健全性は別です。整合性の点検で確認してください。"}</p>${state.pending ? '<button data-action="review">削除候補を確認 →</button>' : `<button data-page="${stopped ? "sources" : "audit"}">${stopped ? "接続先を確認" : "整合性の点検へ"} →</button>`}</div></div>`)}${panel("安全に取り込むための仕組み", '<div class="panel-body"><ul class="check-list"><li>接続元ファイルを変更しない<span class="badge good">読み取り専用</span></li><li>削除候補を人間が確認<span class="badge blue">承認待ちで停止</span></li><li>検査していないことを区別<span class="badge">未検査と表示</span></li></ul><div class="flow"><span>列挙</span> → <span>原本保存</span> → <span>確認</span> → <span>反映</span></div></div>')}</div>` + panel("接続フォルダ", sourceTable(state.sources)) + panel("最近の走査", scanTable(), '<small>直近50件 / 詳細で理由を確認</small>');
  } else if (page === "sources") {
    $("#content").innerHTML = heading("CONNECTED FOLDERS", "接続フォルダ", "フォルダごとに走査・確認・復旧を進めます。接続元のファイルは変更しません。", `<button class="primary" data-action="add" ${disabled()}>＋ フォルダを接続</button>`) + panel("登録済みの接続先", sourceTable(state.sources)) + '<div class="notice info">「中断の可能性」はプロセス停止の証明ではありません。別の走査プロセスが動いていないことを確認してから復旧してください。</div>';
  } else if (page === "documents") {
    const data = await api(`documents?q=${encodeURIComponent(query)}&offset=${offset}&deleted=${includeDeleted ? "1" : "0"}`);
    $("#content").innerHTML = heading("DOCUMENT EXPLORER", "文書・中身", "Word・Excelの中身を読み取り、原本の版と位置を確かめます。") + `<form class="search" id="search"><input aria-label="ファイル名を検索" name="q" placeholder="ファイル名・パスで検索" value="${esc(query)}"><button>検索</button></form><p><button data-action="toggle-deleted">${includeDeleted ? "削除済みを隠す" : "削除済みも表示"}</button></p>` + panel(`${number(data.total)} 件の文書${includeDeleted ? "" : `（ほか削除済み ${number(data.hiddenDeleted)} 件）`}`, data.rows.length ? `<div class="table-wrap"><table><thead><tr><th>ファイル / 接続先</th><th>状態</th><th>サイズ</th><th>最終観測</th><th></th></tr></thead><tbody>${data.rows.map((d) => `<tr><td class="file-name">${esc(d.stable_key)}<small>${esc(d.display_name)}</small></td><td>${badge(d.state)}</td><td>${number(d.size_bytes)} B</td><td>${time(d.last_seen_at)}</td><td><button data-action="document" data-id="${esc(d.document_id)}">中身・履歴を見る</button></td></tr>`).join("")}</tbody></table></div>` : empty("該当する文書はありません", "走査後にここへ文書が表示されます。")) + `<div class="pager"><button data-action="prev" ${offset === 0 ? "disabled" : ""}>前へ</button>${data.total ? offset + 1 : 0}–${Math.min(offset + 50, data.total)} / ${number(data.total)}<button data-action="next" ${offset + 50 >= data.total ? "disabled" : ""}>次へ</button></div>`;
  } else if (page === "audit") {
    const audit = state.audit;
    $("#content").innerHTML = heading("INTEGRITY CHECK", "整合性の点検", "保存データを読み直し、15項目を独立して検算します。原本の読取量に応じて時間がかかります。", `<button class="primary" data-action="audit" ${disabled()}>点検を実行</button>`) + '<div class="notice info">「未検査」は合格ではありません。再実行の比較など、必要な入力がない項目は未検査のまま表示します。</div>' +
      (audit ? panel(`点検結果 · ${time(audit.checkedAt)}`, audit.report.results.map((r) => `<div class="audit-row">${badge(r.status)}<div><h3>${esc(names[r.name] ?? r.name)}</h3><p>${esc(r.name)}</p>${r.reason ? `<p>${esc(r.name === "IDEMPOTENT_REPLAY" || r.name === "NO_WORK_WITHOUT_CHANGE" ? "比較用の走査前後のスナップショットがないため未検査です。" : r.name === "CANONICAL_KEY_STABILITY" ? "運用点検には固定値テストベクタを渡していません。型・単体試験とは別です。" : r.reason)}</p>` : ""}${r.findings.length ? `<details><summary>対象と根拠 ${r.findings.length} 件</summary><pre>${esc(JSON.stringify(r.findings, null, 2))}</pre></details>` : ""}</div></div>`).join("") + `<div class="panel-body"><h3>DB の構造ガード</h3>${audit.report.schemaGuards.map((g) => `<p>${badge(g.status)} <span class="mono">${esc(g.name)}</span></p>`).join("")}</div>`) : panel("まだ点検していません", empty("健全性は未確認です", "「点検を実行」で現在の保存データを確認できます。")));
  } else {
    $("#content").innerHTML = heading("WORKSPACE CARE", "メンテナンス", "状態を壊さず、診断と保全を行うための操作です。") + `<div class="grid-two">${panel("保存データをバックアップ", `<div class="panel-body"><p class="lead">DB のスナップショットと保存原本を、新しいフォルダに複製します。この UI の走査中には実行できません。</p><div class="path">${esc(state.dataDir)}<br>└ backups / 実行時刻</div><p class="form-help">同じディスク内の保全です。ディスク故障への備えには、完成したフォルダを別媒体へコピーしてください。外部プロセスによる同時書き込みは停止してください。</p><button data-action="backup" ${disabled()}>バックアップを作成</button></div>`)}${panel("診断情報を書き出す", '<div class="panel-body"><p class="lead">接続先・直近の走査結果・このセッションの点検結果を JSON で保存します。問い合わせや問題の切り分けに使えます。</p><p class="form-help">原本の本文は含みません。フォルダのパス・文書名が含まれるため、共有先は確認してください。</p><button data-action="export">診断情報を書き出す</button></div>')}</div>` + panel("この画面の範囲", '<div class="panel-body"><ul class="check-list"><li>原本と過去の版の削除・GC<span>実装しない</span></li><li>既存の古いDBの変換<span>自動移行しない</span></li><li>点検結果・走査中の進捗表示<span>この起動中のみ保持</span></li><li>走査・観測・承認の記録<span>DB に保存</span></li><li>終了方法<span>起動したターミナルで Ctrl+C</span></li></ul><p class="form-help">終了時の承認待ちは削除を見送ります。走査中の終了要求は処理の完了を待ちます。強制終了後は接続フォルダから中断を確認できます。</p></div>');
  }
}
async function refresh(force = false) {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await api("state");
    if (contentPolling && contentVersion && $("#modal").open) await refreshContent();
    if (normalizedPolling && contentVersion && $("#modal").open) await refreshNormalized();
    $("#connection").textContent = "ローカル接続";
    $("#updated").textContent = `最終取得 ${new Date().toLocaleTimeString("ja-JP")}`;
    // 同じ内容のポーリングで押下中のボタンを差し替えない。比較はDOMの再シリアライズ前の文字列で行う。
    const live = renderLiveNotice(state, esc, number);
    if (live !== renderedLive) { $("#live").innerHTML = live; renderedLive = live; }
    const current = JSON.stringify(state);
    if (force || (current !== renderedState && !$("#modal").open && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName))) { await render(); renderedState = current; }
  } catch (e) { $("#connection").textContent = "接続できません"; error(e.message); }
  finally { refreshing = false; }
}
function formError(form, message) {
  let target = form.querySelector(".dialog-error");
  if (!target) { target = document.createElement("p"); target.className = "dialog-error"; target.setAttribute("role", "alert"); form.append(target); }
  target.textContent = message;
}
function bindForm(id, action) {
  $(id).addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = event.submitter; if (button) button.disabled = true;
    try { await action(new FormData(form)); close(); await refresh(true); }
    catch (e) { formError(form, e.message); }
    finally { if (button) button.disabled = false; }
  });
}
async function review() {
  if (!state.pending) { toast("この承認待ちは終了しました"); return; }
  const p = state.pending;
  const risky = p.reasons.length > 0;
  dialog("削除候補を確認する", `<div class="notice"><div>前回 ${number(p.previousDistinctCount)} 件 → 今回 ${number(p.distinctCount)} 件<br><strong>削除候補は合計 ${number(p.missingCount)} 件</strong></div></div><p class="lead">全候補を一括で反映するか、今回は見送るかを選びます。原本と過去の版は保持します。個別選択はできません。</p>${risky ? `<div class="notice error">${esc(reason(p.reasons.join(",")))}。前回に対して ${(p.missingCount * 100 / p.previousDistinctCount).toFixed(1)}% が見つかりません。フォルダ・同期・接続を確認してください。反映すると、この走査の比率の安全弁を免除します。</div>` : ""}<p>最上位フォルダ別: ${p.folders.map((f) => `${esc(f.folder || "（直下）")}: ${number(f.count)}件`).join(" / ")}${p.otherFolderCount ? ` / その他のフォルダ: ${number(p.otherFolderCount)}件` : ""}</p><p class="form-help">一時ファイルの名前規則に該当する候補も、ほかの欠損と一緒に反映されます。不明な候補があれば見送り、接続元を確認してください。</p>${renderReviewLists(p.discovered, p.missingCount, esc, number)}<form id="review-form">${risky ? `<label>反映する総件数を入力<input name="confirmedCount" type="number" min="0" step="1" required placeholder="合計件数"></label><label class="check"><input name="checked" type="checkbox" required>接続元を確認し、表示された全候補の削除反映を確認しました。</label>` : ""}<div class="dialog-actions"><button type="button" id="decline">今回は見送る</button><button class="primary">${number(p.missingCount)} 件の削除を反映する</button></div></form>`);
  let at = 0;
  const load = async () => {
    const data = await api(`candidates?scanId=${encodeURIComponent(p.scanId)}&offset=${at}`);
    $("#candidates").innerHTML = `<ul class="candidate-list">${data.rows.map((d) => `<li><strong>${esc(d.stable_key)}</strong><br>${d.size_bytes == null ? "原本の版なし" : `${number(d.size_bytes)} B`} · 最終観測 ${time(d.last_seen_at)}${d.temporaryName ? "<br>一時ファイルの名前規則に該当" : ""}</li>`).join("")}</ul><div class="pager"><button id="candidate-prev" ${at ? "" : "disabled"}>前へ</button>${at + 1}–${Math.min(at + 100, data.total)} / ${data.total}<button id="candidate-next" ${at + 100 >= data.total ? "disabled" : ""}>次へ</button></div>`;
    $("#candidate-prev").onclick = () => { at -= 100; void load().catch((e) => error(e.message)); };
    $("#candidate-next").onclick = () => { at += 100; void load().catch((e) => error(e.message)); };
  };
  await load();
  $("#decline").onclick = async () => { try { await api("decision", { scanId: p.scanId, approve: false }); close(); await refresh(true); } catch (e) { error(e.message); } };
  bindForm("#review-form", (data) => api("decision", { scanId: p.scanId, approve: true, confirmedCount: p.missingCount, ...(risky ? { typedCount: Number(data.get("confirmedCount")), largeLossConfirmed: data.get("checked") === "on" } : {}) }));
}
const eventList = (items, scanStatusKey) => `<div class="timeline">${items.map((o) => `<article><small>${time(o.occurred_at)}</small><p><strong>${esc(observationTitle(o.kind, scanStatusKey, observations))}</strong>${o.stable_key ? `<br>${esc(o.stable_key)}` : ""}</p><details><summary>記録の詳細</summary><pre>${esc(o.detail)}</pre></details></article>`).join("") || "観測の記録はありません"}</div>`;
async function showDocument(id) {
  const d = await api(`document?id=${encodeURIComponent(id)}`);
  versionDetail = d;
  const selected = d.document.active_version_id ?? d.versions[0]?.version_id;
  dialog("文書の中身と出典", `<h3 class="file-name">${esc(d.document.stable_key)}</h3>${badge(d.document.state)}<label>確認する原本の版<select id="content-version">${d.versions.map((v) => `<option value="${esc(v.version_id)}" ${v.version_id === selected ? "selected" : ""}>${v.version_id === d.document.active_version_id ? "現行版" : "過去の版"} · ${time(v.ingested_at)} · ${esc(v.content_hash.slice(0, 12))}</option>`).join("")}</select></label><h3>保存された版 ${number(d.versionCount)} 件（最大100件を表示）</h3><p class="form-help">原本は過去の版も保持しています。状態と現行版の印は、この画面を開いた時点の記録です。再走査後は開き直してください。現行版は接続元で最後に観測した内容で、初めて保存した日時が最も新しい版とは限りません。</p><div id="version-list"></div><div class="content-actions"><button class="primary" data-action="parse-content">内容を解析</button><button data-action="original">この版の原本をダウンロード</button><button data-action="refresh-content">結果を更新</button></div><p class="form-help">原本は保存した版のバイト列を検証して取得します。Word・Excelで開き、下の段落・表・セル位置と見比べてください。</p><div id="parsed-content" aria-live="polite"></div><section class="normalized-section"><h3>⑥ 読みやすい形</h3><p>段落・行ごとに並べます。行が意味のまとまりとは限りません。各項目から出典を確認できます。</p><button data-action="normalize-content">読みやすい形を作成・再確認</button><div id="normalized-content" aria-live="polite"></div></section><details class="content-history"><summary>保存された版と観測の履歴（版は現行を含む最大100件・観測は直近100件）</summary>${d.versions.map((v) => `<div class="path">${time(v.ingested_at)} · ${number(v.size_bytes)} B<small class="mono"><br>SHA-256: ${esc(v.content_hash)}</small></div>`).join("")}${eventList(d.observations)}</details>`);
  // S5-76: 本文・解析・原本取得の対象を、画面で実際に選ばれた版から決める。
  contentVersion = $("#content-version").value || null; contentValue = null; contentQuery = ""; sheetIndex = 0; cellPage = 0; wordBlockOffset = 0; wordCellPages.clear();
  normalizedValue = null; normalizedArtifact = ""; normalizedQuery = ""; normalizedPageNumber = 0; normalizedPolling = false;
  updateVersionList();
  $("#content-version").onchange = async (event) => {
    contentVersion = event.target.value; sheetIndex = 0; cellPage = 0; wordBlockOffset = 0; wordCellPages.clear();
    normalizedValue = null; normalizedArtifact = ""; normalizedPageNumber = 0; normalizedPolling = false;
    $("#normalized-content").textContent = "選択した版を確認しています…";
    updateVersionList();
    try { await refreshContent(); await refreshNormalized(); } catch (e) { error(e.message); }
  };
  if (contentVersion) { await refreshContent(); await refreshNormalized(); }
  else { $("#parsed-content").textContent = "原本の版がまだ保存されていません。接続先の走査結果を確認してください。"; document.querySelectorAll(".content-actions button").forEach((b) => { b.disabled = true; }); }
}
function updateVersionList() {
  if ($("#version-list") && versionDetail) $("#version-list").innerHTML = renderVersionList(versionDetail.versions, contentVersion, versionDetail.document.active_version_id, esc, time, number);
}
async function refreshContent() {
  const id = contentVersion;
  if (!id) return;
  if (contentValue?.versionId !== id) {
    // 切替後の応答を待つ間に、前の版の本文を選択中の版として見せない。
    contentValue = null; contentPolling = false;
    $("#parsed-content").textContent = "選択した版の内容を確認しています…";
    document.querySelector('[data-action="parse-content"]').disabled = true;
  }
  try {
    const value = await api(`content?versionId=${encodeURIComponent(id)}`);
    if (id !== contentVersion || !$("#parsed-content")) return;
    contentValue = value;
    contentPolling = value.status === "waiting";
    renderContent();
  } catch (e) {
    if (id !== contentVersion || !$("#parsed-content")) return;
    contentPolling = false;
    $("#parsed-content").innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
    document.querySelector('[data-action="parse-content"]').disabled = true;
  }
}
function renderContent() {
  const target = $("#parsed-content"), v = contentValue;
  if (!target || !v) return;
  const parseButton = document.querySelector('[data-action="parse-content"]');
  parseButton.disabled = state?.busy || v.status === "unsupported";
  parseButton.textContent = v.status === "ready" ? "保存結果を再確認" : v.status === "failed" || v.status === "waiting" ? "内容を解析・再試行" : "内容を解析";
  if (v.status !== "ready") { target.innerHTML = `<div class="notice ${v.status === "failed" ? "error" : "info"}">${esc(parseStatusMessage(v, state))}</div>`; return; }
  const result = v.result;
  let body, controls = "";
  if (result.format === "docx") {
    const entries = filterWordBlocks(result.blocks, contentQuery);
    wordBlockOffset = Math.min(wordBlockOffset, Math.floor(Math.max(0, entries.length - 1) / 20) * 20);
    controls = searchControls("文字や「段落 3」で検索", false, contentQuery.trim() ? `${number(entries.length)}項目が一致 / 全${number(result.blocks.length)}項目` : `全${number(result.blocks.length)}項目`);
    body = pageWordEntries(entries, wordBlockOffset).map(({ block: b, index }) => {
      if (b.kind === "paragraph") return `<article class="parsed-block"><small class="source-location">${esc(b.location)}${b.style ? ` · ${esc(b.style)}` : ""}</small><p class="parsed-text">${esc(b.text) || '<span class="muted">空の段落</span>'}</p></article>`;
      return renderWordTable(b, index, wordCellPages.get(index) ?? 0, esc, number);
    }).join("") || '<p class="empty">検索に一致する段落・セルはありません。</p>';
    if (entries.length > 20) body += `<div class="pager"><button data-action="blocks-prev" ${wordBlockOffset === 0 ? "disabled" : ""}>前の20項目</button>${wordBlockOffset + 1}–${Math.min(wordBlockOffset + 20, entries.length)} / ${entries.length}<button data-action="blocks-next" ${wordBlockOffset + 20 >= entries.length ? "disabled" : ""}>次の20項目</button></div>`;
  } else {
    const sheet = result.sheets[sheetIndex] ?? result.sheets[0], cells = filterSheetCells(sheet, contentQuery, valuesOnly);
    cellPage = Math.min(cellPage, Math.floor(Math.max(0, cells.length - 1) / 100));
    const at = cellPage * 100, hidden = valuesOnly ? sheet.cells.length - filterSheetCells(sheet, "", true).length : 0;
    const sheetControls = searchControls("文字やセル番地（例: M2）で検索", true, `${number(cells.length)}セルを表示 / 全${number(sheet.cells.length)}セル${hidden ? `（値が未保存・空のセル ${number(hidden)}件を隠しています）` : ""}`);
    body = `<label>シート<select id="parsed-sheet">${result.sheets.map((s, i) => `<option value="${i}" ${i === sheetIndex ? "selected" : ""}>${esc(s.name)}${s.state !== "visible" ? "（非表示）" : ""} · ${s.cells.length}セル</option>`).join("")}</select></label>${sheetControls}<p class="form-help">保存値の日付基準: ${result.dateSystem}年方式<br>結合範囲: ${sheet.merges.map(esc).join("、") || "なし"}</p><div class="table-wrap"><table class="parsed-table"><thead><tr><th>出典のセル</th><th>保存されている値</th><th>保存されている数式</th><th>保存書式</th></tr></thead><tbody>${cells.slice(at, at + 100).map((c) => { const asDate = excelDateDisplay(c.value, c.valueType, c.numberFormat, result.dateSystem); return `<tr><td><strong>${esc(sheet.name)}!${esc(c.address)}</strong>${c.hiddenRow ? "<small>非表示の行</small>" : ""}${c.hiddenColumn === null ? "<small>列の表示状態は未記録</small>" : c.hiddenColumn ? "<small>非表示の列</small>" : ""}</td><td class="parsed-text">${c.value === null ? '<span class="badge warn">値が未保存</span>' : c.value === "" ? '<span class="muted">空文字列</span>' : esc(c.value)}<small>型: ${esc(({ n: "数値", s: "文字列", inlineStr: "文字列", b: "真偽値 0/1", e: "エラー", d: "日付", str: "文字列" })[c.valueType] ?? c.valueType)}</small>${asDate ? `<small>日付として読むと: ${esc(asDate)}</small>` : ""}</td><td class="parsed-text">${c.formula === null ? "—" : `<code>${esc(c.formula || "式本体はこのセルに未保存")}</code><small>${esc(({normal:"通常の数式", shared:"共有数式", array:"配列数式"})[c.formulaKind] ?? c.formulaKind)}</small>`}</td><td>${esc(c.numberFormat === "General" ? "標準" : c.numberFormat)}</td></tr>`; }).join("") || `<tr><td colspan="4">${sheet.cells.length ? "条件に一致するセルはありません。" : "保存されたセルはありません。"}</td></tr>`}</tbody></table></div><div class="pager"><button data-action="cells-prev" ${at === 0 ? "disabled" : ""}>前の100セル</button>${cells.length ? at + 1 : 0}–${Math.min(at + 100, cells.length)} / ${cells.length}<button data-action="cells-next" ${at + 100 >= cells.length ? "disabled" : ""}>次の100セル</button></div>`;
  }
  target.innerHTML = `<div class="content-success"><span class="badge good">保存結果の整合性を照合済み</span><strong>${result.format === "docx" ? "文章と表が見えるようになりました" : "シートとセルが見えるようになりました"}</strong><p>原本の位置と見比べて、内容が対応しているか確認してください。</p></div><details class="content-limits" open><summary>読み取りの範囲と注意点 · ${result.warnings.length}件</summary><ul>${result.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul></details>${controls}${body}<details class="content-history"><summary>原本の版と保存結果の識別情報</summary><p class="mono">原本の版: ${esc(v.versionId)}<br>原本 SHA-256: ${esc(v.contentHash)}<br>成果物: ${esc(v.artifactId)}</p></details>`;
  if ($("#parsed-sheet")) $("#parsed-sheet").onchange = (e) => { sheetIndex = Number(e.target.value); cellPage = 0; renderContent(); };
  bindSearchControls();
}
async function refreshNormalized() {
  const id = contentVersion, selected = normalizedArtifact;
  if (!id || !$("#normalized-content")) return;
  try {
    const value = await api(`normalized?versionId=${encodeURIComponent(id)}${selected ? `&artifactId=${encodeURIComponent(selected)}` : ""}`);
    if (!matchesNormalizedRequest(id, selected, contentVersion, normalizedArtifact) || !$("#normalized-content")) return;
    normalizedValue = value;
    normalizedPolling = value.status === "waiting" || state?.progress?.phase === "normalizing" && state.progress.versionId === id;
    renderNormalized();
  } catch (e) {
    if (!matchesNormalizedRequest(id, selected, contentVersion, normalizedArtifact) || !$("#normalized-content")) return;
    normalizedFailure(e.message);
  }
}
// N-7: 通信失敗でも履歴操作を残し、別の結果へ戻れるようにする。
function normalizedFailure(message) {
  const previous = normalizedValue?.versionId === contentVersion ? normalizedValue : null;
  normalizedPolling = false;
  normalizedValue = { status: "read_error", versionId: contentVersion, message, history: previous?.history ?? [], canNormalize: previous?.canNormalize ?? true };
  renderNormalized();
}
function updateNormalizedPage() {
  const target = $("#normalized-page");
  if (target && normalizedValue?.status === "ready") target.innerHTML = renderNormalizedPage(normalizedValue.result, normalizedQuery, normalizedEmpty, normalizedPageNumber, esc);
}
function renderNormalized() {
  const target = $("#normalized-content"), v = normalizedValue;
  if (!target || !v || v.versionId !== contentVersion) return;
  const button = document.querySelector('[data-action="normalize-content"]');
  button.disabled = state?.busy || !v.canNormalize || v.status === "unsupported";
  const history = `<label>保存結果<select id="normalized-history"><option value="">現在の解析・正規化の版</option>${v.history.map((h) => `<option value="${esc(h.artifact_id)}" ${h.artifact_id === normalizedArtifact ? "selected" : ""}>${esc(h.processor_version)} · ${time(h.created_at)} · ${esc(h.artifact_id.slice(0, 8))}</option>`).join("")}</select></label>`;
  const upgrade = v.canNormalize ? "" : '<p class="notice warn">⑥の保存にはDB更新が必要です。アプリを終了して⑥の更新手順を実行してください。⑤は引き続き利用できます。</p>';
  const busy = state?.progress?.phase === "normalizing" && state.progress.versionId === contentVersion;
  if (v.status !== "ready") {
    const message = v.status === "read_error" ? v.message : busy ? "⑤の解析と⑥の作成を順に進めています…" : state?.lastNormalizeError?.versionId === v.versionId ? state.lastNormalizeError.message : v.message;
    target.innerHTML = upgrade + history + `<p class="notice ${v.status === "read_error" ? "error" : "info"}">${esc(message)}</p>`;
  } else {
    const result = v.result;
    target.innerHTML = upgrade + history + `<p class="badge good">入力との対応を照合済み</p>${renderNormalizedInfo(result, esc)}<label>内容・出典を検索<input id="normalized-search" type="search" value="${esc(normalizedQuery)}"></label><label><input id="normalized-empty" type="checkbox" ${normalizedEmpty ? "checked" : ""}>空欄も表示</label><div id="normalized-page">${renderNormalizedPage(result, normalizedQuery, normalizedEmpty, normalizedPageNumber, esc)}</div><details><summary>保存結果の識別情報</summary><p class="mono">原本の版: ${esc(v.versionId)}<br>⑤の入力成果物: ${esc(v.inputArtifactId)}<br>⑥の成果物: ${esc(v.artifactId)}</p></details>`;
    const input = $("#normalized-search");
    const apply = () => { normalizedQuery = input.value; normalizedPageNumber = 0; updateNormalizedPage(); };
    input.addEventListener("input", (e) => { if (!e.isComposing) apply(); }); input.addEventListener("compositionend", apply);
    $("#normalized-empty").onchange = (e) => { normalizedEmpty = e.target.checked; normalizedPageNumber = 0; updateNormalizedPage(); };
  }
  $("#normalized-history").onchange = async (e) => {
    normalizedArtifact = e.target.value; normalizedPageNumber = 0;
    normalizedValue = { ...v, status: "waiting", message: "選択した保存結果を確認しています…" };
    renderNormalized();
    await refreshNormalized();
  };
}
function searchControls(placeholder, withValuesOnly, summary) {
  return `<div class="content-search"><label for="content-search">内容を検索</label><input id="content-search" type="search" value="${esc(contentQuery)}" placeholder="${esc(placeholder)}" autocomplete="off">${withValuesOnly ? `<label class="toggle"><input id="values-only" type="checkbox" ${valuesOnly ? "checked" : ""}>値のあるセルだけ表示</label>` : ""}<p class="form-help" aria-live="polite">${esc(summary)}</p></div>`;
}
// 本文を描き直すと入力欄も作り直されるため、入力中のカーソル位置を戻す。日本語の変換中は描き直さない。
function bindSearchControls() {
  const input = $("#content-search");
  if (!input) return;
  const apply = () => {
    const caret = input.selectionStart;
    contentQuery = input.value; cellPage = 0; wordBlockOffset = 0; wordCellPages.clear();
    renderContent();
    const next = $("#content-search");
    if (next) { next.focus(); next.setSelectionRange(caret, caret); }
  };
  input.addEventListener("input", (event) => { if (!event.isComposing) apply(); });
  input.addEventListener("compositionend", apply);
  if ($("#values-only")) $("#values-only").onchange = (event) => { valuesOnly = event.target.checked; cellPage = 0; renderContent(); };
}
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button"); if (!button || button.disabled) return;
  try {
    if (button.dataset.page) { page = button.dataset.page; await render(); return; }
    const action = button.dataset.action, id = button.dataset.id;
    if (action === "select-version") { $("#content-version").value = id; $("#content-version").dispatchEvent(new Event("change")); return; }
    if (action === "toggle-deleted" || action === "show-deleted") { includeDeleted = action === "show-deleted" || !includeDeleted; page = "documents"; offset = 0; if (action === "show-deleted") query = ""; await render(); return; }
    if (action === "parse-content") {
      const selected = contentVersion; if (!selected) return;
      button.disabled = true;
      try {
        const response = await api("parse", { versionId: selected });
        if (selected === contentVersion) { await refreshContent(); if (response.started) contentPolling = true; }
      } catch (e) {
        if (selected === contentVersion && $("#parsed-content")) $("#parsed-content").innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
      } finally { if (selected === contentVersion) button.disabled = false; }
      await refresh(); return;
    }
    if (action === "normalize-content") {
      const selected = contentVersion; if (!selected) return;
      button.disabled = true; normalizedArtifact = "";
      try {
        const response = await api("normalize", { versionId: selected });
        if (selected === contentVersion) { await refreshContent(); await refreshNormalized(); if (response.started) normalizedPolling = true; }
      } catch (e) { if (selected === contentVersion && $("#normalized-content")) normalizedFailure(e.message); }
      finally { if (selected === contentVersion) button.disabled = false; }
      await refresh(); return;
    }
    if (action === "normalized-prev" || action === "normalized-next") { normalizedPageNumber += action === "normalized-prev" ? -1 : 1; updateNormalizedPage(); return; }
    if (action === "refresh-content") { await refreshContent(); await refreshNormalized(); return; }
    if (action === "original") {
      const selected = contentVersion; if (!selected) return;
      const response = await fetch(`/api/original?versionId=${encodeURIComponent(selected)}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error((await response.json()).error);
      const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement("a");
      const filename = /filename\*=UTF-8''([^;]+)/i.exec(response.headers.get("content-disposition") ?? "");
      link.href = url; link.download = filename ? decodeURIComponent(filename[1]) : "original"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return;
    }
    if (action === "blocks-prev" || action === "blocks-next") { wordBlockOffset += action === "blocks-prev" ? -20 : 20; renderContent(); return; }
    if (action === "cells-prev" || action === "cells-next") { cellPage += action === "cells-prev" ? -1 : 1; renderContent(); return; }
    if (action === "word-prev" || action === "word-next") { const index = Number(button.dataset.index); wordCellPages.set(index, (wordCellPages.get(index) ?? 0) + (action === "word-prev" ? -100 : 100)); renderContent(); return; }
    if (action === "pick-folder") {
      // 選択画面はパスを入力欄へ入れるだけ。接続は［接続する］で既存の検査を通す。
      const form = button.closest("form"), label = button.textContent;
      button.disabled = true; button.textContent = "選択中…";
      form.querySelector(".dialog-error")?.remove();
      try {
        pickerController = new AbortController();
        const { path } = await api("pick-folder", {}, pickerController.signal);
        if (path) {
          form.elements.root.value = path;
          const folderName = path.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
          if (!form.elements.name.value.trim() && folderName && !folderName.endsWith(":")) form.elements.name.value = folderName;
        }
      } catch (e) { if (e.name !== "AbortError") formError(form, e.message); }
      finally { pickerController = null; button.disabled = false; button.textContent = label; }
      return;
    }
    if (action === "add") {
      const help = state?.canPickFolder ? "［参照…］で選ぶか、エクスプローラーのアドレスバーからパスを貼り付けてください。" : "エクスプローラーのアドレスバーからパスをコピーしてください。";
      dialog("フォルダを接続する", `<p class="lead">このPCのローカルフォルダを読み取り専用で接続します。登録だけでは走査を開始しません。</p><form id="add-form"><label>表示名<input name="name" placeholder="例：社内ドキュメント"></label><label for="add-root">フォルダの絶対パス</label><div class="path-picker"><input id="add-root" name="root" required placeholder="例：C:\\Documents\\社内資料" autocomplete="off">${state?.canPickFolder ? '<button type="button" data-action="pick-folder">参照…</button>' : ""}</div><p class="form-help">${help}保存先と同じ場所や、その親フォルダは接続できません。</p><div class="dialog-actions"><button class="primary">接続する</button></div></form>`);
      bindForm("#add-form", async (data) => { await api("sources", Object.fromEntries(data)); toast("フォルダを接続しました。走査を開始できます。"); });
    } else if (["scan", "repair", "recover"].includes(action)) {
      const s = state.sources.find((value) => value.source_id === id);
      if (action === "scan") { await api("scan", { sourceId: id }); await refresh(true); return; }
      dialog(action === "repair" ? "保存原本を再取得して修復する" : "中断した走査から復旧する", `<div class="path">${esc(s.display_name)}<br>${esc(s.root)}</div><p class="lead">${action === "repair" ? "フォルダを再走査し、壊れた保存原本があれば同じハッシュのバイト列だけで修復します。接続元に正しい原本がない場合は修復できません。" : "残っている走査を終了してから、新しい走査を始めます。動作中のプロセスを終了させる機能ではありません。"}</p><form id="recovery-form">${s.running_id ? `<label class="check"><input type="checkbox" name="stopped" required>この接続先の走査プロセスが停止していることを確認しました。</label><label>復旧理由<textarea name="reason" rows="2" required></textarea></label><small class="mono">対象走査: ${esc(s.running_id)}</small>` : ""}${action === "repair" ? '<label class="check"><input type="checkbox" name="repairConfirmed" required>接続元から原本を再取得し、検証付きで修復することを確認しました。</label>' : ""}<div class="dialog-actions"><button class="primary">確認して再走査する</button></div></form>`);
      bindForm("#recovery-form", (data) => api("scan", { sourceId: id, repair: action === "repair", repairConfirmed: data.get("repairConfirmed") === "on", ...(s.running_id ? { interruptedScanId: s.running_id, stopped: data.get("stopped") === "on", reason: data.get("reason") } : {}) }));
    } else if (action === "review") await review();
    else if (action === "audit") { button.disabled = true; toast("保存データを点検しています…"); await api("audit", {}); toast("点検が終わりました。未検査の項目も確認してください。"); await refresh(true); }
    else if (action === "backup") {
      dialog("バックアップを作成する", '<p class="lead">現在のDBと保存原本を複製します。空き容量が必要です。外部プロセスによる同時書き込みを停止してください。</p><form id="backup-form"><label class="check"><input type="checkbox" required>このワークスペースに書き込む他のプロセスを停止しました。</label><div class="dialog-actions"><button class="primary">作成する</button></div></form>');
      bindForm("#backup-form", async () => { toast("バックアップを作成しています…"); const result = await api("backup", {}); toast(`バックアップ完了: ${result.destination}`); });
    } else if (action === "export") {
      const value = await api("export"); const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = "ingestion-diagnostics.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else if (action === "document") {
      await showDocument(id);
    } else if (action === "history") {
      const s = state.scans.find((item) => item.scan_id === id);
      const status = scanStatus(s, state);
      dialog("走査の詳細", `<span class="badge ${status.color}">${esc(status.label)}</span> ${s.deletion_state ? badge(s.deletion_state) : ""}<h3 class="path">${esc(s.display_name)}</h3><p class="lead">${esc(scanReason(s, reason) || "停止理由なし")}</p>${s.approved_at ? `<p>承認上限: ${number(s.approved_max_missing_count)} 件<br>理由: ${esc(s.approved_note)}</p>` : ""}<details><summary>走査の記録</summary><pre>${esc(JSON.stringify(s, null, 2))}</pre></details><h3>走査全体の対象外・読取不可の件数</h3><ul>${(await api(`skipped-summary?scanId=${encodeURIComponent(id)}`)).map((r) => `<li>${esc(({office_temporary_file: "一時ファイルの名前規則", hard_linked: "ハードリンク", unusable_name: "使用できない名前", not_a_regular_file: "通常ファイル以外", vanished_during_scan: "列挙中に消失・参照不可"})[r.kind] ?? r.kind)}: ${number(r.count)}件</li>`).join("") || "<li>なし</li>"}</ul><h3>最近の観測（最大100件）</h3>${eventList(await api(`observations?scanId=${encodeURIComponent(id)}`), status.key)}`);
    } else if (action === "prev" || action === "next") { offset += action === "prev" ? -50 : 50; await render(); }
  } catch (e) { error(e.message); }
});
document.addEventListener("submit", async (event) => { if (event.target.id === "search") { event.preventDefault(); query = new FormData(event.target).get("q"); offset = 0; try { await render(); } catch (e) { error(e.message); } } });
// Chromeはドロップされたフォルダの場所をページへ渡さない（PC-Bで実測）。画面が移動しないよう止め、参照を案内する。
document.addEventListener("dragover", (event) => { if (event.dataTransfer?.types.includes("Files")) event.preventDefault(); });
document.addEventListener("drop", (event) => {
  if (!event.dataTransfer?.types.includes("Files")) return;
  event.preventDefault();
  const form = $("#add-form");
  if (form) formError(form, `ブラウザはフォルダの場所を渡さないため、ドロップでは接続できません。${state?.canPickFolder ? "［参照…］で選んでください。" : "パスを貼り付けてください。"}`);
});
$("#modal").addEventListener("close", () => { pickerController?.abort(); contentVersion = null; contentPolling = false; });
$("#dialog-close").onclick = close;
$("#refresh").onclick = () => { $("#error").hidden = true; void refresh(true); };
await refresh(true);
setInterval(() => { void refresh(); }, 2500);
