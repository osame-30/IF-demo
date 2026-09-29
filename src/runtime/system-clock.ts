/**
 * 実時刻を読む唯一の場所。**合成ルート（composition root）の持ち物です。**
 *
 * `src/domain/` に置かないのは、AC-CLK-02 が骨抜きになるからです。
 * 契約と具象実装が同居していると、検査対象を `src/store/**` に限っている限り
 * テストは緑のままで、`new Date()` が store から domain へ移動しただけになります。
 * 「時刻の権威は1つ」は、その1つがどこにあるかを固定して初めて意味を持ちます。
 *
 * `Clock` の定義そのものは `src/domain/clock.ts` にあります。
 * 契約はドメインの持ち物、実時刻の読み取りは外側、という切り分けです。
 *
 * BlobStore と LineageStore には**同一インスタンス**を渡してください。
 * 別インスタンスにした瞬間 #14 が別の顔で戻ってきます。
 */

import type { Clock } from "../domain/clock.ts";
import type { EpochMs } from "../domain/types.ts";

/**
 * 壁時計。このリポジトリで `Date.now()` を呼んでよい唯一の関数です。
 *
 * テストからは使いません。テスト用の固定時計は `test/support/clock.ts` にあります。
 */
export function systemClock(): Clock {
  return { now: () => Date.now() as EpochMs };
}
