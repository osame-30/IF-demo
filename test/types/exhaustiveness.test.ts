/**
 * AC-EXH-01 / AC-EXH-02 — 宣言した種別が**実際に起きる**ことの機械検査。
 *
 * `ObservationKind` は21種、`StoreErrorCode` は8種あります。宣言だけがあって
 * 誰も発行しない種別は、監査から見ると「起きるはずのことが起きていない」のか
 * 「起きないことになっている」のかが区別できません。片方は欠陥です。
 *
 * **「宣言と記述の一致」では足りません。** `kind: "quarantined"` と書かれた行が
 * どこかにありさえすれば AST 検査は緑になります。書かれていても到達しない行は
 * それで素通りします。ここで突き合わせるのは記述ではなく、
 * **走行中に実際に DB へ書かれた kind と、実際に送出された code** です。
 *
 * そのため、この検査だけはテスト一式を子プロセスで**もう一度**走らせます。
 * `node:test` はファイルごとにプロセスを分けるので、1プロセス内で
 * 全走行の和集合を持てないためです。収集器（`exhaustiveness-recorder.ts`）は
 * 環境変数が立っているときだけ働き、通常の実行には影響しません。
 *
 * 未到達の許可リストは**空になりません。** ストアが書かず呼び出し側が書く種別と、
 * 契約だけ先にある種別があるためです。**空にすることを目的にしないでください。**
 * 行が増えたらテストが落ち、「新しく死んだのか、意図して先に置いたのか」を
 * 人間が判断することになります。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { SINK_ENV } from "../support/exhaustiveness-recorder.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TYPES = fileURLToPath(new URL("../../src/domain/types.ts", import.meta.url));
const ERRORS = fileURLToPath(new URL("../../src/domain/errors.ts", import.meta.url));

/**
 * 宣言されているが、**この一式では一度も書かれない**観測種別。
 *
 * この3つには `src/**` のどこにも発行元がありません。理由は2種類あります。
 *
 *   - **判定関数が読み取り専用だから**（`verifyBlobReferences`）。
 *     列挙は1行も書かない契約なので、記録するかどうかは呼び出し側の判断です。
 *     `blob_reference_broken` がこれ。
 *   - **その判断を下す層がまだ無いから。** リネーム候補を確定する・隔離する、は
 *     どちらもまだ誰も下していない判断です。
 *     `rename_candidate_detected` / `quarantined` がこれ。
 *
 * **`document_missing` は STEP 4 で外れました。** `findMissingSince` は
 * いまも1行も書きません。変わったのは、その結果を受けて書く層
 * （`src/pipeline/scan.ts`）ができたことです。
 *
 * `ObservationKind` は「ストアが書く種別」と「呼び出し側が書く種別」を
 * いまも区別していません。**分けるかどうかは未決のままです。**
 *
 * 発行元を書いたらここから消してください。**消し忘れると落ちます**（逆方向）。
 */
const NOT_YET_EMITTED: ReadonlyArray<string> = [
  "rename_candidate_detected",
  "blob_reference_broken",
  "quarantined",
];

/**
 * 宣言されているが、この一式では一度も送出されないエラーコード。**空です。**
 *
 * `blob_divergence` は長く未送出でした。BlobStore の契約だけが先にあり、
 * 送出元が無かったためです。STEP 2b で `FileBlobStore` が入り、
 * 「鍵の位置に別内容がある」を実際に投げるようになったので外しました。
 *
 * **空のリストと空の走査結果は deepEqual では区別できません。** 走査の生存は
 * 同じ describe の中で別に確かめています。
 */
const NOT_YET_THROWN: ReadonlyArray<string> = [];

function unionMembers(file: string, typeName: string): ReadonlyArray<string> {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2023, true);
  let found: ReadonlyArray<string> | undefined;
  source.forEachChild((node) => {
    if (!ts.isTypeAliasDeclaration(node) || node.name.text !== typeName) return;
    if (!ts.isUnionTypeNode(node.type)) return;
    found = node.type.types.flatMap((t) =>
      ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? [t.literal.text] : [],
    );
  });
  assert.ok(found, `${typeName} not found as a string-literal union in ${file}`);
  return found;
}

let spawnFailure: string | null = null;

