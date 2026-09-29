/** 参照ボタン: 選択画面はパスを入力欄に返すだけで、登録の門を通さずに接続しない。 */
import { it } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startConsole } from "./server.ts";
import { parsePickerOutput } from "./folder-picker.ts";
import type { FolderPicker } from "./folder-picker.ts";

async function setup(t: TestContext, pickFolder: FolderPicker | null) {
  const root = await mkdtemp(join(tmpdir(), "folder-picker-"));
  const input = join(root, "input"); await mkdir(input);
  const dataDir = join(root, "data");
  const app = await startConsole({ dataDir, port: 0, pickFolder });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => { await close(); await rm(root, { recursive: true, force: true }); });
  const post = (path: string, data: unknown = {}) => fetch(`${app.origin}/api/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${app.token}`, "Content-Type": "application/json" }, body: JSON.stringify(data),
  });
  const state = async () => (await fetch(`${app.origin}/api/state`, { headers: { Authorization: `Bearer ${app.token}` } })).json() as Promise<any>;
  return { root, input, dataDir, app, post, state, close };
}

/** 呼び出しを外から決着させる代役。本物の選択画面は開かない。 */
function controllablePicker() {
  const calls: { signal: AbortSignal; resolve: (value: string | null) => void; reject: (error: Error) => void }[] = [];
  const picker: FolderPicker = (signal) => new Promise((resolve, reject) => { calls.push({ signal, resolve, reject }); });
  return { picker, calls };
}

const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(predicate(), "代役の選択画面が呼ばれない");
};

it("参照: トークンなし・別サイトからは選択画面を開けない", async (t) => {
  const { picker, calls } = controllablePicker();
  const { app } = await setup(t, picker);
  assert.equal((await fetch(`${app.origin}/api/pick-folder`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await fetch(`${app.origin}/api/pick-folder`, { method: "POST", headers: { Authorization: `Bearer ${app.token}`, Origin: "https://outside.example", "Content-Type": "application/json" }, body: "{}" })).status, 403);
  assert.equal(calls.length, 0);
});

it("参照: 選んだパスを返すだけで登録せず、登録は既存の検査を通る", async (t) => {
  const { picker, calls } = controllablePicker();
  const { input, dataDir, post, state } = await setup(t, picker);
  assert.equal((await state()).canPickFolder, true);
  const picking = post("pick-folder");
  await waitFor(() => calls.length === 1);
  calls[0]!.resolve(input);
  const res = await picking;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { path: input });
  assert.equal((await state()).counts.sources, 0, "参照しただけで接続しない");
  assert.equal((await post("sources", { root: input })).status, 200);

  // 選択画面が保存先を返しても、登録時の重なり検査で拒否される。
  const again = post("pick-folder");
  await waitFor(() => calls.length === 2);
  calls[1]!.resolve(dataDir);
  assert.deepEqual(await (await again).json(), { path: dataDir });
  assert.equal((await post("sources", { root: dataDir })).status, 400);
});

it("参照: キャンセルは未選択として返す", async (t) => {
  const { picker, calls } = controllablePicker();
  const { post } = await setup(t, picker);
  const picking = post("pick-folder");
  await waitFor(() => calls.length === 1);
  calls[0]!.resolve(null);
  const res = await picking;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { path: null });
});

it("参照: 開いている間は2つ目を開かず、他の操作を止めない", async (t) => {
  const { picker, calls } = controllablePicker();
  const { input, post, state } = await setup(t, picker);
  const first = post("pick-folder");
  await waitFor(() => calls.length === 1);
  const second = await post("pick-folder");
  assert.equal(second.status, 409);
  assert.match(((await second.json()) as any).error, /選択画面/);
  assert.equal(calls.length, 1);
  // 選択画面を開いたまま放置しても、登録・状態取得は待たされない。
  assert.equal((await post("sources", { root: input })).status, 200);
  assert.equal((await state()).counts.sources, 1);
  calls[0]!.resolve(null);
  assert.equal((await first).status, 200);
  const third = post("pick-folder");
  await waitFor(() => calls.length === 2);
  calls[1]!.resolve(null);
  assert.equal((await third).status, 200);
});

