/** S5-75: 起動入口は内容の検査だけでなく、実際のcmdから到達できることを確かめる。 */
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

it("配布用cmdはcheckout後にもCRLFを保持する", async () => {
  const script = await readFile(new URL("../../start-ui.cmd", import.meta.url), "utf8");
  assert.ok(script.includes("\r\n"), "cmdにはCRLFが必要");
  assert.doesNotMatch(script, /(?<!\r)\n/, "LFだけの行末を混ぜない");
});

it("Windows: 空白を含む配置先の起動cmdが、配置先でnpmへ正しい引数を渡す", { skip: process.platform !== "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ingestion-launcher-"));
  const folder = join(root, "workspace with spaces"), result = join(root, "result.json");
  try {
    await mkdir(folder);
    const launcher = join(folder, "start-ui.cmd");
    await writeFile(launcher, await readFile(new URL("../../start-ui.cmd", import.meta.url)));
    // 通常のUIや保存先を起動しない。npmとの境界でcwdと引数を捕捉する。
    await writeFile(join(folder, "npm.cmd"), '@echo off\r\n"%LAUNCHER_TEST_NODE%" "%~dp0capture.mjs" %*\r\n');
    await writeFile(join(folder, "capture.mjs"), 'import {writeFileSync} from "node:fs"; writeFileSync(process.env.LAUNCHER_TEST_RESULT, JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));');
    // AC-EXHの計測用preloadを、依存の無い一時npm代役へ持ち込まない。
    const launcherEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_OPTIONS" && !key.startsWith("NODE_TEST_")));
    const run = spawnSync("cmd.exe", ["/d", "/s", "/c", `""${launcher}""`], {
      cwd: root, windowsHide: true, windowsVerbatimArguments: true, timeout: 10000, encoding: "utf8",
      env: { ...launcherEnv, NoDefaultCurrentDirectoryInExePath: "1", PATH: `${folder};${dirname(process.execPath)};${process.env.PATH ?? ""}`, LAUNCHER_TEST_NODE: process.execPath, LAUNCHER_TEST_RESULT: result },
      input: "\r\n",
    });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.deepEqual(JSON.parse(await readFile(result, "utf8")), { cwd: folder, args: ["run", "ui", "--", "--open"] });
  } finally {
    // 削除対象は自分で作った一時ルートだけに閉じる。
    assert.equal(dirname(root), tmpdir());
    await rm(root, { recursive: true, force: true });
  }
});
