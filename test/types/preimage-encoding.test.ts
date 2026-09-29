/**
 * AC-ENC-01 — 原像の符号化が単射であるための**構造前件**の機械検査。
 *
 * `ids.ts` の長さ前置は、それ自体では単射になりません。
 * 2つの前件に寄りかかっており、**どちらも散文にも検査にも書かれていませんでした。**
 *
 * ## 前件1 — ドメインタグは長さ前置されない
 *
 * `preimageOf` はタグを素で先頭に置きます（`"doc:" + parts.join("")`）。
 * タグ自身は長さを持たないので、タグ集合が**接頭符号**でなければ
 * 別ドメインの原像どうしが境界を動かせます。
 * いまは「全部4バイト・相異なる」でそれが成立していますが、
 * これは偶然そうなっているだけで、**タグを1つ足すときに誰も止めません。**
 *
 * ## 前件2 — 長さ前置されない可変長の場は原像の末尾に1つだけ
 *
 * `SEP`（`\x00`）連結が残っているのは `outputsHashPreimage` の1箇所です。
 * あそこが安全なのは、要素が小文字16進に限られること（`assertLowercaseHex`）と、
 * **その場が原像の末尾を丸ごと占めていて後続の場が無いこと**の両方によります。
 * 後ろに場が1つでも増えれば、境界は `SEP` を含む値で動かせます。
 *
 * ## 固定値にしない理由
 *
 * 「4バイト」「5個」を定数で書くと、`ids.ts` にタグを足した人は
 * **この検査に一度も触れずに済みます。** 宣言と `ids.ts` の実体を
 * ソース走査で突き合わせる形にして、足したら落ちるようにします
 * （AC-BRD-01 の `HATCH_USERS` と同じ形）。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

import { ROOT } from "./import-graph.ts";
import { canonicalConfigPreimage } from "../../src/domain/ids.ts";

const IDS = "src/domain/ids.ts";
const source = ts.createSourceFile(
  "ids.ts",
  readFileSync(join(ROOT, IDS), "utf8"),
  ts.ScriptTarget.ES2023,
  true,
);

const lineOf = (node: ts.Node): number =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

/**
 * `ids.ts` に現れる**ドメインタグの形をした字面**の全リスト。
 *
 * 文字列リテラルとテンプレートの各断片を見ます。`"out:"` は
 * `` `out:${...}` `` のテンプレート先頭にあり、`preimageOf` を通らないので、
 * 呼び出しの第1引数だけを見ていると漏れます。
 *
 * **重複を畳みません。** 2つのビルダが同じタグを名乗った状態を
 * 「相異なる」の検査で落とすためです。
 */