it("参照: 選択画面の失敗は理由を返し、次の選択を塞がない", async (t) => {
  const { picker, calls } = controllablePicker();
  const { post } = await setup(t, picker);
  const failing = post("pick-folder");
  await waitFor(() => calls.length === 1);
  calls[0]!.reject(new Error("起動できない"));
  const res = await failing;
  assert.equal(res.status, 400);
  assert.match(((await res.json()) as any).error, /フォルダの選択画面を開けませんでした.*起動できない/);
  const next = post("pick-folder");
  await waitFor(() => calls.length === 2);
  calls[1]!.resolve(null);
  assert.equal((await next).status, 200);
});

it("参照: 選択画面を使えない環境ではボタンを出さず、操作も拒否する", async (t) => {
  const { post, state } = await setup(t, null);
  assert.equal((await state()).canPickFolder, false);
  assert.equal((await post("pick-folder")).status, 404);
});

it("参照: サーバー終了時に開いたままの選択画面を閉じさせる", async (t) => {
  const { picker, calls } = controllablePicker();
  const { post, close } = await setup(t, picker);
  const picking = post("pick-folder").catch(() => undefined);
  await waitFor(() => calls.length === 1);
  assert.equal(calls[0]!.signal.aborted, false);
  calls[0]!.signal.addEventListener("abort", () => calls[0]!.resolve(null));
  await close();
  assert.equal(calls[0]!.signal.aborted, true);
  await picking;
});

it("参照: 選択画面の出力は、絶対パスか未選択だけを受け取る", () => {
  const encode = (path: string) => `OK:${Buffer.from(path, "utf8").toString("base64")}\r\n`;
  const windowsPath = "C:\\資料 フォルダ\\労災①";
  assert.equal(parsePickerOutput(encode(windowsPath), "win32"), windowsPath);
  assert.equal(parsePickerOutput("CANCEL\r\n", "win32"), null);
  assert.throws(() => parsePickerOutput(encode("相対\\パス"), "win32"), /絶対パス/);
  assert.throws(() => parsePickerOutput("", "win32"), /選択結果/);
  assert.throws(() => parsePickerOutput("OK:@@@", "win32"), /選択結果/);
  assert.throws(() => parsePickerOutput(`${encode(windowsPath)}CANCEL\r\n`, "win32"), /選択結果/);
});

it("DF-14: 参照のHTTP切断で選択を中断し、次の参照が使える", async (t) => {
  const { picker, calls } = controllablePicker();
  const { app, post } = await setup(t, picker);
  const controller = new AbortController();
  const first = fetch(`${app.origin}/api/pick-folder`, { method: "POST", headers: { Authorization: `Bearer ${app.token}`, "Content-Type": "application/json" }, body: "{}", signal: controller.signal }).catch(() => undefined);
  await waitFor(() => calls.length === 1);
  calls[0]!.signal.addEventListener("abort", () => calls[0]!.resolve(null));
  controller.abort(); await first;
  await waitFor(() => calls[0]!.signal.aborted);
  const next = post("pick-folder");
  await waitFor(() => calls.length === 2);
  calls[1]!.resolve(null);
  assert.equal((await next).status, 200);
});

it("DF-15: 終了開始後は新しい参照を受け付けず、終了は繰り返し呼べる", async (t) => {
  const { picker, calls } = controllablePicker();
  const { post, app, close } = await setup(t, picker);
  const first = post("pick-folder").catch(() => undefined);
  await waitFor(() => calls.length === 1);
  const closing = close();
  await waitFor(() => calls[0]!.signal.aborted);
  const next = await post("pick-folder").catch(() => undefined);
  assert.ok(!next || next.status === 503);
  assert.equal(calls.length, 1);
  calls[0]!.resolve(null);
  await first; await closing; await app.close();
});
