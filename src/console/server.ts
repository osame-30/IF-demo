/** ローカル UI 専用。別サイトやLANから保存先を操作する入口にはしない。 */
import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConsoleService } from "./service.ts";
import { windowsFolderPicker } from "./folder-picker.ts";
import type { FolderPicker } from "./folder-picker.ts";

/** pickFolder を省略すると Windows だけ標準の選択画面を使う。null は参照ボタンを出さない。 */
export async function startConsole(options: { dataDir: string; port?: number; pickFolder?: FolderPicker | null }) {
  const pickFolder = options.pickFolder === undefined ? (process.platform === "win32" ? windowsFolderPicker() : null) : options.pickFolder;
  let picking: AbortController | undefined;
  let pickingTask: Promise<string | null> | undefined;
  let closing = false;
  let closeTask: Promise<void> | undefined;
  const service = await createConsoleService(options.dataDir);
  const token = randomBytes(32).toString("hex");
  let origin = "";
  let mutations: Promise<unknown> = Promise.resolve();
  let originalTransfers = 0;
  const assets = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/content-view.js", ["content-view.js", "text/javascript; charset=utf-8"]],
    ["/normalized-view.js", ["normalized-view.js", "text/javascript; charset=utf-8"]],
    ["/console-view.js", ["console-view.js", "text/javascript; charset=utf-8"]],
    ["/style.css", ["style.css", "text/css; charset=utf-8"]],
  ]);
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const json = (status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); };
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) { json(403, { error: "このPCの運用画面から操作してください" }); return; }
      const url = new URL(req.url ?? "/", origin);
      const asset = assets.get(url.pathname);
      if (asset && req.method === "GET") {
        res.writeHead(200, { "Content-Type": asset[1]! });
        res.end(await readFile(new URL(`./public/${asset[0]}`, import.meta.url))); return;
      }
      const auth = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${token}`);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { json(401, { error: "起動時に表示されたURLから開き直してください" }); return; }
      if (closing) { json(503, { error: "終了処理中です。起動し直してから操作してください" }); return; }
      const offset = Number(url.searchParams.get("offset") ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("ページ番号が不正です");
      if (req.method === "GET") {
        if (url.pathname === "/api/state") { json(200, { ...service.state(), canPickFolder: pickFolder !== null }); return; }
        if (url.pathname === "/api/documents") { json(200, service.documents(url.searchParams.get("q") ?? "", offset, url.searchParams.get("deleted") === "1")); return; }
        if (url.pathname === "/api/document") { json(200, service.document(url.searchParams.get("id") ?? "")); return; }
        if (url.pathname === "/api/content") { json(200, service.content(url.searchParams.get("versionId") ?? "")); return; }
        if (url.pathname === "/api/normalized") { json(200, service.normalized(url.searchParams.get("versionId") ?? "", url.searchParams.get("artifactId") || undefined)); return; }
        if (url.pathname === "/api/original") {
          // S5-74: 待ち行列もメモリも積み上げず、送信完了・切断まで原本GETを1件に限定する。
          if (originalTransfers) { res.setHeader("Retry-After", "1"); json(429, { error: "原本を取得中です。完了後にもう一度試してください。" }); return; }
          originalTransfers++;
          const controller = new AbortController();
          const cancel = () => controller.abort(new Error("原本取得の接続が終了しました。"));
          res.once("close", cancel);
          try {
            const original = await service.original(url.searchParams.get("versionId") ?? "", controller.signal);
            if (controller.signal.aborted) return;
            res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="original"; filename*=UTF-8''${encodeURIComponent(original.filename).replaceAll("'", "%27")}` });
            await new Promise<void>((resolve) => { res.once("finish", resolve); res.once("close", resolve); res.end(original.bytes); });
          } finally { res.off("close", cancel); originalTransfers--; }
          return;
        }
        if (url.pathname === "/api/observations") { json(200, service.observations(url.searchParams.get("scanId") ?? "")); return; }
        if (url.pathname === "/api/skipped-summary") { json(200, service.skippedSummary(url.searchParams.get("scanId") ?? "")); return; }
        if (url.pathname === "/api/candidates") { json(200, service.candidates(url.searchParams.get("scanId") ?? "", offset)); return; }
        if (url.pathname === "/api/export") { res.setHeader("Content-Disposition", 'attachment; filename="ingestion-diagnostics.json"'); json(200, service.state()); return; }
      }
      if (req.method !== "POST") { json(404, { error: "操作が見つかりません" }); return; }
      if (!req.headers["content-type"]?.startsWith("application/json")) { json(415, { error: "JSONで送信してください" }); return; }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        length += bytes.length;
        if (length > 16384) { json(413, { error: "入力が長すぎます" }); return; }
        chunks.push(bytes);
      }
      // HTTPのチャンク境界は文字境界ではない。日本語を壊さず、サイズはバイトで制限する。
      const body = Buffer.concat(chunks).toString("utf8");
      const input: unknown = JSON.parse(body || "{}");
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("入力形式が不正です");
      const data = input as Record<string, unknown>;
      // DF-15: 本文受信中に終了が始まった要求も、新しい操作には進めない。
      if (closing) { json(503, { error: "終了処理中です" }); return; }
      if (url.pathname === "/api/pick-folder") {
        // 利用者が選び終えるまで待つため、更新の順番待ちに入れない。返すのはパスだけで、登録は /api/sources の検査を通る。
        if (!pickFolder) { json(404, { error: "この環境ではフォルダの選択画面を使えません。パスを入力してください" }); return; }
        if (picking) { json(409, { error: "フォルダの選択画面がすでに開いています。その画面で選ぶか閉じてください" }); return; }
        const controller = new AbortController();
        picking = controller;
        const cancel = () => controller.abort(new Error("フォルダ選択の接続が終了しました"));
        res.once("close", cancel);
        try {
          let path: string | null;
          try { pickingTask = pickFolder(controller.signal); path = await pickingTask; }
          catch (error) { throw new Error(`フォルダの選択画面を開けませんでした: ${error instanceof Error ? error.message : String(error)}`); }
          if (res.destroyed) return;
          json(200, { path }); return;
        } finally { res.off("close", cancel); picking = undefined; pickingTask = undefined; }
      }
      // 非同期のフォルダ確認中にも別の更新を割り込ませない。走査自体は待たずに状態を返す。
      const action = async () => {
        if (closing) throw new Error("終了処理中です");
        switch (url.pathname) {
          case "/api/sources": return service.register(data);
          case "/api/scan": return service.start(data);
          case "/api/parse": return service.parse(data);
          case "/api/normalize": return service.normalize(data);
          case "/api/decision": return service.decide(data);
          case "/api/audit": return service.inspect();
          case "/api/backup": return service.backup();
          default: throw new Error("操作が見つかりません");
        }
      };
      const current = mutations.then(action);
      mutations = current.catch(() => undefined); // 個別の失敗は下でHTTP応答し、次の操作を塞がない。
      json(200, await current);
    } catch (error) { if (res.destroyed) return; if (!res.headersSent) json(400, { error: error instanceof Error ? error.message : String(error) }); else res.destroy(); }
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 4318, "127.0.0.1", resolve); });
  } catch (error) { await service.close(); throw error; }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("起動アドレスを取得できません");
  origin = `http://127.0.0.1:${address.port}`;
  return { origin, token, url: `${origin}/#${token}`, close() {
    if (closeTask) return closeTask;
    closing = true;
    closeTask = (async () => {
      picking?.abort(new Error("運用画面を終了しました"));
      // 選択のエラーは要求側で通知済み。終了では子プロセスの決着を待つ。
      await pickingTask?.catch(() => undefined);
      await mutations;
      await service.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    })();
    return closeTask;
  } };
}
