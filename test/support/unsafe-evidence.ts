/**
 * 証拠値の**逃げ道**。テスト専用。
 *
 * `src/domain/evidence.ts` の鋳造は「バイト列を読み切る」ことを要求します。
 * それで足りない場面が2種類あります。
 *
 *   - **不正な値を渡して拒否されることを確かめる試験。** 大文字16進や
 *     0 の `blobVerifiedAt` は、正規の鋳造からは出てきません。
 *     出てこない値でストアを試せないと、`insertVersionIfAbsent` の
 *     実行時検査を主張する試験が書けなくなります。
 *   - **DB から読み戻した値を draft に詰め直す試験。** 読み戻しは
 *     証拠ではありません（誰かが昔書いた値です）。
 *
 * ## この逃げ道が野放しにならない仕掛け
 *
 * **許可するのはファイル名ではなく、到達経路の閉包です**（AC-EVD-01）。
 * `const mk = (s) => __unsafeAttestContentHash(s)` と包んでも、
 * 包んだファイルが閉包に入るので許可リストが増えます。
 * 名前で許可すると呼び出し元が非有界になります。
 *
 * **本番コードから import された時点で AC-EVD-01 が落ちます。**
 * 閉包の許可リストは `test/**` に閉じています。
 */

import type { ContentHash, EpochMs, VerifiedAt, VerifiedContentHash } from "../../src/domain/types.ts";

/**
 * バイト列を読まずに `VerifiedContentHash` を名乗る。**嘘の証拠。**
 *
 * 正しい値が欲しいときは使わないでください。
 * `src/domain/evidence.ts` の `attestContentHash` にバイト列を渡せば済みます。
 */
export function __unsafeAttestContentHash(hash: string | ContentHash): VerifiedContentHash {
  return hash as VerifiedContentHash;
}

/** 読了の証拠を持たずに `VerifiedAt` を名乗る。**嘘の証拠。** */
export function __unsafeAttestedAt(at: number | EpochMs): VerifiedAt {
  return at as VerifiedAt;
}