function scanTags(): Array<{ tag: string; line: number }> {
  const out: Array<{ tag: string; line: number }> = [];
  const shaped = /^[A-Za-z0-9_]+:$/;
  const visit = (node: ts.Node): void => {
    let text: string | undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      text = node.text;
    }
    if (text !== undefined && shaped.test(text)) out.push({ tag: text, line: lineOf(node) });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const SCANNED = scanTags();

/**
 * ドメインタグの宣言。**`ids.ts` の実体と完全一致していなければ落ちます。**
 *
 * 増やす前に「そのタグは他のどれの接頭辞にもならないか」に答えてください。
 * 答えが「4バイトで相異なる」でないなら、`preimageOf` 側を直す話になります。
 */
const TAGS: ReadonlyArray<string> = ["doc:", "ver:", "der:", "art:", "out:"];

describe("AC-ENC-01: 原像の符号化の構造前件", () => {
  describe("前件1: ドメインタグが接頭符号である", () => {
    it("走査が空振りしていない", () => {
      // 正規表現が1つも拾えなくても、下の3つは「空 === 空」で緑になりえます
      assert.ok(
        SCANNED.length >= 5,
        `${IDS} からタグ形の字面を ${SCANNED.length} 件しか拾えていない`,
      );
    });

    it("ids.ts のタグはすべて同一バイト長", () => {
      const lengths = new Set(SCANNED.map((t) => Buffer.byteLength(t.tag, "utf8")));
      assert.deepEqual(
        [...lengths],
        [4],
        SCANNED.map((t) => `${IDS}:${String(t.line)} ${t.tag}`).join(" / "),
      );
    });

    it("ids.ts のタグは相異なる", () => {
      // 同一バイト長だけでは足りません。同じ字面を2つのビルダが名乗ると、
      // 長さが揃っていてもドメインが分離されません
      const seen = new Map<string, number[]>();
      for (const t of SCANNED) seen.set(t.tag, [...(seen.get(t.tag) ?? []), t.line]);
      const duplicated = [...seen.entries()]
        .filter(([, lines]) => lines.length > 1)
        .map(([tag, lines]) => `${tag} @ ${lines.join(",")}`);
      assert.deepEqual(duplicated, []);
    });

    it("宣言リストが ids.ts の実体と完全一致する", () => {
      assert.deepEqual(
        SCANNED.map((t) => t.tag).sort(),
        [...TAGS].sort(),
        `宣言と ${IDS} が食い違っている。タグを足したなら、上の TAGS に理由ごと足すこと`,
      );
    });
  });

  /**
   * `SEP` の参照を数えます。宣言（`const SEP = ...`）を含めて2つ、
   * つまり**使っているのは1箇所だけ**であることを見ます。
   */
  describe("前件2: 長さ前置されない可変長の場は原像の末尾に1つだけ", () => {
    const seps: ts.Identifier[] = [];
    const collect = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === "SEP") seps.push(node);
      ts.forEachChild(node, collect);
    };
    collect(source);

    /** `outputsHashPreimage` の宣言。前件2 が寄りかかっている唯一の関数 */
    function outputsHashPreimageDecl(): ts.FunctionDeclaration {
      let found: ts.FunctionDeclaration | undefined;
      source.forEachChild((node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === "outputsHashPreimage") {
          found = node;
        }
      });
      assert.ok(found, `${IDS} に outputsHashPreimage が無い`);
      return found;
    }

    it("SEP を使っているのは1箇所だけ（宣言を含めて2つ）", () => {
      assert.equal(
        seps.length,
        2,
        `SEP の出現: ${seps.map((s) => String(lineOf(s))).join(",")}`,
      );
    });

    it("その1箇所は outputsHashPreimage の中にある", () => {
      const fn = outputsHashPreimageDecl();
      const inside = seps.filter(
        (s) => s.getStart(source) > fn.getStart(source) && s.end <= fn.end,
      );
      assert.equal(
        inside.length,
        1,
        `outputsHashPreimage の外で SEP が使われている: ${seps
          .map((s) => String(lineOf(s)))
          .join(",")}`,
      );
    });

    it("その場は原像の末尾を丸ごと占めている（後続の場が無い）", () => {
      // `out:${...}` の形。substitution が2つ以上あるか、末尾に字面が付いたら、
      // SEP 連結の後ろに場が増えたということ
      const fn = outputsHashPreimageDecl();
      let template: ts.TemplateExpression | undefined;
      const findReturn = (node: ts.Node): void => {
        if (
          ts.isReturnStatement(node) &&
          node.expression !== undefined &&
          ts.isTemplateExpression(node.expression)
        ) {
          template = node.expression;
        }
        ts.forEachChild(node, findReturn);
      };
      findReturn(fn);
      assert.ok(template, "outputsHashPreimage がテンプレートを返していない");
      assert.equal(template.head.text, "out:");
      assert.equal(template.templateSpans.length, 1, "場が2つ以上ある");
      assert.equal(template.templateSpans[0]!.literal.text, "", "末尾に字面が続いている");
    });
  });
});

/**
 * AC-ENC-02 — 第3の前件: **タグを持たない原像が、タグ付き原像と衝突しない。**
 *
 * `ids.ts` の sha256 は6箇所から呼ばれます。5つはドメインタグで始まりますが、
 * `canonicalConfigHash` だけタグを持ちません（`canonicalConfigPreimage` は
 * `encodeValue(config, "$")` をそのまま返す）。
 *
 * それでも衝突しないのは、`encodeValue` の出力の先頭バイトが
 * `n` `t` `f` `"` `[` `{` `-` `0`-`9` のいずれかに限られ、
 * タグの先頭バイト（`d` `v` `a` `o`）と交わらないからです。
 * **この依存は散文にも検査にも書かれていませんでした。**
 *
 * ## なぜ前件1/2 より先に壊れるか
 *
 * 前件1（タグが同一バイト長）と前件2（`SEP` が末尾に1つ）は、
 * どちらも既存の構造を崩す編集でしか壊れません。こちらは**タグを1つ足すだけ**で
 * 壊れます —— `"nul:"` や `"txt:"` を足した人は、`encodeValue` を一度も
 * 読まずにその判断をします。
 *
 * ## この検査は保守的です（十分条件であって必要条件ではない）
 *
 * 先頭1バイトが交われば落としますが、**先頭が交わっても実際の衝突が
 * 無いことはありえます**（2バイト目以降で必ず分かれる場合）。
 * その場合ここは偽陽性を出します。ゆるめる前に、なぜ交わってよいのかを
 * 4バイト全体で書けるか確かめてください。
 *
 * ## タグ側は AC-ENC-01 の走査結果から取ります
 *
 * 上の `TAGS` 宣言からは取りません。宣言はテスト側の値なので、
 * `ids.ts` にタグを足して宣言を直した人が、この検査を**素通りできてしまいます**。
 * 走査結果（`SCANNED`）から取れば、足した瞬間にここも効きます。
 */
