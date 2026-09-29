/**
 * 制御可能な時計。
 *
 * AGENTS.md 6節: `Date.now()` を直接呼ばない。テスト可能な時計を注入する。
 *
 * 攻撃 #14（時刻の権威の分裂）を再現できることが、このヘルパーの存在理由です。
 * ストアとワーカーがそれぞれ別の時計を持てるよう、TestClock は互いに独立した
 * インスタンスとして生成します。共有したい場合だけ同じインスタンスを渡します。
 *
 * `Clock` の定義そのものは `src/domain/clock.ts` にあります。
 * 時刻の権威は domain の契約であって、テストの都合ではないためです。
 */

import type { EpochMs } from "../../src/domain/types.ts";
import { asEpochMs } from "../../src/domain/clock.ts";
import type { Clock } from "../../src/domain/clock.ts";

export type { Clock };
export { asEpochMs };

/**
 * テスト用の手動時計。
 *
 * 既定では前進しかしません。時刻を戻すには rewindTo を明示的に呼びます。
 * 巻き戻しは #14 / #19 の再現に必要ですが、事故で起きてはいけないため、
 * メソッド名で意図を残す形にしています。
 */
export class TestClock implements Clock {
  #current: EpochMs;

  /**
   * @param startAt 開始時刻。既定の 0 ではなく現実的な値を置いているのは、
   *   「未設定の時刻」を 0 で表す実装のバグが 0 起点だと隠れてしまうためです。
   */
  constructor(startAt: number = 1_700_000_000_000) {
    this.#current = asEpochMs(startAt);
  }

  now(): EpochMs {
    return this.#current;
  }

  /** 指定ミリ秒だけ進める。負値は受け付けない（巻き戻しは rewindTo） */
  advance(deltaMs: number): EpochMs {
    if (!Number.isSafeInteger(deltaMs) || deltaMs < 0) {
      throw new RangeError(
        `advance() takes a non-negative integer (got ${deltaMs}). ` +
          "Use rewindTo() to move the clock backwards.",
      );
    }
    this.#current = asEpochMs(this.#current + deltaMs);
    return this.#current;
  }

  /**
   * 時刻を過去に戻す。#14（遅れたワーカーの時計）や
   * #19（バックアップ復元で mtime が過去に戻る）の再現に使います。
   */
  rewindTo(target: number): EpochMs {
    const next = asEpochMs(target);
    if (next > this.#current) {
      throw new RangeError(
        `rewindTo(${target}) moves forward from ${this.#current}. Use advance().`,
      );
    }
    this.#current = next;
    return this.#current;
  }

  /** 絶対時刻を設定する。前後どちらにも動く。移動方向を問わない準備用 */
  setTo(target: number): EpochMs {
    this.#current = asEpochMs(target);
    return this.#current;
  }
}

/**
 * 決して動かない時計。
 * 「時刻が進まなくても正しく動くか」を確かめる用途にだけ使います。
 */
export function frozenClock(at: number): Clock {
  const fixed = asEpochMs(at);
  return { now: () => fixed };
}
