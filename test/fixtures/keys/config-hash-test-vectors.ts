/**
 * 攻撃 #22 — 同じ設定から違う configHash が出て、毎回全件が再計算になる。
 *
 * 元の穴: キー順のソートはしていたが、`1.0` と `1`、`undefined` とキー欠落、
 * Unicode エスケープ、浮動小数の表現が環境で違った。同じ設定オブジェクトから
 * 違う `derivationKey` が出るので、**再実行のたびに全 artifact が作り直されます。**
 * しかも壊れているのは「同じ入力 → 同じ ID」という v0.1 の絶対ルール3なので、
 * 系譜の同一性そのものが環境依存になります。
 *
 * ## この一式が主張すること
 *
 * 凍結ベクタ（`test/support/config-hash-vectors.ts`）の**期待値と実測値が一致する**。
 * `ctx.configHashVectors` は `createFixtureContext` が既定で入れるので、
 * `CANONICAL_KEY_STABILITY` は**全フィクスチャで**評価されます。宣言制にすると、
 * 宣言していないフィクスチャでは `not_checked` のまま静かに素通りします。
 *
 * ## 固定値では表せない性質は、ここで確かめる
 *
 * `configHashVectors` が運べるのは `{label, expected, actual}` の三つ組だけで、
 * 「2つの設定が同じ値になる」「例外を投げる」は表現できません。
 * FIXTURES.md D節の9行のうち、その4つをこの `execute` が受け持ちます。
 *
 * **`{a: 1.0}` の行だけは字義どおりには書けません。** JavaScript に
 * 浮動小数リテラルという区別は無く、`1.0` は整数の `1` そのものです
 * （`Object.is(1.0, 1)` は true）。`assert.throws(() => hash({a: 1.0}))` と
 * 書くと**通らずに落ちます** —— 例外は出ないからです。
 * 規則の意味（整数以外の数値を拒む）を取って `1.5` と `0.1` で確かめます。
 */

import assert from "node:assert/strict";

import { canonicalConfigHash } from "../../../src/domain/ids.ts";
import { CONFIG_HASH_VECTORS } from "../../support/config-hash-vectors.ts";
import { checkInvariants } from "../../support/invariant-checker.ts";
import type { FixtureContext } from "../context.ts";
import type { InvariantName } from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = ["CANONICAL_KEY_STABILITY"];

/**
 * 状態は作りません。**この攻撃の対象は純関数です。**
 *
 * DB の行を並べても、`canonicalConfigHash` の答えは1ビットも変わりません。
 * 状態を作ると「何が効いているのか」が薄まるだけです。
 */
export function setup(_ctx: FixtureContext): Promise<void> {
  return Promise.resolve();
}

export async function execute(ctx: FixtureContext): Promise<void> {
  // --- 供給経路が生きている（渡し忘れていない） ---
  assert.equal(
    ctx.configHashVectors.length,
    CONFIG_HASH_VECTORS.length,
    "凍結ベクタが文脈へ届いていない",
  );

  // --- 門そのものの生存確認 ---
  //
  // 上の一致だけを見ていると、`actual` に `expected` をコピーする実装でも
  // 緑になります。**導出を1度も通さずに全環境で一致するので、
  // CANONICAL_KEY_STABILITY が恒真式になります。**
  // 期待値を1つだけ壊して、門が実際に落とすことを確かめます。
  const first = ctx.configHashVectors[0]!;
  const tampered = [
    { label: first.label, expected: "0".repeat(64), actual: first.actual },
    ...ctx.configHashVectors.slice(1),
  ];
  const doctored = await checkInvariants({ reader: ctx.reader, configHashVectors: tampered });
  const verdict = doctored.results.find((r) => r.name === "CANONICAL_KEY_STABILITY");
  assert.equal(verdict?.status, "violated", "期待値を壊しても門が落ちない（恒真式）");
  assert.equal(verdict.findings[0]?.problem, "config_hash_vector_mismatch");
  assert.equal(verdict.findings[0]?.subject, first.label);

  // --- 固定値で表せない性質（FIXTURES.md D節の9行のうち4つ） ---

  // キーの順序は結果に影響しない
  assert.equal(canonicalConfigHash({ a: 1, b: 2 }), canonicalConfigHash({ b: 2, a: 1 }));

  // undefined のキーは「無い」と同じ。null とは区別する
  assert.equal(canonicalConfigHash({ a: undefined }), canonicalConfigHash({}));
  assert.notEqual(
    canonicalConfigHash({ a: null }),
    canonicalConfigHash({}),
    "null を欠落と同じに畳んでいる",
  );

  // NFC と NFD は同じ設定として扱う
  const nfc = "café".normalize("NFC");
  const nfd = "café".normalize("NFD");
  assert.notEqual(nfc, nfd, "前提: この2つは別の文字列であること");
  assert.equal(canonicalConfigHash({ a: nfc }), canonicalConfigHash({ a: nfd }));

  // 配列は順序を持つ。畳んではいけない
  assert.notEqual(canonicalConfigHash({ a: [1, 2] }), canonicalConfigHash({ a: [2, 1] }));

  // 整数以外の数値は拒む。**`{a: 1.0}` は書けないので `1.5` と `0.1` で確かめる**
  assert.throws(() => canonicalConfigHash({ a: 1.5 }), /safe integers/);
  assert.throws(() => canonicalConfigHash({ a: 0.1 }), /safe integers/);
  // 念のため: 1.0 は例外にならない。整数だから
  assert.equal(canonicalConfigHash({ a: 1.0 }), canonicalConfigHash({ a: 1 }));
}
