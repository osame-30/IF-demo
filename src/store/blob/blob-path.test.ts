/**
 * `blobPath` の検査。**ここで守っているのは配置の形と、root からの脱出です。**
 *
 * 鍵はそのままパスの一部になります。`blobKeyOf` を通った鍵は小文字16進ですが、
 * `lineage-store.ts` は DB の行から鍵を作り直すので、そちらは検査されていません。
 * 脱出できる鍵が1つでも通れば、置き場所の外を読み書きできます。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join, isAbsolute, relative } from "node:path";

import { blobPath } from "./blob-path.ts";
import { blobKeyOf } from "../../domain/ids.ts";
import { attestContentHash } from "../../domain/evidence.ts";
import type { BlobKey, ContentHash } from "../../domain/types.ts";

const ROOT = join("/var", "lib", "ingestion", "blob");
/** 空バイト列の sha256（FIXTURES.md #20 が固定値として名指ししている値） */
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("blobPath: 2文字 sharding", () => {
  it("先頭2文字がディレクトリ、残りがファイル名", () => {
    assert.equal(
      blobPath(ROOT, EMPTY as BlobKey),
      join(ROOT, "e3", "b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
    );
  });

  it("同じ鍵は必ず同じパス", () => {
    assert.equal(blobPath(ROOT, EMPTY as BlobKey), blobPath(ROOT, EMPTY as BlobKey));
  });

  it("先頭2文字が違えばディレクトリが分かれる", () => {
    // 分かれていなければ sharding は名前だけのものになる
    const a = blobPath(ROOT, "aabbcc" as BlobKey);
    const b = blobPath(ROOT, "abbbcc" as BlobKey);
    assert.notEqual(a, b);
    assert.equal(relative(ROOT, a).split("\\").join("/").split("/")[0], "aa");
    assert.equal(relative(ROOT, b).split("\\").join("/").split("/")[0], "ab");
  });

  it("鍵の文字はすべてパスに現れる（捨てていない）", () => {
    // shard に使った2文字を落とすと、別の鍵が同じパスに落ちる
    const value = "abc123";
    const path = blobPath(ROOT, value as BlobKey);
    assert.equal(relative(ROOT, path).split("\\").join("").split("/").join(""), value);
  });
});

describe("blobPath: root から出られない", () => {
  const escapes: ReadonlyArray<[string, string]> = [
    ["..", "親へ登る"],
    ["../../etc/passwd", "相対で外へ出る"],
    ["/etc/passwd", "絶対パス"],
    ["a/b", "区切りを含む"],
    ["ABCDEF", "大文字16進"],
    ["", "空"],
    ["ab", "shard で使い切って残りが空"],
    ["a", "shard に足りない"],
    ["g0g0g0", "16進でない文字"],
    ["blob/e3b0c4", "以前フィクスチャが使っていた形"],
  ];

  for (const [key, why] of escapes) {
    it(`${JSON.stringify(key)} は例外（${why}）`, () => {
      assert.throws(() => blobPath(ROOT, key as BlobKey), /lowercase hex/);
    });
  }

  it("通った鍵のパスは必ず root の下にある", () => {
    // 上の列挙は「思いついた脱出」しか見ていません。通った側からも確かめる
    for (const key of [EMPTY, "abc", "000", "fff", "0123456789abcdef"]) {
      const path = blobPath(ROOT, key as BlobKey);
      const outside = relative(ROOT, path);
      assert.ok(!outside.startsWith(".."), `root の外に出た: ${path}`);
      assert.ok(!isAbsolute(outside), `root から切れている: ${path}`);
    }
  });
});

describe("blobPath: blobKeyOf との対が食い違わない", () => {
  it("blobKeyOf が作った鍵は必ずパスにできる", () => {
    // 2箇所で別々に鍵の形を検査しています。片方だけが厳しくなると、
    // 正規の経路で作った鍵が置けなくなります（AGENTS.md 9節 軸0）
    for (const text of ["", "a", "日本語", "x".repeat(1000)]) {
      const key = blobKeyOf(attestContentHash(new TextEncoder().encode(text)));
      assert.doesNotThrow(() => blobPath(ROOT, key));
    }
  });

  it("空バイト列の鍵は FIXTURES.md #20 の固定値と一致する", () => {
    // 固定値をここにも置くのは、上のループが「両方同時に壊れた」場合に
    // 気づけないためです。片方は外から与えた値で釘を打つ
    assert.equal(String(blobKeyOf(attestContentHash(new Uint8Array()))), EMPTY);
  });

  it("blobKeyOf を通らない鍵は blobPath で止まる", () => {
    // DB から作り直された鍵（lineage-store.ts の `as BlobKey`）はここしか通りません
    assert.throws(() => blobPath(ROOT, "b1" as BlobKey), /lowercase hex/);
    assert.throws(() => blobKeyOf("../x" as ContentHash), /lowercase hex/);
  });
});