describe("AC-ENC-02: タグを持たない原像はタグ付き原像と先頭バイトで分離されている", () => {
  /** タグの先頭バイト。`SCANNED` = ids.ts の AST 走査結果（宣言ではない） */
  const tagFirstBytes = new Set(SCANNED.map((t) => Buffer.from(t.tag, "utf8")[0]!));

  /** その原像の先頭バイトがタグと衝突するか */
  const collides = (preimage: string): boolean => {
    const bytes = Buffer.from(preimage, "utf8");
    assert.ok(bytes.length > 0, "原像が空。先頭バイトが無い");
    return tagFirstBytes.has(bytes[0]!);
  };

  /**
   * `encodeValue` の枝を代表する入力。**6本の return を1本ずつ通します。**
   *
   * `"doc:"` と `{ "doc:": 1 }` を混ぜてあるのは、
   * **設定の中身がタグそのものでも先頭バイトは動かない**ことを見るためです
   * （文字列は必ず引用符から始まる）。
   */
  const SAMPLES: ReadonlyArray<{ label: string; config: unknown }> = [
    { label: "null", config: null },
    { label: "true", config: true },
    { label: "false", config: false },
    { label: "0", config: 0 },
    { label: "-7", config: -7 },
    { label: "42", config: 42 },
    { label: '"doc:"', config: "doc:" },
    { label: "[]", config: [] },
    { label: '[1,"a"]', config: [1, "a"] },
    { label: "{}", config: {} },
    { label: '{"doc:":1}', config: { "doc:": 1 } },
  ];

  it("タグの先頭バイト集合が走査から取れている", () => {
    // 空集合なら下の検査は「何とも交わらない」で必ず緑になる
    assert.ok(SCANNED.length >= 5, `タグを ${SCANNED.length} 件しか拾えていない`);
    assert.deepEqual(
      [...tagFirstBytes].sort((a, b) => a - b).map((b) => String.fromCharCode(b)),
      ["a", "d", "o", "v"],
    );
  });

  it("代表入力の原像はどれもタグの先頭バイトで始まらない", () => {
    const bad = SAMPLES.filter((s) => collides(canonicalConfigPreimage(s.config))).map(
      (s) => `${s.label} -> ${JSON.stringify(canonicalConfigPreimage(s.config))}`,
    );
    assert.deepEqual(bad, []);
  });

  it("衝突の判定そのものが働いている（空振りしていない）", () => {
    // 上の検査は `collides` が常に false でも緑になります。
    // タグで始まる字面を1つ渡して、拾えることを確かめる
    assert.equal(collides("doc:1:a"), true);
    assert.equal(collides("out:"), true);
    assert.equal(collides('{"a":1}'), false);
  });

  /**
   * 実行は**標本であって証明ではありません。**
   * `encodeValue` に枝が1本増えれば、標本が通らない出力が生まれます。
   *
   * 枝の集合そのものを `ids.ts` の AST から固定します。
   * 増えても減っても落ち、「その枝の先頭バイトは何か」を人間が答えます。
   */
  describe("枝の集合が増えていない（標本の網羅性の担保）", () => {
    /** `encodeValue` の宣言。`canonicalConfigPreimage` が委譲する唯一の先 */
    function encodeValueDecl(): ts.FunctionDeclaration {
      let found: ts.FunctionDeclaration | undefined;
      source.forEachChild((node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === "encodeValue") found = node;
      });
      assert.ok(found, `${IDS} に encodeValue が無い`);
      return found;
    }

    const shape = ((): { cases: string[]; returns: number } => {
      const cases: string[] = [];
      let returns = 0;
      const visit = (node: ts.Node): void => {
        if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) {
          cases.push(node.expression.text);
        }
        if (ts.isReturnStatement(node)) returns += 1;
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(encodeValueDecl(), visit);
      return { cases, returns };
    })();

    /** `typeof` で分岐している型の宣言。増えたら標本を足すこと */
    const ENCODE_CASES: ReadonlyArray<string> = [
      "boolean",
      "number",
      "string",
      "bigint",
      "undefined",
    ];

    /**
     * 値を返す枝の本数。`null` / boolean / number / string / 配列 / オブジェクトの6本。
     * `bigint` と `undefined` は throw なので return を持たない。
     */
    const ENCODE_RETURNS = 6;

    it("typeof の分岐が宣言と完全一致する", () => {
      assert.deepEqual([...shape.cases].sort(), [...ENCODE_CASES].sort());
    });

    it("値を返す枝の本数が変わっていない", () => {
      assert.equal(
        shape.returns,
        ENCODE_RETURNS,
        "枝が増減した。代表入力群がその枝を通っているか確かめること",
      );
    });
  });
});
