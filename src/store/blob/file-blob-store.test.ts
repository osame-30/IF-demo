/**
 * `FileBlobStore` の検査。
 *
 * 契約（`types.ts` の `BlobStore`）が「何を書けなくしているか」は
 * AC-BLB-01..06 が型の側で見ています。ここで見るのは**実際に走らせたときに
 * その4点が守られるか**です。型が正しくても、実装が上書きすれば同じことです。
 *
 * 実ファイルシステムを使います。fsync も rename も、置き換えたら
 * 確かめたいことが確かめられなくなるためです。
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { Readable } from "node:stream";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { FileBlobStore } from "./file-blob-store.ts";
import { blobPath } from "./blob-path.ts";
import { blobKeyOf } from "../../domain/ids.ts";
import { attestContentHash } from "../../domain/evidence.ts";
import { isStoreError, SizeMismatchError } from "../../domain/errors.ts";
import { TestClock } from "../../../test/support/clock.ts";
import type { BlobKey, ContentHash } from "../../domain/types.ts";

/** 空バイト列の sha256（FIXTURES.md #20 が固定値として名指ししている値） */
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

function streamOf(...chunks: ReadonlyArray<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** 途中で失敗するストリーム。ディスクを埋める必要はない（FIXTURES.md #21） */
function failingStream(prefix: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(prefix);
      controller.error(new Error("simulated write failure"));
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    parts.push(chunk.value);
  }
  return Buffer.concat(parts);
}

let root: string;
let clock: TestClock;
let store: FileBlobStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "blob-store-"));
  clock = new TestClock(1_700_000_000_000);
  store = new FileBlobStore({ root, clock });
});

afterEach(async () => {
  mock.restoreAll();
  syncBuiltinESMExports();
  await rm(root, { recursive: true, force: true });
});

