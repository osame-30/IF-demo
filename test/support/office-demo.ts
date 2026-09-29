/** 公開してよい架空資料だけを使う、⑤の手動実演用入口。毎回別の保存先を作る。 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wordSample, excelSample } from "./office-samples.ts";
import { startConsole } from "../../src/console/server.ts";
import { setTimeout as delay } from "node:timers/promises";

const root = await mkdtemp(join(tmpdir(), "ingestion-stage5-demo-")), input = join(root, "資料");
await mkdir(input);
await writeFile(join(input, "労災の記録（架空）.docx"), wordSample());
await writeFile(join(input, "履歴書（架空）.xlsx"), excelSample());
await writeFile(join(input, "読めない資料.docx"), "これは破損資料の動作確認用です。");
const app = await startConsole({ dataDir: join(root, "data"), port: 0 });
async function api(path: string, data?: unknown) {
  const response = await fetch(`${app.origin}/api/${path}`, { headers: { Authorization: `Bearer ${app.token}`, "Content-Type": "application/json" }, ...(data === undefined ? {} : { method: "POST", body: JSON.stringify(data) }) });
  if (!response.ok) throw new Error(`実演準備に失敗しました: ${await response.text()}`);
  return response.json();
}
const source = await api("sources", { root: input, name: "⑤の体験用・架空資料" });
if (!source || typeof source !== "object" || !("sourceId" in source)) throw new Error("接続先の登録結果が不正です");
await api("scan", { sourceId: source.sourceId });
for (;;) { const state = await api("state"); if (!state || typeof state !== "object" || !("busy" in state)) throw new Error("走査状態が不正です"); if (!state.busy) break; await delay(100); }
console.log(JSON.stringify({ url: app.url, root, input }));
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void app.close(); });
