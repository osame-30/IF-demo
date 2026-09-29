/**
 * AC-KEY-01 / AC-KEY-02 — 鍵が引数として入ってこないことの機械検査。
 *
 * **2つに分かれているのは、片方だけでは穴が残るからです。**
 *
 *   - AC-KEY-01 … `LineageStore` の引数型から `DerivationKey` に到達できない。
 *     **型として**鍵を渡す口が無いことを言います
 *   - AC-KEY-02 … `src/**` の中で、鍵でない値に `as DerivationKey` を貼らない。
 *     `key: string` で受けて内部で貼り直す経路を塞ぎます
 *
 * AC-KEY-01 だけだと `claimRun(args: { key: string })` が素通りします。
 * 型の走査は分岐前の `string` を見分けられないためです。
 *
 * ## なぜ「鍵を受け取らない」が守るべき性質なのか
 *
 * `derivationKey` は sha256 の一方向要約です。渡された鍵が本当にその
 * `rootVersionId` の・その processor の鍵かを判定する述語は**書けません**
 * （鍵から材料は取り出せない）。だから鍵を引数に取ると、
 * **検査できない冗長**がそのまま残ります（AGENTS.md 9節）。
 *
 * `claimRun` はかつて鍵を受け取っていました。同じ同一性が `claimRun` と
 * `commitDerivation` の2点を渡り、claim 側は呼び出し側の計算を信じるだけでした。
 * いま両方が同じ材料から `derivationKey()` 一本で導出します。
 * **この検査は、その口が二度と開かないことを主張します。**
 *
 * ## 許可リストが空であることについて
 *
 * AC-CLK-01 の許可リストは空になりません（「判定に使わない証拠値」としての
 * 時刻があるため）。**こちらは空です。** 鍵は証拠値ではなく同一性そのもので、
 * 「受け取るが判定に使わない」という使い道がありません。
 * 行が1つでも増えたらこのテストが落ち、**その鍵をどう検算するのか**を
 * 人間が答えることになります。答えられないなら、それは受け取ってはいけない引数です。
 *
 * ## ブランドを private にしても閉じません（実測）
 *
 * `DerivationKey` は `string` の部分型なので、ブランドの記号を隠しても
 * `"forged" as DerivationKey` は型検査を通ります（`as unknown as` すら不要）。
 * さらに、鋳造を封じても **API が鍵を受け取ること自体は封じられません** —
 * 正規の `derivationKey(materials)` の結果を渡せば通るからです。
 * **封じたいのは偽造ではなく「鍵という形で受け取ること」**なので、
 * 検査するのは鋳造元ではなく引数の口のほうです。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { repoFiles, ROOT } from "./import-graph.ts";
import { indexOf, parameterPathsTo, parse } from "./type-paths.ts";

const DOMAIN = fileURLToPath(new URL("../../src/domain/types.ts", import.meta.url));

/**
 * 鍵が入ってよい口の全リスト。**空です。**
 *
 * ここに行を足すときは、その鍵を**何と突き合わせるのか**を先に書いてください。
 * 突き合わせる文が書けないなら、消すべきは引数ではなく引数リストです
 * （AGENTS.md 9節 軸0の後半）。
 */
const ALLOWED: ReadonlyArray<string> = [];

const index = indexOf(parse(DOMAIN));
const store = index.interfaces.get("LineageStore");
assert.ok(store, "LineageStore interface not found in types.ts");

