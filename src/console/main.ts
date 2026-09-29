import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { startConsole } from "./server.ts";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
function option(name: string) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
const dataDir = resolve(option("--data-dir") ?? join(process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share"), "IngestionFrame"));
const port = Number(option("--port") ?? 4318);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("port が不正です");
const app = await startConsole({ dataDir, port });
console.log(`\nIngestion Frame 運用コンソール\n${app.url}\n保存先: ${dataDir}\n終了: Ctrl+C\n`);
if (args.includes("--open")) {
  // 起動URLはこのプロセスが作ったloopbackだけ。接続フォルダをコマンドに載せない。
  const [command, parameters] = process.platform === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", app.url]] as const
    : process.platform === "darwin" ? ["open", [app.url]] as const : ["xdg-open", [app.url]] as const;
  const opener = spawn(command, [...parameters], { windowsHide: true, stdio: "ignore" });
  opener.on("error", (error) => { console.error("ブラウザを開けませんでした。上のURLを開いてください。", error.message); });
}
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  if (closing) return;
  closing = true;
  void app.close().then(() => { process.exitCode = 0; }, (error: unknown) => { console.error(error); process.exitCode = 1; });
});
