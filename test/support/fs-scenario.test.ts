import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { FsScenario, detectFsCapabilities } from "./fs-scenario.ts";
import type { EpochMs } from "../../src/domain/types.ts";

describe("fs-scenario", () => {
  it("宣言した構成をそのまま作る", async () => {
    await using fs = await FsScenario.create({
      "a.txt": "alpha",
      "sub/b.txt": "beta",
      "sub/deep/c.txt": "gamma",
    });
    assert.deepEqual(await fs.list(), ["a.txt", "sub/b.txt", "sub/deep/c.txt"]);
    assert.equal((await fs.read("sub/b.txt")).toString(), "beta");
  });

  it("空ファイルは正当な内容として作れる（#20）", async () => {
    await using fs = await FsScenario.create({ "empty.txt": "" });
    const stat = await fs.statOf("empty.txt");
    assert.equal(stat.sizeBytes, 0);
    // 空バイト列の sha256。FIXTURES.md #20 の固定値
    const hash = createHash("sha256").update(await fs.read("empty.txt")).digest("hex");
    assert.equal(hash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("mtime を過去に戻して内容だけ変えられる（#19）", async () => {
    const caps = await detectFsCapabilities();
    if (!caps.supportsMtimeInPast) return;

    await using fs = await FsScenario.create({ "a.txt": "old" });
    await fs.write("a.txt", { content: "new content", mtime: 1_000_000_000_000 as EpochMs });
    const stat = await fs.statOf("a.txt");
    assert.equal(stat.modifiedAt, 1_000_000_000_000);
    // 報告時刻が古くても内容は新しい。これを「スキップの根拠」にしてはいけない
    assert.equal((await fs.read("a.txt")).toString(), "new content");
  });

  it("modifiedAt は整数（EpochMs）で返る", async () => {
    await using fs = await FsScenario.create({ "a.txt": "x" });
    const stat = await fs.statOf("a.txt");
    assert.ok(Number.isSafeInteger(stat.modifiedAt), `${stat.modifiedAt} is not an integer`);
  });

  it("denyRead は実際に塞げたかを正直に返す（#17）", async () => {
    await using fs = await FsScenario.create({ "secret.txt": "x" });
    const denied = await fs.denyRead("secret.txt");
    const caps = await detectFsCapabilities();
    // 戻り値と実測した能力が食い違ってはいけない
    assert.equal(denied, caps.enforcesPermissions);

    if (denied) {
      await assert.rejects(() => fs.read("secret.txt"));
    } else {
      // 塞げない環境では読めてしまう。フィクスチャはここで経路を切り替える
      assert.equal((await fs.read("secret.txt")).toString(), "x");
    }
  });

  it("塞いだファイルがあっても cleanup できる", async () => {
    const fs = await FsScenario.create({ "dir/secret.txt": "x" });
    await fs.denyRead("dir/secret.txt");
    await fs.chmod("dir", 0o000);
    await assert.doesNotReject(() => fs.cleanup());
  });

  it("root の外へ出るパスを拒む", async () => {
    await using fs = await FsScenario.create();
    assert.throws(() => fs.path("../escape.txt"), /escapes the scenario root/);
    assert.throws(() => fs.path("sub/../../escape.txt"), /escapes the scenario root/);
  });

  it("rename で消失と出現を作れる（#24 の材料）", async () => {
    await using fs = await FsScenario.create({ "old.txt": "same bytes" });
    await fs.rename("old.txt", "new/renamed.txt");
    assert.deepEqual(await fs.list(), ["new/renamed.txt"]);
  });

  it("cleanup 後に一時ディレクトリが残らない", async () => {
    const fs = await FsScenario.create({ "a.txt": "x" });
    const root = fs.root;
    await fs.cleanup();
    const { access } = await import("node:fs/promises");
    await assert.rejects(() => access(root));
  });
});

describe("detectFsCapabilities", () => {
  it("推測ではなく実測した真偽値を返す", async () => {
    const caps = await detectFsCapabilities();
    for (const [key, value] of Object.entries(caps)) {
      assert.equal(typeof value, "boolean", `${key} is not a boolean`);
    }
  });

  it("同じ結果を返す（プロセス内で変わらない）", async () => {
    assert.deepEqual(await detectFsCapabilities(), await detectFsCapabilities());
  });

  it("#23 が fs で再現できるかどうかを表明できる", async () => {
    const caps = await detectFsCapabilities();
    // 大文字小文字を区別しない FS では、別名の2ファイルを作れない。
    // このとき #23 の再現は SourceAdapter 側で行う
    await using fs = await FsScenario.create({ "a.txt": "one" });
    await fs.write("A.TXT", "two");
    assert.equal((await fs.list()).length, caps.caseSensitive ? 2 : 1);
  });
});
