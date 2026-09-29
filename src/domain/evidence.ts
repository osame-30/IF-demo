/**
 * 証拠値の鋳造。**このファイルが唯一の鋳造元です。**
 *
 * `VerifiedContentHash` と `VerifiedAt` は「どうやって手に入れたか」を
 * 型で運ぶ値です。どこでも `as` で作れるなら、運んでいるのは何でもありません。
 * ここ以外での `as VerifiedContentHash` / `as VerifiedAt` は
 * `test/types/evidence.test.ts`（AC-EVD-01）が落とします。
 *
 * **ブランドを private にしても閉じません（実測）。** `VerifiedContentHash` は
 * `string` の部分型なので、ブランドの記号を隠しても `as` は通ります。
 * 閉じているのは秘匿ではなく**構文の検査**のほうです（AGENTS.md 9節）。
 *
 * すべて純関数。I/O も時計も持ちません。
 */

import { createHash } from "node:crypto";

import type { ContentHash, EpochMs, VerifiedAt, VerifiedContentHash } from "./types.ts";

/**
 * バイト列を読み切ってハッシュを計算する。**証拠の入口。**
 *
 * 引数がバイト列であることが要点です。ハッシュ文字列を受け取って
 * 「検証済み」の印を付ける関数は、この型の意味を消します。
 *
 * **この関数が主張するのはここまでです:** 「この値は、実際に存在した
 * バイト列を最後まで読んで計算された」。そのバイト列がどこに永続しているか、
 * 正しい出所かは何も言いません（AGENTS.md 3.7）。
 */
export function attestContentHash(bytes: Uint8Array): VerifiedContentHash {
  return createHash("sha256").update(bytes).digest("hex") as VerifiedContentHash;
}

/**
 * ストリームを**読み切って**ハッシュを計算する。
 *
 * `expected` を渡すと、一致しなければ例外を投げます。
 * 途中で例外が出れば証拠は返りません。**途中でやめた読み取りから
 * 証拠が出ない**ことが、この関数の存在理由です。
 *
 * 読んだバイト列そのものは返しません。全体を溜める形にすると、
 * 10GB の原本で `#21` と同じ壊れ方をするためです。
 * バイト列が要る呼び出し側は `tee` してください。
 */
export async function attestFullRead(
  content: ReadableStream<Uint8Array>,
  expected?: ContentHash,
): Promise<{ hash: VerifiedContentHash; sizeBytes: number }> {
  const digest = createHash("sha256");
  let sizeBytes = 0;

  const reader = content.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      digest.update(chunk.value);
      sizeBytes += chunk.value.byteLength;
    }
  } catch (error) {
    try { await reader.cancel(error); }
    catch (cancelError) {
      // errored なストリームの cancel は同じ例外を返す。別の障害だけを併記する。
      if (cancelError !== error) throw new AggregateError([error, cancelError], "read and cancellation failed");
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const hash = digest.digest("hex") as VerifiedContentHash;
  if (expected !== undefined && hash !== (expected as string)) {
    throw new TypeError(
      `content hash mismatch: expected ${expected}, read ${hash} (${sizeBytes} bytes)`,
    );
  }
  return { hash, sizeBytes };
}

/**
 * 「読み切った証拠を持つ者が、この時刻に永続を主張した」。
 *
 * `VerifiedContentHash` を要求するのが全てです。任意の数値を
 * `blobVerifiedAt` に書ける状態は、**時刻の姿をした `exists()`** でした。
 *
 * **縮んだ主張です。** fsync が返ったことは型では確かめられません。
 * ここで確かめているのは「主張した者が `VerifiedContentHash` を1つ持っていたこと」
 * までで、残りは `BlobStore.put` の7手順が負う契約上の義務です
 * （KNOWN_LIMITATIONS 11節）。時刻はストアの時計から来ます。
 * この関数は時計を持ちません（AC-CLK-02）。
 *
 * **`_hash` は型の要求であって、値としては捨てます。** 戻り値は数値なので
 * ハッシュを運べず、`VerifiedAt` は**どのバイト列の証拠でもありません。**
 * 空配列の証拠を1つ持てば、別の内容の版に付く `VerifiedAt` が鋳造できます
 * （実測、S4-14）。結ぶには戻り値を `{ at, hash }` の対にして
 * `VersionDraft` と `insertVersionIfAbsent` の形を変える必要があり、
 * v0.1 では変えません。結んでも「バイト列を持つ者が blob を書かずに
 * 版を立てる」経路は残るためです（KNOWN_LIMITATIONS 11.4）。
 */
export function attestPersisted(at: EpochMs, _hash: VerifiedContentHash): VerifiedAt {
  return at as VerifiedAt;
}
