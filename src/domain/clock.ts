/**
 * 時刻の供給源。
 *
 * 「時刻の権威は1つ」（AGENTS.md 3.8 / types.ts の絶対ルール7）は
 * **比較・判定に使う時刻**の規則です。リース判定に使う時刻は必ずストアが付与し、
 * ワーカーは時刻を送りません。
 *
 * now() が引数を取らないのは、「呼び出し側が時刻を渡す」経路を
 * 型の上に作らないためです（#14）。
 *
 * **このファイルは契約だけです。実時刻を読む実装は置きません。**
 * 具象は `src/runtime/system-clock.ts`（合成ルート側）にあります。
 * ここに `Date.now()` があると、検査対象を `src/store/**` に限っている AC-CLK-02 は
 * 緑のまま実時刻の読み取りが domain へ移動できてしまいます。
 * その穴を塞ぐために AC-CLK-02 は `src/domain/**` も検査します。
 */

import type { EpochMs } from "./types.ts";

export interface Clock {
  now(): EpochMs;
}

/** 生の数値を EpochMs に持ち上げる。整数以外は時刻規約違反として弾く */
export function asEpochMs(value: number): EpochMs {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      `EpochMs must be a safe integer (got ${value}). ` +
        "ISO strings and fractional milliseconds are not permitted.",
    );
  }
  return value as EpochMs;
}
