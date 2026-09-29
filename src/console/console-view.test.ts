/** 運用画面の状態表示。DBの行だけでは「承認待ち」と「中断」を区別できない（攻撃レビュー E8）。 */
import { it } from "node:test";
import assert from "node:assert/strict";
const { sourceStatus, scanStatus, attentionCount, waitingMessage, renderReviewLists, observationTitle } = await import(new URL("./public/console-view.js", import.meta.url).href);
const pick = (value: { key: string; action: string }) => ({ key: value.key, action: value.action });

const reviewing = { source_id: "a", latest_status: "running", running_id: "s1", root: "C:\\a" };
const pendingState = { pending: { scanId: "s1" }, progress: { sourceId: "a", phase: "review" } };

it("案内帯: 表示に無関係な更新ではHTMLが変わらず、必要な状態変化は反映する", async () => {
  const { renderLiveNotice } = await import(new URL("./public/console-view.js", import.meta.url).href);
  const esc = (s: string) => s.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const render = (state: any) => renderLiveNotice(state, esc, String);
  const pending = { pending: { scanId: "s1", missingCount: 1 } };
  assert.equal(render(pending), render({ ...structuredClone(pending), counts: { active: 99 } }));
  assert.match(render(pending), /data-action="review"/);
  assert.notEqual(render(pending), render({ pending: { scanId: "s1", missingCount: 2 } }));
  assert.notEqual(render({ busy: true, progress: { phase: "scanning", seen: 1 } }), render({ busy: true, progress: { phase: "scanning", seen: 2 } }));
  assert.match(render({ busy: true, progress: { phase: "parsing" } }), /内容を解析/);
  assert.match(render({ busy: true }), /点検・メンテナンス/);
  const failure = render({ ...pending, lastScanError: "<failure>" });
  assert.match(failure, /&lt;failure&gt;/); assert.ok(!failure.includes("<failure>"));
  assert.match(failure, /走査を完了できません/);
  assert.match(render({ lastReport: { tombstonedCount: 1, repairedBlobCount: 2, recoveredScanId: "s0", resumed: { applied: false, tombstonedCount: 3 } } }), /履歴を見る.*今回の復旧結果.*未完了/s);
  assert.equal(render({ busy: false, pending: null }), "");
});

it("新規発見表示: 件数と名前を示し、自動で改名を対応付けたとは表示しない", async () => {
  const { renderDiscoveries } = await import(new URL("./public/console-view.js", import.meta.url).href);
  const esc = (s: string) => s.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const html = renderDiscoveries({ total: 23, rows: [{ stable_key: "<new>.txt" }] }, esc, String);
  assert.match(html, /23 件/); assert.match(html, /先頭 1 件/);
  assert.match(html, /&lt;new&gt;\.txt/); assert.ok(!html.includes("<new>"));
  assert.match(html, /名前の変更や移動の可能性/); assert.match(html, /対応付けていません/);
});

it("削除候補を新規発見より先に、判断対象と分かる見出し付きで表示する", () => {
  const html = renderReviewLists({ total: 25, rows: [{ stable_key: "new.txt" }] }, 2, String, String);
  assert.match(html, /削除候補 2 件/);
  assert.match(html, /上の削除候補と自動で対応付けていません/);
  assert.match(html, /今回の判断対象/);
  assert.ok(html.indexOf('id="candidates"') < html.indexOf("この走査で新しく見つかったファイル 25 件"));
});

it("見送った走査の観測名だけを中立表示にし、別の安全弁停止は隠さない", () => {
  const labels = { scan_aborted_safety: "安全弁が停止" };
  assert.equal(observationTitle("scan_aborted_safety", "declined", labels), "削除を見送り");
  assert.equal(observationTitle("scan_aborted_safety", "aborted_safety", labels), "安全弁が停止");
});

it("見送り表示: 上限0の判断は中立で、終了時の理由も区別する", async () => {
  const { scanReason } = await import(new URL("./public/console-view.js", import.meta.url).href);
  for (const note of ["運用画面で削除を見送り", "運用画面の終了により削除を見送り"]) {
    const scan = { status: "aborted_safety", abort_reason: "approval_missing_limit,count_ratio,missing_ratio", approved_max_missing_count: 0, approved_note: note };
    const source = { latest_status: scan.status, latest_abort_reason: scan.abort_reason, latest_approved_max_missing_count: 0 };
    assert.equal(scanStatus(scan, {}).key, "declined");
    assert.equal(scanStatus(scan, {}).color, "");
    assert.match(scanStatus(scan, {}).label, /削除を見送り.*次の走査/);
    assert.equal(sourceStatus(source, {}).key, "declined");
    assert.equal(attentionCount({ sources: [source] }), 0);
    assert.match(scanReason(scan, (reason: string) => reason), /見送り.*次の走査/);
    assert.equal(scanReason(scan, (reason: string) => reason).includes("終了"), note.includes("終了"));
  }
});