/** 置き場所に手で実体を置く。フィクスチャ #8 が使う手口をテスト側でも使う */
async function placeByHand(key: BlobKey, content: string): Promise<string> {
  const path = blobPath(root, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  return path;
}

describe("FileBlobStore.put: 内容から鍵が決まる", () => {
  it("鍵は書いた内容のハッシュ。呼び出し側は鍵を渡していない", async () => {
    const bytes = bytesOf("hello");
    const result = await store.put(streamOf(bytes), bytes.byteLength);

    assert.equal(result.created, true);
    assert.equal(String(result.blobKey), String(attestContentHash(bytes)));
    assert.equal(result.sizeBytes, 5);
    assert.equal(result.verifiedAt, 1_700_000_000_000);
  });

  it("実体は blobPath の位置にある（パスを手で組み立てない）", async () => {
    const bytes = bytesOf("hello");
    const result = await store.put(streamOf(bytes), bytes.byteLength);
    assert.equal(await readFile(blobPath(root, result.blobKey), "utf8"), "hello");
  });

  it("空バイト列は正当な内容（#20）", async () => {
    // 0 と undefined を区別する。サイズで存在を判定していたら、ここが落ちる
    const result = await store.put(streamOf(), 0);
    assert.equal(result.created, true);
    assert.equal(String(result.blobKey), EMPTY_SHA256);
    assert.equal(result.sizeBytes, 0);
    assert.equal(await readFile(blobPath(root, result.blobKey), "utf8"), "");
  });

  it("分割されたストリームでも1つの鍵になる", async () => {
    const whole = await store.put(streamOf(bytesOf("hello")), 5);
    const split = await store.put(streamOf(bytesOf("he"), bytesOf("llo")), 5);
    assert.equal(String(split.blobKey), String(whole.blobKey));
    assert.equal(split.created, false, "2回目は新規ではない");
  });

  it("時刻はストアの時計から来る（呼び出し側は渡せない）", async () => {
    clock.advance(5_000);
    const result = await store.put(streamOf(bytesOf("x")), 1);
    assert.equal(result.verifiedAt, 1_700_000_005_000);
  });
});

describe("FileBlobStore.put: 冪等な再実行と食い違いが別に見える", () => {
  it("同じ内容の再 put は created:false（実体は増えない）", async () => {
    const bytes = bytesOf("same");
    const first = await store.put(streamOf(bytes), 4);
    const second = await store.put(streamOf(bytes), 4);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(String(second.blobKey), String(first.blobKey));

    const shard = dirname(blobPath(root, first.blobKey));
    assert.deepEqual(await readdir(shard), [
      String(first.blobKey).slice(2),
    ]);
  });

  it("鍵の位置に別内容があれば BlobDivergenceError（上書きも無言スキップもしない）", async () => {
    // #8 の形。鍵に対応する名前を持つが、中身が対応していない実体
    const bytes = bytesOf("real content");
    const key = blobKeyOf(attestContentHash(bytes));
    await placeByHand(key, "tampered");

    await assert.rejects(
      () => store.put(streamOf(bytes), bytes.byteLength),
      (error: unknown) => {
        assert.ok(isStoreError(error, "blob_divergence"), `想定外: ${String(error)}`);
        return true;
      },
    );

    // 拒んだうえで、既存を書き換えていない
    assert.equal(await readFile(blobPath(root, key), "utf8"), "tampered");
  });

  it("0バイトの hash 名ファイルも「存在するから正しい」にしない（#8）", async () => {
    // サイズや mtime で済ませていると、この空ファイルが正しい実体として通ります
    const bytes = bytesOf("real content");
    const key = blobKeyOf(attestContentHash(bytes));
    await placeByHand(key, "");

    await assert.rejects(
      () => store.put(streamOf(bytes), bytes.byteLength),
      (error: unknown) => isStoreError(error, "blob_divergence"),
    );
  });
});

describe("FileBlobStore.put: 申告と食い違うサイズを永続化しない（#7）", () => {
  it("申告より短ければ例外。実体は残らない", async () => {
    const bytes = bytesOf("hello");
    await assert.rejects(
      () => store.put(streamOf(bytes), 99),
      (error: unknown) => {
        assert.ok(isStoreError(error, "size_mismatch"), `想定外: ${String(error)}`);
        return true;
      },
    );
    assert.deepEqual(await readdir(root), ["tmp"], "内容アドレス名のディレクトリができていない");
  });

  it("食い違った2つの数を、メッセージではなく欄で渡す", async () => {
    // **駆動部はこの2つを数値で必要とします**（`IngestOutcome.size_mismatch`）。
    // 欄が無いと、メッセージから数字を取り出すしかありません。
    // それは errors.ts の冒頭に書いてある規則の逆です
    await assert.rejects(
      () => store.put(streamOf(bytesOf("hello")), 99),
      (error: unknown) => {
        assert.ok(error instanceof SizeMismatchError, `想定外: ${String(error)}`);
        assert.equal(error.declaredSizeBytes, 99);
        assert.equal(error.actualSizeBytes, 5);
        // 文面は2つの数から組み立てる。呼び出し側に書かせると食い違える
        assert.match(error.message, /99 bytes but read 5$/);
        return true;
      },
    );
  });

  it("0 と「申告なし」を取り違えない（#20）", async () => {
    // 空の内容に 0 以外を申告したら食い違い。0 が undefined 扱いされていたら通る
    await assert.rejects(() => store.put(streamOf(), 1), (error: unknown) => {
      assert.ok(error instanceof SizeMismatchError, `想定外: ${String(error)}`);
      assert.equal(error.declaredSizeBytes, 1);
      assert.equal(error.actualSizeBytes, 0, "0 が「値なし」に化けている");
      return true;
    });
  });

  it("書き込みが途中で失敗しても内容アドレス名は生まれない（#21）", async () => {
    await assert.rejects(() => store.put(failingStream(bytesOf("partial")), 7));

    // tmp 以外は1つもできていない。名前が内容を主張する中間物が無い
    assert.deepEqual(await readdir(root), ["tmp"]);
  });

  it("失敗した書き込みの一時ファイルを残さない", async () => {
    await assert.rejects(() => store.put(failingStream(bytesOf("partial")), 7));
    await assert.rejects(() => store.put(streamOf(bytesOf("hello")), 99));
    assert.deepEqual(await readdir(join(root, "tmp")), [], "一時ファイルが残っている");
  });
});

describe("FileBlobStore.verify: 実バイト列を読み直す", () => {
  it("一致すれば true", async () => {
    const bytes = bytesOf("audited");
    const result = await store.put(streamOf(bytes), bytes.byteLength);
    assert.equal(await store.verify(result.blobKey, result.contentHash), true);
  });

  it("実体が壊れていれば false（鍵の名前では判定しない）", async () => {
    const bytes = bytesOf("audited");
    const result = await store.put(streamOf(bytes), bytes.byteLength);
    await writeFile(blobPath(root, result.blobKey), "corrupted");
    assert.equal(await store.verify(result.blobKey, result.contentHash), false);
  });

  it("実体が無ければ false（例外にしない。監査は1件で止まらない）", async () => {
    assert.equal(await store.verify(EMPTY_SHA256 as BlobKey, EMPTY_SHA256 as ContentHash), false);
  });
});

describe("FileBlobStore.get: 証拠は読み切った者にだけ出る", () => {
  it("読み切れば証拠が出る", async () => {
    const bytes = bytesOf("payload");
    const put = await store.put(streamOf(bytes), bytes.byteLength);

    const read = await store.get(put.blobKey, put.contentHash);
    assert.equal(new TextDecoder().decode(await drain(read.stream)), "payload");
    assert.equal(String(await read.completed), String(put.contentHash));
  });

  it("途中でやめたら証拠は出ない（KNOWN_LIMITATIONS 11節）", async () => {
    // ここが tee で実装されていると、1バイトも読まなくても証拠が出ます
    const bytes = bytesOf("payload");
    const put = await store.put(streamOf(bytes), bytes.byteLength);

    const read = await store.get(put.blobKey, put.contentHash);
    await read.stream.cancel("caller changed its mind");
    await assert.rejects(() => read.completed, /cancelled before the end/);
  });

  it("実体が壊れていればストリーム自体がエラーで終わる", async () => {
    const bytes = bytesOf("payload");
    const put = await store.put(streamOf(bytes), bytes.byteLength);
    await writeFile(blobPath(root, put.blobKey), "corrupted");

    const read = await store.get(put.blobKey, put.contentHash);
    await assert.rejects(() => drain(read.stream), /content hash mismatch/);
    await assert.rejects(() => read.completed, /content hash mismatch/);
  });

  it("壊れた実体でも修復用の口なら読める（閉区画を作らない）", async () => {
    const bytes = bytesOf("payload");
    const put = await store.put(streamOf(bytes), bytes.byteLength);
    await writeFile(blobPath(root, put.blobKey), "corrupted");

    const raw = await store.getUnverifiedForRepair(put.blobKey);
    assert.equal(new TextDecoder().decode(await drain(raw)), "corrupted");
  });
});

describe("FileBlobStore.restoreFromVerifiedBytes: 正が一意に決まる場合だけ上書きする", () => {
  it("壊れた実体を正バイト列で置き換えられる", async () => {
    const bytes = bytesOf("payload");
    const put = await store.put(streamOf(bytes), bytes.byteLength);
    await writeFile(blobPath(root, put.blobKey), "corrupted");
    assert.equal(await store.verify(put.blobKey, put.contentHash), false);

    const restored = await store.restoreFromVerifiedBytes(
      put.blobKey,
      streamOf(bytes),
      bytes.byteLength,
    );
    assert.equal(String(restored.blobKey), String(put.blobKey));
    assert.equal(await store.verify(put.blobKey, put.contentHash), true);
  });

  it("鍵に対応しない内容は拒む（別内容での上書きは書けない）", async () => {
    const put = await store.put(streamOf(bytesOf("payload")), 7);
    const other = bytesOf("something else");

    await assert.rejects(
      () => store.restoreFromVerifiedBytes(put.blobKey, streamOf(other), other.byteLength),
      (error: unknown) => {
        assert.ok(isStoreError(error, "invalid_argument"), `想定外: ${String(error)}`);
        return true;
      },
    );
    assert.equal(await store.verify(put.blobKey, put.contentHash), true, "元の実体は無事");
  });
});

describe("FileBlobStore.delete: v0.1 では実装しない", () => {
  it("呼べば落ちる。契約だけが先にある", async () => {
    // 授権の発行元が LineageStore に無いので（AC-BLB-04）到達不能です。
    // 到達不能であることと、実装が無いことの両方を残します
    await assert.rejects(
      // @ts-expect-error 正規の経路で BlobDeletionGrant を作れないことが本題
      () => store.delete("00ab" as BlobKey, {}, {}),
      /not implemented in v0.1/,
    );
  });
});

/** 条件3: 本番に注入口は足さず、標準 I/O の境界で障害を起こす。 */
describe("条件3: 永続化と資源の後始末", () => {
  it("親ディレクトリ同期に失敗した put は、別インスタンスの再試行でも再同期する", async () => {
    const bytes = bytesOf("durable");
    const key = blobKeyOf(attestContentHash(bytes));
    const shard = dirname(blobPath(root, key));
    const originalOpen = fs.open;
    let attempts = 0;
    let successfulSyncs = 0;
    mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === shard) {
        const originalSync = handle.sync.bind(handle);
        mock.method(handle, "sync", async () => {
          attempts++;
          if (attempts === 1) throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
          await originalSync();
          successfulSyncs++;
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(() => store.put(streamOf(bytes), bytes.length), /directory sync failed/);
    assert.equal(attempts, 1);
    const retried = await new FileBlobStore({ root, clock }).put(streamOf(bytes), bytes.length);
    assert.equal(retried.created, false);
    // Windows は r の sync が拒まれると r+ でも試す。回数ではなく成功を数える。
    assert.ok(attempts >= 2);
    assert.equal(successfulSyncs, 1, "既存の実体を読んだだけでは未完了の fsync を取り戻せない");
  });

  it("put の成功後は入力ストリームの reader のロックを解放する", async () => {
    const input = streamOf(bytesOf("ok"));
    await store.put(input, 2);
    assert.equal(input.locked, false);
  });

  it("一時領域を作れない場合も入力を cancel してロックを解放する", async () => {
    await writeFile(join(root, "tmp"), "not a directory");
    let cancelled = false;
    const input = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    await assert.rejects(() => store.put(input, 0));
    assert.equal(cancelled, true);
    assert.equal(input.locked, false);
  });

  it("ディスク書き込みの失敗は読み残した入力を cancel する", async () => {
    let cancelled = false;
    const input = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(bytesOf("chunk")); },
      cancel() { cancelled = true; },
    });
    const originalOpen = fs.open;
    mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      if (args[1] === "wx") mock.method(handle, "write", async () => {
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      });
      return handle;
    });
    syncBuiltinESMExports();
    await assert.rejects(() => store.put(input, 5), /disk full/);
    assert.equal(cancelled, true);
    assert.equal(input.locked, false);
    assert.deepEqual(await readdir(join(root, "tmp")), []);
  });

  it("get の実読込が失敗すれば、stream と completed が両方 reject する", async () => {
    const put = await store.put(streamOf(bytesOf("payload")), 7);
    const originalOpen = fs.open;
    const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
    mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await originalOpen(...args);
      handles.push(handle);
      mock.method(handle, "createReadStream", () => Readable.from((async function* () {
        yield Buffer.from("partial");
        throw Object.assign(new Error("read EIO"), { code: "EIO" });
      })()));
      return handle;
    });
    syncBuiltinESMExports();
    try {
      const read = await store.get(put.blobKey, put.contentHash);
      await assert.rejects(() => drain(read.stream), /read EIO/);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const state = await Promise.race([
          read.completed.then(() => "resolved", () => "rejected"),
          new Promise<string>((resolve) => { timer = setTimeout(() => resolve("pending"), 500); }),
        ]);
        assert.equal(state, "rejected");
      } finally { clearTimeout(timer); }
    } finally { for (const handle of handles) await handle.close(); }
  });
});