/**
 * 子に渡す環境。**`NODE_TEST_CONTEXT` を落とすのが要点です。**
 *
 * node:test は自分が起こした子プロセスにこれを立てます。そのまま継承すると、
 * 孫として起こしたテストランナーが「自分は既にテストの子だ」と判断して
 * 1ファイルも走らせずに黙って終了します。**終了コードは 0 なので、
 * 起動失敗としても検出できません。** 全種別が未到達になるだけです。
 */
const parentEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("NODE_TEST_")),
);

/** 一式を子プロセスで走らせ、実際に現れた kind / code の和集合を返す */

function collect(): { observations: ReadonlySet<string>; errors: ReadonlySet<string> } {
  const dir = mkdtempSync(join(tmpdir(), "exh-"));
  const sink = join(dir, "sink.tsv");
  writeFileSync(sink, "");
  try {
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--disable-warning=ExperimentalWarning",
        "--test",
        "src/**/*.test.ts",
        "test/**/*.test.ts",
      ],
      {
        cwd: ROOT,
        stdio: "ignore",
        env: {
          ...parentEnv,
          [SINK_ENV]: sink,
          // node:test はファイルごとにさらにプロセスを分ける。--import は
          // 継承されないので NODE_OPTIONS で伝える（パスは file: URL。
          // Windows のバックスラッシュがそのままだと解決に失敗する）
          NODE_OPTIONS: `--import tsx --import ${new URL(
            "../support/exhaustiveness-recorder.ts",
            import.meta.url,
          ).href}`,
        },
      },
    );
  } catch (error) {
    // 一式が赤でも収集はできている。ここで落とすと本来の失敗を隠すので進む。
    // ただし「起動そのものに失敗した」を無音にすると全種別が未到達になって
    // 未到達リストを膨らませるだけで緑にできてしまうので、痕跡は残す
    spawnFailure = error instanceof Error ? error.message : String(error);
  }

  const observations = new Set<string>();
  const errors = new Set<string>();
  for (const line of readFileSync(sink, "utf8").split("\n")) {
    const [channel, value] = line.split("\t");
    if (value === undefined) continue;
    if (channel === "observation") observations.add(value);
    else if (channel === "error") errors.add(value);
  }
  rmSync(dir, { recursive: true, force: true });
  return { observations, errors };
}

// 収集される側（子プロセス）では自分自身を走らせない。無限再帰になる
const inChild = process.env[SINK_ENV] !== undefined;

describe("AC-EXH: 宣言した種別が実際に起きる", { skip: inChild }, () => {
  const declaredKinds = unionMembers(TYPES, "ObservationKind");
  const declaredCodes = unionMembers(ERRORS, "StoreErrorCode");
  const seen = collect();

  it("AC-EXH-01: ObservationKind は、発行されるか未到達リストに載っているかのどちらか", () => {
    const unreached = declaredKinds.filter((k) => !seen.observations.has(k));
    assert.deepEqual(
      [...unreached].sort(),
      [...NOT_YET_EMITTED].sort(),
      "宣言したのに一度も書かれない kind が増えた（または未到達リストが古い）",
    );
  });

  it("AC-EXH-01: 書かれた kind はすべて宣言されている", () => {
    const undeclared = [...seen.observations].filter((k) => !declaredKinds.includes(k));
    assert.deepEqual(undeclared, [], "宣言に無い kind が書かれている");
  });

  it("AC-EXH-02: StoreErrorCode は、送出されるか未送出リストに載っているかのどちらか", () => {
    const unthrown = declaredCodes.filter((c) => !seen.errors.has(c));
    assert.deepEqual([...unthrown].sort(), [...NOT_YET_THROWN].sort());
  });

  it("AC-EXH-02: 送出された code はすべて宣言されている", () => {
    const undeclared = [...seen.errors].filter((c) => !declaredCodes.includes(c));
    assert.deepEqual(undeclared, []);
  });

  it("収集そのものが働いている（空の和集合を緑と読まない）", () => {
    // 収集器が壊れると全部「未到達」になり、上の3つは
    // 未到達リストを膨らませれば緑にできてしまう。下限を置く
    assert.equal(spawnFailure, null, "収集用の子プロセスが起動できていない");
    assert.ok(seen.observations.size >= 10, `observations collected: ${seen.observations.size}`);
    assert.ok(seen.errors.size >= 5, `errors collected: ${seen.errors.size}`);
  });
});
