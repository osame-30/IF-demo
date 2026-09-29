/**
 * AC-EVD-01 — 証拠型が「証拠でない経路」から入手できないことの機械検査。
 *
 * `VerifiedContentHash` と `VerifiedAt` は「どうやって手に入れたか」を運びます。
 * どこでも `as` で作れるなら、運んでいるのは何でもありません。
 * これは `BlobStore.exists()` を消した理由と同じ形です
 * ——**証明のつもりで置いた値が、証明でない経路から手に入る**。
 *
 * ## ブランドを private にしても閉じません（実測）
 *
 * `VerifiedContentHash` は `string` の部分型なので、ブランドの記号を
 * モジュール private にしても `"x" as VerifiedContentHash` は型検査を通ります
 * （`as unknown as` すら要りません）。閉じているのは**秘匿ではなく構文の検査**です。
 * `as` は構文なので、AST で数えられます。
 *
 * ## 許可はファイル名ではなく到達経路の閉包で行う
 *
 * 逃げ道を名前で許可すると、`const mk = (s) => __unsafeAttestContentHash(s)` と
 * 包むだけで到達点は1つのまま呼び出し元が非有界になります。
 * **逃げ道を import しているファイルの推移閉包**を許可リストにすれば、
 * 包んだファイル自身が閉包に入るのでここで落ちます。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

import { repoFiles, reverseClosure, ROOT } from "./import-graph.ts";

/** 証拠型の名前。増やしたらここにも足すこと */
const EVIDENCE_TYPES = ["VerifiedContentHash", "VerifiedAt"];

/**
 * 証拠型を `as` で名乗ってよいファイル。**2つだけです。**
 *
 * - `src/domain/evidence.ts` … 正規の鋳造元。バイト列を読む
 * - `test/support/unsafe-evidence.ts` … 逃げ道。読まずに名乗る
 */
const MINTS = ["src/domain/evidence.ts", "test/support/unsafe-evidence.ts"];

const UNSAFE_MINT = "test/support/unsafe-evidence.ts";

const FILES = repoFiles();

/**
 * 逃げ道に**到達できる**ファイルの全リスト（推移閉包）。
 *
 * 増えたらテストが落ちます。増やすときは、そのファイルが
 * 「正規の鋳造では作れない値」を本当に必要としているかを確認してください。
 * 必要な理由は2種類しかありません — 不正な値で拒否を確かめる試験か、
 * DB から読み戻した値の詰め直しかです。
 *
 * **この閉包は静的 import しか見ていません（既知の限界）。**
 * `runner.test.ts` はフィクスチャを `import(\`./${row.path}\`)` で読むので、
 * 指定子が実行時にしか決まらず、ここには現れません。
 * 静的な包み直し（C2 が指した形）はこれで落ちます。
 * 計算された指定子まで追うには実行時の解決が要り、それは別の道具です。
 */
const UNSAFE_CLOSURE: ReadonlyArray<string> = [
  // 大文字16進の contentHash / 0 の blobVerifiedAt を拒むことの試験
  "src/store/sqlite/version.test.ts",
  // blobVerifiedAt を持たない version が1行も書かれずに拒まれることの試験
  "test/fixtures/observe/fingerprint-collision.ts",
];

/**
 * その型への型表明の数。`as T` / `<T>x` / `satisfies T` の3形すべて。
 *
 * **正規表現ではなく AST で数えます。** 本文を文字列として検索すると、
 * テストの見出しに書いた「as VerifiedAt」のような**文字列リテラルが
 * 違反として数えられます**（実際に数えました）。
 * 検査が自分の説明文に反応する状態では、何を数えているのか言えません。
 */
function assertionsIn(file: string, typeName: string): number {
  const absolute = join(ROOT, file);
  const source = ts.createSourceFile(
    absolute,
    readFileSync(absolute, "utf8"),
    ts.ScriptTarget.ES2023,
    true,
  );
  let count = 0;

  const named = (type: ts.TypeNode | undefined): boolean =>
    type !== undefined &&
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text === typeName;

  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node) && named(node.type)) count += 1;
    else if (ts.isTypeAssertionExpression(node) && named(node.type)) count += 1;
    else if (ts.isSatisfiesExpression(node) && named(node.type)) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

describe("AC-EVD-01: 証拠型は鋳造元の外で名乗れない", () => {
  it("`as VerifiedContentHash` / `as VerifiedAt` が現れるのは鋳造元だけ", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      if (MINTS.includes(file)) continue;
      for (const type of EVIDENCE_TYPES) {
        const hits = assertionsIn(file, type);
        if (hits > 0) offenders.push(`${file}: ${hits} × ${type}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("鋳造元は実際に鋳造している（検査が空振りしていない）", () => {
    // 上の検査は「どこにも as が無い」でも緑になります。
    // 鋳造元から as が消えたら、それは型が別物に変わったということなので落とす
    const minted = MINTS.map(
      (m) => `${m}: ${EVIDENCE_TYPES.reduce((n, t) => n + assertionsIn(m, t), 0)}`,
    );
    assert.deepEqual(minted, [
      "src/domain/evidence.ts: 3",
      "test/support/unsafe-evidence.ts: 2",
    ]);
  });

  it("逃げ道に到達できるファイルは許可リストと完全一致する（名前ではなく閉包）", () => {
    // 逆向きの閉包。走査は AC-IND-01 と共有（import-graph.ts）
    const reachable = reverseClosure(UNSAFE_MINT, FILES);
    assert.deepEqual([...reachable].sort(), [...UNSAFE_CLOSURE].sort());
  });

  it("本番コードは逃げ道に到達できない", () => {
    const production = UNSAFE_CLOSURE.filter((f) => f.startsWith("src/") && !f.endsWith(".test.ts"));
    assert.deepEqual(production, [], "src/** の非テストコードが嘘の証拠を作れる");
  });
});
