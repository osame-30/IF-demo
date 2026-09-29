/**
 * AC-BRD-01 — ブランド型を「洗って」作る経路の全リスト。
 *
 * ## 字面ではなく文脈型で数えます
 *
 * AC-EVD-01 は `as VerifiedAt` という**字面**を数えていました。
 * それだと `bad as never` が素通りします —— `never` はどんな型にも代入できるので、
 * **`as never` はすべてのブランドを一度に洗える万能の漂白剤**です。
 * 実際 `VerifiedAt` の洗浄が1件、AC-EVD-01 をすり抜けていました（実測）。
 *
 * ここでは型検査器に**その位置で期待されている型**を尋ね、
 * それがブランド（またはブランドの配列）なら計上します。
 * 洗い方が `never` でも `any` でも `unknown` 経由でも山括弧でも、同じ1件です。
 *
 * ## 許可リスト方式
 *
 * 空にはできません。正規の経路で作れない値を渡して拒否を確かめる試験があるためです。
 * **ただし置き場所は限定します**（`__unsafe` 族）。
 * 行が増えたら落ち、「その値は本物の経路で作れないのか」を人間が答えることになります。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { relative, resolve } from "node:path";
import ts from "typescript";

import { importsOf, repoFiles, ROOT } from "./import-graph.ts";

const rel = (f: string): string => relative(ROOT, f).split("\\").join("/");

const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, "tsconfig.json");
assert.ok(configPath, "tsconfig.json not found");
const parsed = ts.parseJsonConfigFileContent(
  ts.readConfigFile(configPath, ts.sys.readFile).config,
  ts.sys,
  ROOT,
);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();

/** ブランドの一覧は `types.ts` から拾う。手で並べると増えたときに漏れる */
function brandNames(): ReadonlySet<string> {
  const source = program.getSourceFile(resolve(ROOT, "src/domain/types.ts"));
  assert.ok(source, "src/domain/types.ts not in program");
  const out = new Set<string>();
  source.forEachChild((node) => {
    if (
      ts.isTypeAliasDeclaration(node) &&
      ts.isTypeReferenceNode(node.type) &&
      ts.isIdentifier(node.type.typeName) &&
      (node.type.typeName.text === "Brand" || node.type.typeName.text === "Attested")
    ) {
      out.add(node.name.text);
    }
  });
  return out;
}

const BRANDS = brandNames();

/**
 * その型がブランドか、要素型がブランドの配列なら名前を返す。
 *
 * 配列を含めるのは、`["v1", "v2"] as never` が
 * `readonly (VersionId | ArtifactId)[]` の位置に入るためです。
 * 要素だけ見て「配列は対象外」にすると、洗浄の主要な形が丸ごと漏れます。
 */
function brandOf(type: ts.Type | undefined): string | null {
  if (type === undefined) return null;
  const text = checker.typeToString(type);
  if (BRANDS.has(text)) return text;
  const element = /^(?:readonly )?\(?([A-Za-z]+)(?: \| [A-Za-z]+)*\)?\[\]$/.exec(text);
  return element !== null && BRANDS.has(element[1]!) ? text : null;
}

interface Washing {
  file: string;
  brand: string;
  form: "never" | "never-array" | "any" | "unknown-as" | "angle";
}

/**
 * **裸の `as never` だけは文脈型を見ずに無条件で計上します。**
 *
 * 文脈型で数える方式には、網の広さが**この検査自身が強制していない性質**——
 * 代入先に型注釈があること——に依存する弱点があります。
 * 誰かが局所ヘルパから注釈を落とせば網は静かに縮み、
 * **縮んだこと自体はどのテストにも現れません。**
 *
 * `as never` についてはその弱点を消せます。この形式に正当な用途が
 * **1件も無い**ことが測れているためです。
 *
 *   - 唯一の非洗浄用途だった `SnapshotReader` 周りの6件は、
 *     戻り値型が元から正しく、消しても型検査が通りました
 *   - 残った3件は全部ブランドの洗浄で、本物の経路に置き換わりました
 *
 * **`as never[]` は別形式で、こちらは無条件にできません。**
 * `prepare(sql).get(...(params as never[]))` という可変長引数の回避策が
 * 10件あり（実測）、ブランドとは無関係です。`never[]` は
 * `ArrayType` なので `NeverKeyword` とは構文的にも別物です。
 * ただし `["a","b"] as never[]` は `readonly VersionId[]` の位置を洗えるので、
 * **文脈型つきで計上します**（この分岐が無かった間は穴でした）。
 */
const washings: Washing[] = [];
/** 走査の生存確認に使う。ブランドかどうかに関係なく数える */
let visitedAssertions = 0;
/** `never` を含む型表明（裸・配列の両方）。never 判定そのものの生存確認 */
let visitedNeverForms = 0;

/** 文脈型の表示名。ブランドならブランド名、違えば実際の型、無ければ印 */
function contextLabel(node: ts.Expression): string {
  const type = checker.getContextualType(node) ?? undefined;
  return brandOf(type) ?? (type === undefined ? "文脈型なし" : checker.typeToString(type));
}

