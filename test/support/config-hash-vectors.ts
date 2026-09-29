/**
 * `canonicalConfigHash` の凍結ベクタ。**置き場所は1箇所だけです。**
 *
 * 2箇所に書くと、片方を直して他方を直し忘れたときに
 * **どちらが正しいのかを決める根拠がどこにも無くなります。**
 * 期待値そのものが正本なので、複製は正本を2つ作ることになります。
 *
 * 参照するのは2つ:
 *
 *   - `src/domain/ids.test.ts` … 原像と要約の両方を固定する単体検査
 *   - `test/fixtures/context.ts` … `CANONICAL_KEY_STABILITY` へ供給する経路
 *
 * **規則そのものは凍結されています**（`IdDerivation.canonicalConfigHash`）。
 * 値を変えるときは `pipelineVersion` の更新を伴います。
 * 期待値を測り直さずに書き換えてはいけません。
 */

import { canonicalConfigHash } from "../../src/domain/ids.ts";

export const CONFIG_HASH_VECTORS: ReadonlyArray<{
  label: string;
  config: unknown;
  preimage: string;
  expected: string;
}> = [
  { label: "{}", config: {}, preimage: "{}", expected: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a" },
  { label: "{a:1}", config: { a: 1 }, preimage: '{"a":1}', expected: "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862" },
  { label: "{a:1,b:2}", config: { a: 1, b: 2 }, preimage: '{"a":1,"b":2}', expected: "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777" },
  { label: "{a:null}", config: { a: null }, preimage: '{"a":null}', expected: "d091f9c83c091f79652fe8786375b3fe4ce0861a56f5bfbafedbe431877ff0e8" },
  { label: '{a:"café"}', config: { a: "café" }, preimage: '{"a":"café"}', expected: "e3c598cda7afb08d1ddede0a770feb8db4312dece093d15449a1856192c34a2f" },
  { label: "{a:[1,2]}", config: { a: [1, 2] }, preimage: '{"a":[1,2]}', expected: "01530d164d479cf08e26d3b1ad9bdba927120d97e2d057a6d792db778780d720" },
  { label: "{a:[2,1]}", config: { a: [2, 1] }, preimage: '{"a":[2,1]}', expected: "439e3fbf35fa867d156db2626f94efbd435852a97bbe16660ee529d9bda0e502" },
  { label: '{a:"日本語"}', config: { a: "日本語" }, preimage: '{"a":"日本語"}', expected: "b019077fad3f09225e38f194c05edf83cd5a5a504fa04c55b9ac1f4a78fa2707" },
];

/**
 * 不変条件チェッカーが要求する形に直す。**`actual` は実際に計算します。**
 *
 * ここで期待値をそのまま `actual` にも入れると、`CANONICAL_KEY_STABILITY` は
 * 恒真式になります —— 導出を1度も通さずに全環境で一致するからです。
 */
export function configHashVectorResults(): ReadonlyArray<{
  readonly label: string;
  readonly expected: string;
  readonly actual: string;
}> {
  return CONFIG_HASH_VECTORS.map((v) => ({
    label: v.label,
    expected: v.expected,
    actual: canonicalConfigHash(v.config),
  }));
}
