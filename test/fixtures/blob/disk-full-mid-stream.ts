/**
 * 攻撃 #21 — 書き込みが途中で終わった実体が、内容アドレス名を持ってしまう。
 *
 * 元の穴: `put` が最終名で直接書いた。途中でディスクが埋まる（あるいは
 * プロセスが落ちる）と、**正しい hash の名前を持つ切れたファイル**が残る。
 * 次の `put` は「その鍵はもうある」と読んで書き込みを飛ばし、
 * 切れた内容がその鍵の正体として確定する。
 *
 * 防御は名前の付け方そのものにあります。`put` は乱数名の一時ファイルへ
 * 書き、fsync し、**読み直して**ハッシュとサイズを確かめてから rename します
 * （`file-blob-store.ts` の7手順）。途中生成物は内容アドレス名を一切
 * 持たないので、失敗した書き込みが「その鍵の実体」に見えることがありません。
 *
 * ## 版が立たないのは「拒んだ」からではありません
 *
 * `DocumentVersion.blobVerifiedAt` は `VerifiedAt` 型で、
 * `attestPersisted` を通らなければ作れません。`attestPersisted` は
 * `VerifiedContentHash` を要求し、それを出せるのは読み切った側だけです。
 * **失敗した `put` からは `PutResult` が返らないので、版に必要な値が
 * そもそも手に入りません。** 型の上で経路が無いということです。
 *
 * FIXTURES.md が書いている通り、実際にディスクを埋める必要はありません。
 * `ReadableStream` を途中で `error()` させれば同じ状態になります。
 */

import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";

import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import { isEmptyDiff, diffSnapshots } from "../../support/state-snapshot.ts";
import type { InvariantName, SourceId } from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = ["NO_VERSION_WITHOUT_VERIFIED_BLOB"];

const SRC = "vault-fragile" as SourceId;
const GOOD_KEY = "good.txt";
const GOOD_BODY = "this one lands";
const TORN_BODY = "this one is cut off half way through";

/** 途中で失敗するストリーム。ディスクを埋める必要はない（FIXTURES.md #21） */
function failingStream(prefix: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(prefix));
      controller.error(new Error("no space left on device (simulated)"));
    },
  });
}

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC);
  const scan = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  await ctx.ingest(scan.scanId, GOOD_KEY, GOOD_BODY);
  await ctx.store.finishScan(scan.scanId, {
    enumeratedCount: 1,
    distinctCount: 1,
    writeFailureCount: 0,
  });
  assert.equal(ctx.count("document_version"), 1);
}

export async function execute(ctx: FixtureContext): Promise<void> {
  const before = await ctx.snapshot();
  const shardsBefore = (await readdir(ctx.blobRoot)).sort();

  // --- 攻撃: 書き込みが途中で終わる ---
  await assert.rejects(
    () => ctx.blobs.put(failingStream(TORN_BODY.slice(0, 10)), TORN_BODY.length),
    /no space left on device/,
    "失敗は失敗として届く。握りつぶさない",
  );

  // --- 内容アドレス名が1つも生まれていない ---
  // 生まれていたら、次の put が「もうある」と読んで切れた内容を確定させる
  const shardsAfter = (await readdir(ctx.blobRoot)).sort();
  assert.deepEqual(shardsAfter, shardsBefore, "失敗した書き込みが shard を作っている");

  // 一時ファイルも残っていない。乱数名なので鍵にはならないが、溜まると困る
  assert.deepEqual(await readdir(`${ctx.blobRoot}/tmp`), [], "一時ファイルが残っている");

  // --- 同じ鍵で再挑戦すると、今度は普通に置ける ---
  // 「もうある」で飛ばされていたら、ここで created:false が返ります
  const retry = await ctx.putBlob(TORN_BODY);
  assert.equal(retry.sizeBytes, Buffer.byteLength(TORN_BODY, "utf8"));
  assert.equal(
    await ctx.blobs.verify(retry.blobKey, retry.contentHash),
    true,
    "切れた内容がその鍵の正体になっていない",
  );

  // --- 版は1件も増えていない ---
  // 失敗した put からは PutResult が返らないので、blobVerifiedAt を作れません。
  // 「拒んだ」のではなく「型の上で経路が無い」ことが理由です
  assert.equal(ctx.count("document_version"), 1, "失敗した書き込みから版が立っている");

  // 置いただけでは状態は動かない。blob は系譜の外側にある
  const afterPut = await ctx.snapshot();
  assert.ok(
    isEmptyDiff(diffSnapshots(before, afterPut)),
    "blob を置いただけで DB の状態が動いている",
  );
}
