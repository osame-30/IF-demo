/**
 * `BlobKey` からディスク上のパスを導出する。**ここが唯一の導出点です。**
 *
 * ## 置き場所は鍵の一部ではありません
 *
 * 鍵は内容ハッシュそのものです（`ids.ts` の `blobKeyOf`）。
 * 分割の仕方はこのファイルの中だけにあり、鍵の文字列には現れません。
 * 鍵に `blob/` のような接頭辞を持たせると、置き場所を変えるたびに
 * 既存の鍵が意味を変えます。**変えてよいのは配置だけで、鍵ではありません。**
 *
 * ## 2文字 sharding
 *
 * `<root>/<先頭2>/<残り>`。1ディレクトリに全 blob を並べると、
 * 数十万件で列挙も stat も落ち込みます。
 * 先頭2文字は 16 進なので 256 通りに分かれます。
 *
 * ## 鍵をここでもう一度検査します
 *
 * `blobKeyOf` を通った鍵は小文字16進です。**しかしすべての鍵がそこを
 * 通るわけではありません。** `lineage-store.ts` は DB の行から
 * `str(row["blob_key"]) as BlobKey` で鍵を作り直しており、
 * その値が16進である保証はどこにもありません
 * （表の中身は「存在するから正しい」ではない。AGENTS.md 3.7）。
 *
 * 鍵はそのままパスの一部になるので、`..` や区切り文字が1つでも通れば
 * root の外を指せます。冗長な検査ですが、これは**反証のための冗長**です
 * （AGENTS.md 9節 軸2）。潰すなら、DB から来る鍵を検査する場所を
 * 先に作ってください。
 */

import { join } from "node:path";

import type { BlobKey } from "../../domain/types.ts";

/** 先頭何文字をディレクトリに使うか。変えると既存 blob の移動が要る */
const SHARD_LENGTH = 2;

/**
 * 鍵の形。小文字16進で、shard を取っても残りが空にならない長さ。
 *
 * 長さを 64 に固定していないのは、`blobKeyOf` 側もしていないからです。
 * 同じ数字を2箇所に書くと、片方だけが動いたときに食い違います
 * （AGENTS.md 9節 軸0）。ここが要求するのは**分割できること**だけです。
 */
const KEY_SHAPE = new RegExp(`^[0-9a-f]{${String(SHARD_LENGTH + 1)},}$`);

/**
 * blob の実体のパス。
 *
 * @param root blob 置き場の根。呼び出し側が絶対パスを渡すこと
 */
export function blobPath(root: string, key: BlobKey): string {
  const value = String(key);
  if (!KEY_SHAPE.test(value)) {
    throw new TypeError(
      `blob key must be lowercase hex of length ${String(SHARD_LENGTH + 1)} or more, ` +
        `got ${JSON.stringify(value)}`,
    );
  }
  return join(root, value.slice(0, SHARD_LENGTH), value.slice(SHARD_LENGTH));
}