describe("AC-KEY-01: LineageStore に derivationKey を渡す口がない", () => {
  const found = parameterPathsTo("DerivationKey", store, index);

  it("鍵が入る口は許可リストと完全一致する", () => {
    assert.deepEqual([...new Set(found)].sort(), [...new Set(ALLOWED)].sort());
  });

  it("claimRun は鍵の材料を受け取る（鍵そのものではない）", () => {
    const member = store.members.find(
      (m) => ts.isMethodSignature(m) && m.name?.getText() === "claimRun",
    ) as ts.MethodSignature | undefined;
    assert.ok(member, "claimRun not found");

    const literal = member.parameters[0]?.type;
    assert.ok(literal && ts.isTypeLiteralNode(literal), "claimRun takes an object literal");
    assert.deepEqual(
      literal.members.map((m) => m.name?.getText()),
      [
        "processorName",
        "processorVersion",
        "configHash",
        "inputIds",
        "rootVersionId",
        "workerId",
        "leaseSeconds",
      ],
    );
  });

  it("DerivationDraft も鍵を持たない（commit 側の口も閉じている）", () => {
    const draft = index.interfaces.get("DerivationDraft");
    assert.ok(draft, "DerivationDraft not found");
    const names = draft.members.map((m) => m.name?.getText());
    for (const banned of ["derivationKey", "artifactCount", "outputsHash"]) {
      assert.ok(!names.includes(banned), `DerivationDraft must not carry ${banned}`);
    }
  });

  /**
   * 2026-09-10 の指摘 1。
   *
   * 原本を指定する口は `claimRun` に1つだけです。commit 側にもう1つあると、
   * **確定の時点で原本を差し替えられます**（鍵の材料に `rootVersionId` は
   * 入っていないので、鍵の照合では止まりません）。
   * 一致を要求する形ではなく、口を消す形で閉じました。
   */
  it("DerivationDraft は原本も文書も持たない（原本の口は claimRun だけ）", () => {
    const draft = index.interfaces.get("DerivationDraft");
    assert.ok(draft, "DerivationDraft not found");
    const names = draft.members.map((m) => m.name?.getText());
    assert.deepEqual(names, ["processorName", "processorVersion", "configHash", "inputIds"]);
  });

  /**
   * 2026-09-10 の指摘 3。
   *
   * inline の本文はストアの手元にあるので、hash と size は導出できます。
   * 受け取る口があると、**本文と結ばれていない証拠**を付けられます
   * （`VerifiedContentHash` が運ぶのは「あるバイト列を読み切った」までなので、
   * 型では止まりません）。blob の枝は再読が払えないので受け取ります。
   */
  it("InlineArtifactDraft は hash も size も持たない。blob の枝だけが受け取る", () => {
    const inline = index.interfaces.get("InlineArtifactDraft");
    assert.ok(inline, "InlineArtifactDraft not found");
    const inlineNames = inline.members.map((m) => m.name?.getText());
    for (const banned of ["contentHash", "sizeBytes", "blobKey"]) {
      assert.ok(!inlineNames.includes(banned), `InlineArtifactDraft must not carry ${banned}`);
    }
    assert.ok(inlineNames.includes("content"), "本文は受け取る");

    const blob = index.interfaces.get("BlobArtifactDraft");
    assert.ok(blob, "BlobArtifactDraft not found");
    const blobNames = blob.members.map((m) => m.name?.getText());
    for (const required of ["blobKey", "contentHash", "sizeBytes"]) {
      assert.ok(blobNames.includes(required), `BlobArtifactDraft must carry ${required}`);
    }
    assert.ok(!blobNames.includes("content"), "blob の枝に本文は無い");
  });

  it("走査が空振りしていない（同じ走査で鍵を実際に見つけられる）", () => {
    // 許可リストが空なので、上の検査は「走査が壊れて何も返さない」でも緑になります。
    // 戻り値側には鍵が実在するので、そこを見つけられることを確かめる
    const derivation = index.interfaces.get("Derivation");
    assert.ok(derivation, "Derivation not found");
    const paths = parameterPathsTo("DerivationKey", index.interfaces.get("BlobStore")!, index);
    assert.deepEqual(paths, [], "BlobStore は鍵を受け取らない");

    const inDerivation = derivation.members
      .filter((m) => m.name?.getText() === "derivationKey")
      .map((m) => (m as ts.PropertySignature).type?.getText());
    assert.deepEqual(inDerivation, ["DerivationKey"]);
  });
});

/**
 * `src/**` の中で `as DerivationKey` が貼れる場所。
 *
 * 2つだけです。
 *
 *   - `src/domain/ids.ts` … 鋳造元。sha256 の結果に貼る
 *   - **DB から読み戻した値**。`str(row[...])` の形に限る
 *
 * 読み戻しは鋳造ではありません。**昔ストアが導出して書いた値を、
 * 型の世界に戻しているだけ**です。だから形で限定できます。
 * `args.key as DerivationKey` はこの形に当てはまらないので落ちます。
 */
const MINT = "src/domain/ids.ts";

/** その表明の対象が「行から読んだ値」の形か。`str(row[...])` だけを認める */
function isRowRead(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node)) return false;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "str") return false;
  const [argument] = node.arguments;
  return argument !== undefined && ts.isElementAccessExpression(argument);
}

describe("AC-KEY-02: 鍵でない値に鍵の型を貼らない", () => {
  const offenders: string[] = [];

  for (const file of repoFiles()) {
    if (!file.startsWith("src/") || file === MINT || file.endsWith(".test.ts")) continue;
    const absolute = join(ROOT, file);
    const source = ts.createSourceFile(
      absolute,
      readFileSync(absolute, "utf8"),
      ts.ScriptTarget.ES2023,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isAsExpression(node) &&
        ts.isTypeReferenceNode(node.type) &&
        ts.isIdentifier(node.type.typeName) &&
        node.type.typeName.text === "DerivationKey" &&
        !isRowRead(node.expression)
      ) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        offenders.push(`${file}:${line + 1}: ${node.getText(source)}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  it("`as DerivationKey` は行の読み戻しにしか使えない", () => {
    assert.deepEqual(
      offenders,
      [],
      "引数で受けた値に鍵の型を貼り直している。AC-KEY-01 は型の口しか見ていないので、" +
        "この経路は素通りする",
    );
  });

  it("鋳造元は1つ（検査が空振りしていない）", () => {
    const mint = join(ROOT, MINT);
    const source = ts.createSourceFile(mint, readFileSync(mint, "utf8"), ts.ScriptTarget.ES2023, true);
    let mints = 0;
    const visit = (node: ts.Node): void => {
      if (
        ts.isAsExpression(node) &&
        ts.isTypeReferenceNode(node.type) &&
        ts.isIdentifier(node.type.typeName) &&
        node.type.typeName.text === "DerivationKey"
      ) {
        mints += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.equal(mints, 1, `${MINT} で鍵を鋳造している箇所は1つ`);
  });
});
