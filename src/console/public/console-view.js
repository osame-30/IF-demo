// 運用画面の状態表示。画面の組み立てから切り出し、判定だけを試験で固定する。

const LABELS = {
  review: ["承認待ち（削除候補の確認）", "warn"], scanning: ["走査中", "blue"], interrupted: ["中断の可能性", "warn"],
  completed: ["完了", "good"], aborted_safety: ["安全弁で停止", "warn"], failed: ["失敗", "bad"], never: ["未実行", ""],
  declined: ["削除を見送り（次の走査で再確認）", ""],
};

// DF-11: 承認待ちは、この起動中の承認待ちと running の scanId が一致するときだけ。
// 承認待ちのまま強制終了した走査は、DBの行が列挙中の中断と同じ形になる（攻撃レビュー E8）。
// DBの形から推定して復旧の入口を隠すと、その接続先は走査できなくなる。
function runningKey(scanId, sourceId, state) {
  if (state?.pending && state.pending.scanId === scanId) return "review";
  if (!state?.pending && state?.progress?.sourceId === sourceId) return "scanning";
  return "interrupted";
}

function statusOf(key) {
  const [label, color] = LABELS[key] ?? [key, ""];
  return { key, label, color, action: key === "review" ? "review" : key === "interrupted" ? "recover" : "scan" };
}

export function sourceStatus(source, state) {
  return statusOf(source.running_id ? runningKey(source.running_id, source.source_id, state) : endedKey(source.latest_status ?? "never", source.latest_abort_reason, source.latest_approved_max_missing_count));
}

// 接続先の行と「最近の走査」で同じ判定を使う。片方だけ直すと同じ走査が2通りに表示される。
export function scanStatus(scan, state) {
  return statusOf(scan.status === "running" ? runningKey(scan.scan_id, scan.source_id, state) : endedKey(scan.status, scan.abort_reason, scan.approved_max_missing_count));
}

function endedKey(status, reason, limit) {
  const reasons = typeof reason === "string" ? reason.split(",") : [];
  // 見送りの上限0は正常な判断。終了時に別の障害も起きた場合は警告を消さない（DF-10/11）。
  return status === "aborted_safety" && limit === 0 && reasons.includes("approval_missing_limit") &&
    reasons.every((r) => ["approval_missing_limit", "count_ratio", "missing_ratio"].includes(r)) ? "declined" : status;
}

export function scanReason(scan, formatReason) {
  if (endedKey(scan.status, scan.abort_reason, scan.approved_max_missing_count) !== "declined") return formatReason(scan.abort_reason);
  return `${scan.approved_note === "運用画面の終了により削除を見送り" ? "運用画面の終了により" : "運用者の判断で"}削除を見送りました。次の走査で再確認します。`;
}

export function attentionCount(state) {
  return (state?.sources ?? []).filter((source) => ["interrupted", "failed", "aborted_safety"].includes(sourceStatus(source, state).key)).length;
}

export function renderDiscoveries(discovered, esc, number) {
  if (!discovered?.total) return "<p>この走査で新しく見つかったファイルはありません。</p>";
  return `<section><h3>この走査で新しく見つかったファイル ${number(discovered.total)} 件</h3><p>名前の変更や移動の可能性があります。上の削除候補と自動で対応付けていません。接続元で確認してください。</p><p>名前順の先頭 ${number(discovered.rows.length)} 件を表示（最大20件）</p><ul>${discovered.rows.map((row) => `<li>${esc(row.stable_key)}</li>`).join("")}</ul></section>`;
}

// 新規発見が多くても、判断対象である削除候補を画面の先頭側から確認できる順にする。
export function renderReviewLists(discovered, missingCount, esc, number) {
  return `<section aria-labelledby="deletion-candidates-heading"><h3 id="deletion-candidates-heading">削除候補 ${number(missingCount)} 件</h3><p class="form-help">この一覧が今回の判断対象です。新しく見つかったファイルは、その下に参考情報として表示します。</p><div id="candidates"></div></section>${renderDiscoveries(discovered, esc, number)}`;
}

// 見送りは内部的には安全弁停止として記録するが、同じ走査の画面内で判断名を食い違わせない。
export function observationTitle(kind, scanStatusKey, labels) {
  if (kind === "scan_aborted_safety" && scanStatusKey === "declined") return "削除を見送り";
  return labels[kind] ?? kind;
}

export function renderLiveNotice(state, esc, number) {
  let html = state.pending ? `<div class="notice"><div><strong>${number(state.pending.missingCount)} 件の削除候補があります</strong><br>対象と接続元を確認し、今回の処理を判断してください。</div><button class="primary" data-action="review">対象を確認・判断する →</button></div>` : state.busy ? `<div class="notice info"><div><strong>${state.progress?.phase === "parsing" ? "Word・Excelの内容を解析しています" : state.progress ? "走査を実行しています" : "点検・メンテナンスを実行しています"}</strong>${state.progress && state.progress.phase !== "parsing" ? `<br>列挙済み ${number(state.progress.seen)} 件 · 画面は自動更新されます` : ""}</div></div>` : "";
  if (state.lastScanError) html += `<div class="notice error"><div><strong>走査を完了できませんでした</strong><br>${esc(state.lastScanError)}</div><button data-page="sources">接続先を確認</button></div>`;
  if (state.lastReport?.tombstonedCount) html += `<div class="notice info">今回 ${number(state.lastReport.tombstonedCount)} 件を削除済みにしました。原本と版は保存されています。<button data-action="show-deleted">履歴を見る</button></div>`;
  if (state.lastReport && (state.lastReport.repairedBlobCount || state.lastReport.resumed || state.lastReport.recoveredScanId)) {
    const report = state.lastReport;
    html += `<div class="notice info"><div><strong>今回の復旧結果</strong><br>原本の修復 ${number(report.repairedBlobCount)} 件${report.recoveredScanId ? " / 中断した走査を終了して再走査" : ""}${report.resumed ? ` / 前回の削除反映の再開：${report.resumed.applied ? "反映済み" : "未完了"}（${number(report.resumed.tombstonedCount)} 件）` : ""}</div></div>`;
  }
  return html;
}

// DF-12: 「期限待ち」は、この画面がその版を解析していないのにリースが残っている場合の文言。
export function waitingMessage(view, progress) {
  return view.status === "waiting" && progress?.phase === "parsing" && progress.versionId === view.versionId
    ? "解析しています。終わると下に結果が表示されます。" : view.message;
}
