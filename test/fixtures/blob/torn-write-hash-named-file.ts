/**
 * 攻撃 #8 — 正しい hash の名前を持つ、中身の違うファイル。
 *
 * 元の穴: blob の置き場所に、正しい鍵の名前を持つ 0 バイトのファイルが
 * 残っていた（前回の切れた書き込み、バックアップの取りこぼし、手作業）。
 * `put` は「その鍵はもうある」と読んで書き込みを飛ばし、版はその鍵を指した。
 * **「存在する」を「正しい」の証拠として使った瞬間に壊れます**
 * （AGENTS.md 3.7）。
 *
 * 防御は2段です。
 *
 *   1. `put` は既存の実体を**読み直して**ハッシュを突き合わせます。
 *      サイズや mtime では済ませません。0バイトのファイルも切れた
 *      ファイルも、サイズ判定はそのまま通します。
 *   2. 食い違ったら `BlobDivergenceError`。**上書きも無言のスキップも
 *      しません。** どちらが正しいかを `put` は言えないからです。
 *
 * ## 上書きしてよい口は別にあります
 *
 * `restoreFromVerifiedBytes` は上書きします。あちらは供給された
 * バイト列のハッシュが鍵に対応しなければ拒むので、書ける内容が
 * その鍵の正しい内容ただ1つに決まります。`put` が拒むのは
 * 「どちらが正か言えない」からで、修復では正が一意に決まります。
 *
 * ## 探りは元に戻します
 *
 * 後半で既存の実体を壊しますが、`HASH_MATCHES_BLOB` が破れたまま
 * 終わってはいけないので修復して戻します。破れたまま終える形
 * （`expectedViolations`）は #11 の1本だけに限られています。
 */

import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import { blobPath } from "../../../src/store/blob/blob-path.ts";
import { blobKeyOf } from "../../../src/domain/ids.ts";
import { isStoreError } from "../../../src/domain/errors.ts";
import { diffSnapshots, isEmptyDiff } from "../../support/state-snapshot.ts";
import type { InvariantName, SourceId } from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = [
  "HASH_MATCHES_BLOB",
  "NO_VERSION_WITHOUT_VERIFIED_BLOB",
];

const SRC = "vault-torn" as SourceId;
const GOOD_KEY = "good.txt";
const GOOD_BODY = "a document that was stored correctly";
/** まだ置かれていない内容。この鍵の位置に手で 0 バイトのファイルを置く */
const INCOMING_BODY = "a document that is about to be stored";

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
  // --- 攻撃①: 正しい鍵の名前を持つ 0 バイトのファイルを手で置く ---
  // パスは blobPath で導出する。手で組み立てると、配置を変えたときに
  // このフィクスチャだけが古い場所を見て緑のままになる
  const tornKey = blobKeyOf(ctx.hashOf(INCOMING_BODY));
  const tornPath = blobPath(ctx.blobRoot, tornKey);
  await mkdir(dirname(tornPath), { recursive: true });
  await writeFile(tornPath, "");
  assert.equal((await stat(tornPath)).size, 0, "前提: 0 バイトで置けている");

  const before = await ctx.snapshot();

  // put は「もうある」で飛ばさない。読み直して食い違いを見つける
  await assert.rejects(
    () => ctx.putBlob(INCOMING_BODY),
    (error: unknown) => {
      assert.ok(isStoreError(error, "blob_divergence"), `想定外: ${String(error)}`);
      return true;
    },
    "0バイトの実体が正しい内容として通っている",
  );

  // 拒んだうえで、既存を書き換えていない。どちらが正かを put は言えない
  assert.equal((await stat(tornPath)).size, 0, "put が黙って上書きした");

  // --- 版は立っていない ---
  // put が失敗した以上 PutResult が無く、blobVerifiedAt を作る経路がありません
  assert.equal(ctx.count("document_version"), 1, "切れた実体から版が立っている");
  assert.ok(
    isEmptyDiff(diffSnapshots(before, await ctx.snapshot())),
    "拒否した put が状態を動かしている",
  );

  // 切れたファイルはディスクに残ります。**誰も参照していないので
  // invariant-checker からは見えません。** 検査は version と artifact の
  // 行を起点に走るので、参照ゼロの実体は走査の対象外です。
  // 掃除は GC の仕事で、v0.1 は GC を持ちません（AGENTS.md 2節）
  assert.equal((await stat(tornPath)).size, 0, "残骸はそのまま残る");

  // --- 攻撃②（探り）: 参照されている実体を壊す ---
  // ここが HASH_MATCHES_BLOB の本番です。上の①は版が立たないので、
  // 検査対象の行が1つも増えません。壊れた実体を**検査が見る位置**に
  // 作らないと、この不変条件が働いていることを確かめられません
  const good = ctx.one<{ blob_key: string; content_hash: string }>(
    `SELECT dv.blob_key, dv.content_hash
       FROM document_version dv JOIN document d ON d.document_id = dv.document_id
      WHERE d.stable_key = ?`,
    GOOD_KEY,
  );
  assert.ok(good, "前提: 良い版がある");
  const goodKey = good.blob_key as typeof tornKey;
  const goodHash = good.content_hash as Parameters<typeof ctx.blobs.verify>[1];
  const goodPath = blobPath(ctx.blobRoot, goodKey);

  assert.equal(await ctx.blobs.verify(goodKey, goodHash), true, "前提: 壊す前は通る");
  await writeFile(goodPath, "");
  assert.equal(
    await ctx.blobs.verify(goodKey, goodHash),
    false,
    "0バイトに化けた実体が検証を通っている。サイズで判定していないか",
  );

  // --- 修復: 正が一意に決まるので上書きしてよい ---
  const restored = await ctx.blobs.restoreFromVerifiedBytes(
    goodKey,
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(GOOD_BODY));
        controller.close();
      },
    }),
    Buffer.byteLength(GOOD_BODY, "utf8"),
  );
  assert.equal(String(restored.blobKey), String(goodKey));
  assert.equal(await ctx.blobs.verify(goodKey, goodHash), true, "修復できていない");
  assert.equal(await readFile(goodPath, "utf8"), GOOD_BODY);

  // 探りの痕跡を DB に残していない
  assert.ok(
    isEmptyDiff(diffSnapshots(before, await ctx.snapshot())),
    "探りが状態を動かしている",
  );
}