for (const source of program.getSourceFiles()) {
  const file = rel(resolve(source.fileName));
  if (!file.startsWith("src/") && !file.startsWith("test/")) continue;

  const visit = (node: ts.Node): void => {
    if (ts.isAsExpression(node)) {
      visitedAssertions += 1;
      const type = node.type;
      const bareNever = type.kind === ts.SyntaxKind.NeverKeyword;
      const neverArray =
        ts.isArrayTypeNode(type) && type.elementType.kind === ts.SyntaxKind.NeverKeyword;
      if (bareNever || neverArray) visitedNeverForms += 1;

      if (bareNever) {
        // 文脈型を見ない。見ると網の広さが注釈の有無に依存する
        washings.push({ file, brand: contextLabel(node), form: "never" });
      } else {
        const viaUnknown =
          ts.isAsExpression(node.expression) &&
          node.expression.type.kind === ts.SyntaxKind.UnknownKeyword;
        const form: Washing["form"] | null = neverArray
          ? "never-array"
          : type.kind === ts.SyntaxKind.AnyKeyword
            ? "any"
            : viaUnknown
              ? "unknown-as"
              : null;
        if (form !== null) {
          const brand = brandOf(checker.getContextualType(node) ?? undefined);
          if (brand !== null) washings.push({ file, brand, form });
        }
      }
    }
    if (ts.isTypeAssertionExpression(node)) {
      visitedAssertions += 1;
      const brand = brandOf(checker.getContextualType(node) ?? undefined);
      if (brand !== null) washings.push({ file, brand, form: "angle" });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

/** `ファイル: 件数 × ブランド (洗い方)` に畳む。行番号は入れない（編集で動くだけ） */
function summarize(list: ReadonlyArray<Washing>): string[] {
  const counts = new Map<string, number>();
  for (const w of list) {
    const key = `${w.file}: ${w.brand} (${w.form})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([k, n]) => `${n} × ${k}`).sort();
}

/**
 * ブランドを洗ってよい場所の全リスト。**空です。**
 *
 * 洗浄（`as never` / `as never[]` / `as any` / `unknown` 経由 / 山括弧）は
 * 0件にしました。裸の `as never` は文脈型に関わらず0件です。
 *
 * 正規の経路で作れない値は `test/support/unsafe-brands.ts` の
 * `__unsafe` 族を通ります。あちらは**直接のブランド表明**なので、
 * ここでは数えません（洗浄ではない）。この検査は
 * 直接の `as <Brand>` を対象にしていません（KNOWN_LIMITATIONS 13節）。
 *
 * 行が増えたら落ちます。増やす前に「その値は本物の経路で作れないのか」に
 * 答えてください。答えが「作れない」なら、置き場所は `__unsafe` 族です。
 */
const ALLOWED: ReadonlyArray<string> = [];

/**
 * 同一性ブランドの逃げ道を**直接 import している**ファイルの全リスト。
 *
 * **推移閉包ではありません。** `test/fixtures/context.ts`（全フィクスチャの土台）が
 * `__unsafeBlobKey` を使うので、推移で見ると31ファイルに膨らみ、
 * 「誰が作っているか」ではなく「誰が土台を使っているか」の表になります（実測）。
 * 直接 import しているファイルが、実際に作っているファイルです。
 *
 * 証拠の逃げ道（`unsafe-evidence.ts`）は逆に**推移閉包**で見ます。
 * あちらの主張は「本番コードは嘘の証拠に到達できない」で、
 * 到達可能性そのものが問題だからです（AC-EVD-01）。
 */
const BRAND_HATCH = "test/support/unsafe-brands.ts";

const HATCH_USERS: ReadonlyArray<string> = [
  // BlobKey: 内容ハッシュでない置き値を使っている2本。本物の経路
  // （ids.ts の blobKeyOf）は小文字16進しか受け取らないので、
  // `art-blob-0` や `b-extra-3` のような読みやすい置き値はここを通ります。
  // `blob/${hash}` を使っていたフィクスチャ5本は blobKeyOf へ移しました
  "src/store/sqlite/derivation.test.ts",
  "src/store/sqlite/lease.test.ts",
  // 宣言に無い kind / 存在しない artifactId を拒むことの試験
  "src/store/sqlite/connection.test.ts",
  "src/store/sqlite/scan.test.ts",
  // 生 SQL で seed した version_id / source_id を検査する
  "test/support/invariant-checker.test.ts",
  // 多バイトの materials を持つ derivation 行を生 SQL で置き、
  // ids.ts と checker の独立実装が同じ鍵を出すことを突き合わせる
  "test/types/checker-independence.test.ts",
];

describe("AC-BRD-01: ブランドを洗う経路は許可リストと完全一致する", () => {
  it("洗浄の全リストが許可リストと一致する", () => {
    assert.deepEqual(summarize(washings), [...ALLOWED].sort());
  });

  it("走査が空振りしていない", () => {
    // 許可リストは将来空になりえます。空のリストと空の走査結果は
    // deepEqual では区別できないので、走査そのものの生存を別に確かめる
    assert.equal(BRANDS.size, 13, `types.ts から拾えたブランド: ${[...BRANDS].join(", ")}`);
    assert.ok(visitedAssertions > 100, `型表明を ${visitedAssertions} 件しか見ていない`);
    // 裸の `as never` は0件なので、never 判定の生存は `never[]` 側で確かめる。
    // 可変長引数の回避策が10件ある（`prepare(sql).get(...(p as never[]))`）
    assert.ok(visitedNeverForms >= 10, `never を含む型表明を ${visitedNeverForms} 件しか見ていない`);
  });

  it("`as any` と `unknown` 経由は1件も無い", () => {
    // 許可リストに紛れ込ませない。数が0のうちは形式ごと禁止でよい。
    // `never-array` を除くのは、あれが `never` 族で上の検査の担当だから
    const soft = washings.filter((w) => w.form === "any" || w.form === "unknown-as");
    assert.deepEqual(summarize(soft), []);
  });

  it("逃げ道を直接 import しているファイルは宣言と完全一致する", () => {
    const users = repoFiles().filter((f) => importsOf(f).includes(BRAND_HATCH));
    assert.deepEqual([...users].sort(), [...HATCH_USERS].sort());
  });
});