it("見送り表示: 未承認・正の上限・別の障害を中立表示で隠さない", () => {
  for (const [status, reason, limit] of [
    ["aborted_safety", "count_ratio", null], ["aborted_safety", "approval_missing_limit", 1],
    ["aborted_safety", "count_ratio", 0], ["failed", "approval_missing_limit", 0],
    ["aborted_safety", "approval_missing_limit,write_failures", 0],
    ["aborted_safety", "approval_missing_limit,unlistable_subtree", 0],
    ["aborted_safety", "approval_missing_limit,future_failure", 0],
  ]) {
    const scan = { status, abort_reason: reason, approved_max_missing_count: limit };
    const source = { latest_status: status, latest_abort_reason: reason, latest_approved_max_missing_count: limit };
    assert.equal(scanStatus(scan, {}).key, status);
    assert.equal(sourceStatus(source, {}).key, status);
    assert.equal(attentionCount({ sources: [source] }), 1);
  }
});

it("DF-11: 承認待ちは、メモリ上の承認待ちと running の scanId が一致するときだけ", () => {
  assert.deepEqual(pick(sourceStatus(reviewing, pendingState)), { key: "review", action: "review" });
  assert.match(sourceStatus(reviewing, pendingState).label, /承認待ち/);
  // 承認待ちのまま強制終了した後。DBの行は running のまま、承認待ちはメモリから消えている
  const afterKill = sourceStatus(reviewing, { pending: null });
  assert.deepEqual(pick(afterKill), { key: "interrupted", action: "recover" });
  assert.match(afterKill.label, /中断/);
  // 別の接続先の承認待ちがあっても、残っている running の復旧入口を消さない
  const other = { source_id: "b", latest_status: "running", running_id: "s0", root: "C:\\b" };
  assert.deepEqual(pick(sourceStatus(other, pendingState)), { key: "interrupted", action: "recover" });
});

it("走査中はこの画面の進捗と一致するときだけ。完了・失敗は最新の状態をそのまま出す", () => {
  const scanning = { source_id: "b", latest_status: "running", running_id: "s2", root: "C:\\b" };
  assert.deepEqual(pick(sourceStatus(scanning, { pending: null, progress: { sourceId: "b", phase: "scanning" } })), { key: "scanning", action: "scan" });
  assert.deepEqual(pick(sourceStatus({ source_id: "c", latest_status: "failed", running_id: null, root: "C:\\c" }, { pending: null })), { key: "failed", action: "scan" });
  assert.deepEqual(pick(sourceStatus({ source_id: "d", latest_status: null, running_id: null, root: "C:\\d" }, { pending: null })), { key: "never", action: "scan" });
});

it("走査の履歴でも、承認待ちの走査を「中断の可能性」と表示しない（H）", () => {
  // 接続先の行だけ直すと、同じ画面の「最近の走査」に「走査中 / 中断の可能性」が残る（実画面で確認）
  assert.deepEqual(pick(scanStatus({ scan_id: "s1", status: "running", source_id: "a" }, pendingState)), { key: "review", action: "review" });
  assert.deepEqual(pick(scanStatus({ scan_id: "s1", status: "running", source_id: "a" }, { pending: null })), { key: "interrupted", action: "recover" });
  assert.deepEqual(pick(scanStatus({ scan_id: "s2", status: "running", source_id: "b" }, { pending: null, progress: { sourceId: "b", phase: "scanning" } })), { key: "scanning", action: "scan" });
  assert.deepEqual(pick(scanStatus({ scan_id: "s3", status: "completed", source_id: "a" }, pendingState)), { key: "completed", action: "scan" });
});

it("確認が必要な接続先に、承認待ち・走査中・完了を数えない", () => {
  const sources = [
    reviewing,
    { source_id: "b", latest_status: "running", running_id: "s0", root: "C:\\b" },
    { source_id: "c", latest_status: "failed", running_id: null, root: "C:\\c" },
    { source_id: "d", latest_status: "aborted_safety", running_id: null, root: "C:\\d" },
    { source_id: "e", latest_status: "completed", running_id: null, root: "C:\\e" },
  ];
  assert.equal(attentionCount({ ...pendingState, sources }), 3);
});

it("DF-12: 期限待ちの文言は、この画面がその版を解析していないときだけ", () => {
  const view = { status: "waiting", versionId: "v1", message: "解析中、または中断した試行の期限待ちです。" };
  assert.match(waitingMessage(view, { phase: "parsing", versionId: "v1" }), /解析しています/);
  assert.equal(waitingMessage(view, { phase: "parsing", versionId: "v2" }), view.message);
  assert.equal(waitingMessage(view, undefined), view.message);
  assert.equal(waitingMessage({ status: "failed", versionId: "v1", message: "失敗" }, { phase: "parsing", versionId: "v1" }), "失敗");
});
