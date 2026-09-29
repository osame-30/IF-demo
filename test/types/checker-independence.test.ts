/**
 * AC-IND-01 — **不変条件チェッカーが domain の実装を使っていない**ことの機械検査。
 *
 * `src/audit/invariant-checker.ts` は `outputsHash` / `derivationKey` /
 * `stableKey` の正規化を**独立に再実装**しています。
 * ストアが書いた値をストア自身の関数で検算しても何も証明できないためです。
 *
 * ## この独立性は、いままで規約でしか守られていませんでした
 *
 * 実体は「`src/domain/ids.ts` を import していない」というそれだけで、
 * **誰かが1行足せば消えます。しかも消えても全部緑のままです** ——
 * 両端が同じ実装になるので `DERIVATION_KEY_MATCHES_MATERIALS` は必ず通り、
 * `DERIVATION_OUTPUT_STABLE` も通ります。**検算が自己整合に変わったことは、
 * どのテストにも現れません。**
 *
 * つまりここでは**不在が保証の実体**です。不在は検査できます。
 *
 * ## 推移で見る理由
 *
 * 直接の import だけを見ると、`ids.ts` を再輸出するヘルパを1枚挟むだけで
 * すり抜けます。到達経路の閉包で見ます（`import-graph.ts` は AC-EVD-01 と共有）。
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

import { forwardClosure, ROOT } from "./import-graph.ts";
import { checkInvariants } from "../support/invariant-checker.ts";
import { __unsafeSourceId, __unsafeVersionId } from "../support/unsafe-brands.ts";
import {
  derivationKey,
  documentIdPreimage,
  derivationKeyPreimage,
} from "../../src/domain/ids.ts";
import type { KeyNormalizationPolicy, VersionId } from "../../src/domain/types.ts";

/** 独立していなければならないファイル */
const CHECKER = "src/audit/invariant-checker.ts";

/**
 * チェッカーが**触れてはいけない**もの。
 *
 * - `src/domain/ids.ts` … 検算対象の式そのもの
 * - `src/store/**` … ストアの実装。表を直接読むのが契約なので、経由してはいけない
 * - `test/support/echo-processor.ts` … こちらも `outputsHash` を独立再計算しており、
 *   そちらの実装を借りると「独立した2実装」が1つに縮む
 */
const FORBIDDEN: ReadonlyArray<string> = [
  "src/domain/ids.ts",
  "src/domain/evidence.ts",
  "test/support/echo-processor.ts",
];

describe("AC-IND-01: 不変条件チェッカーは domain の導出実装に到達できない", () => {
  const closure = forwardClosure(CHECKER);

  it("禁止された実装に import で到達できない（推移で見る）", () => {
    const violations = FORBIDDEN.filter((f) => closure.has(f));
    assert.deepEqual(
      violations,
      [],
      `${CHECKER} が検算対象の実装に到達している。` +
        "独立再実装が自己整合に変わっても、テストは全部緑のままになる",
    );
  });

  it("ストアの実装に到達できない", () => {
    const store = [...closure].filter((f) => f.startsWith("src/store/"));
    assert.deepEqual(store, [], "チェッカーは生の表を直接読む。ストアを経由しない");
  });

  it("走査が空振りしていない（実際に何かをたどっている）", () => {
    // 上の2つは「import を1つも見つけられない」でも緑になります。
    // チェッカーが実際に import しているものを1つ名指しして、走査の生存を確かめる
    assert.ok(closure.has("src/domain/types.ts"), `closure: ${[...closure].join(", ")}`);
    assert.ok(closure.has("src/audit/state-snapshot.ts"));
  });

  it("チェッカーが依存してよいのは型と snapshot だけ", () => {
    // 増えたら落とす。何を借りたのかを人間が見る
    assert.deepEqual(
      [...closure].sort(),
      ["src/audit/state-snapshot.ts", "src/domain/types.ts"],
    );
  });

  /**
   * `src/domain/types.ts` は許可されています。**確認済み: 借りているのは型だけです。**
   *
   * 再確認しなくて済むように理由を残します（2026-09-06 時点で測定）。
   *
   *   - `types.ts` の**値** export は `INVARIANTS` の1つだけ。
   *     チェッカーが使うのはそのキー集合（報告漏れの検査）で、
   *     値は `"..._count == 0"` という**主張の文言**であって式ではありません
   *   - 鍵の式の部品——原像の符号化（長さ前置の `field` / `fieldList` / `preimageOf`）、
   *     タグ（`"der:"` / `"ver:"` / `"doc:"` / `"art:"` / `"out:"`）、ハッシュ名（`sha256`）、
   *     正規化——は**すべて `ids.ts` の中**にあり、どれも export されていません
   *     （`SEP` も同様。ただし `SEP` が残っているのは `outputsHash` だけです）
   *   - `types.ts` に式が現れるのは doc comment の中だけ。コードから参照できません
   *
   * **つまり「チェッカーのリテラルが types.ts 由来でない」ことは、
   * 由来になり得る値が存在しないという形で成立しています。**
   * `types.ts` が式の部品を値として export し始めたら、この前提は崩れます。
   * そのときは AC-IND-01 に「checker のリテラルが types.ts 由来でない」検査を足してください。
   */
  it("types.ts は式の部品を値として export していない（借りようがない）", () => {
    const types = readFileSync(join(ROOT, "src/domain/types.ts"), "utf8");
    const source = ts.createSourceFile("types.ts", types, ts.ScriptTarget.ES2023, true);

    const valueExports: string[] = [];
    source.forEachChild((node) => {
      const exported = ts
        .getModifiers(node as ts.HasModifiers)
        ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (exported !== true) return;
      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) valueExports.push(d.name.getText());
      } else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) {
        valueExports.push(node.name?.text ?? "(anonymous)");
      } else if (ts.isEnumDeclaration(node)) {
        valueExports.push(node.name.text);
      }
    });

    // 増えたら落とす。増えた値が式の部品なら、独立性の前提が変わる
    assert.deepEqual(valueExports, ["INVARIANTS"]);
  });
});

/**
 * AC-IND-01 は**独立していること**しか見ません。
 * 独立した2実装が同じ規則を実装しているかは、値を突き合わせないと分かりません。
 *
 * ## ASCII だけでは長さ前置の「長さ」が測れません
 *
 * 原像の長さ前置は `Buffer.byteLength(s, "utf8")` です（`ids.ts` の `field`、
 * checker 側の `f`）。ASCII 入力では `s.length` と一致するので、
 * **どちらかが `.length` に変わっても既存の固定値テストは全部緑のままです**
 * ——`"art:4:der11:0"` のような ASCII のベクタでは差が出ません。
 *
 * 多バイト入力を1組通せば、その入れ替えは両実装の食い違いとして現れます。
 */
describe("AC-IND-01: 独立した2実装は多バイト入力でも同じ鍵を出す", () => {
  const SCHEMA = readFileSync(join(ROOT, "schema.sql"), "utf8");

  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(SCHEMA);
  });

  /** UTF-8 バイト列の昇順。`input_ids` は鍵に入った順で保存されていなければならない */
  const byUtf8 = (a: string, b: string): number =>
    Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

  /**
   * `derivation` 行だけを直接置きます。FK は張らない
   * （検証対象は鍵の再導出だけで、系譜の健全性は別の不変条件の担当）。
   */
  function seedDerivation(
    key: string,
    materials: { processorName: string; processorVersion: string; configHash: string },
    inputIds: ReadonlyArray<string>,
  ): void {
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
      `INSERT INTO derivation
         (derivation_key, processor_name, processor_version, config_hash, input_ids,
          root_version_id, document_id, created_at, artifact_count, outputs_hash)
       VALUES (?, ?, ?, ?, ?, 'ver-1', 'doc-1', 1000, 0, 'out')`,
    ).run(
      key,
      materials.processorName,
      materials.processorVersion,
      materials.configHash,
      JSON.stringify([...inputIds].sort(byUtf8)),
    );
  }

  async function keyProblems(): Promise<string[]> {
    const report = await checkInvariants({
      reader: { all: (sql) => Promise.resolve(db.prepare(sql).all()) },
    });
    const result = report.results.find((r) => r.name === "DERIVATION_KEY_MATCHES_MATERIALS");
    assert.ok(result, "DERIVATION_KEY_MATCHES_MATERIALS が報告に無い");
    return result.findings.map((f) => f.problem);
  }

  /** 全フィールドが多バイト。`.length` と `Buffer.byteLength` が3倍ずれる */
  const MULTIBYTE = {
    processorName: "抽出器",
    processorVersion: "第一版",
    configHash: "設定の指紋",
  };

  it("スカラー3場が多バイトでも、checker が同じ鍵を再導出する", async () => {
    const inputIds = [__unsafeVersionId("入力あ")];
    seedDerivation(derivationKey({ ...MULTIBYTE, inputIds }), MULTIBYTE, inputIds);
    assert.deepEqual(await keyProblems(), []);
  });

  it("inputIds が多バイト2要素でも一致する（fieldList 経路）", async () => {
    const inputIds = [__unsafeVersionId("入力あ"), __unsafeVersionId("入力い")];
    // 前提: この2つは UTF-8 バイト列でこの順。ソート規則が食い違えば別の違反が出る
    assert.ok(byUtf8(inputIds[0]!, inputIds[1]!) < 0);
    seedDerivation(derivationKey({ ...MULTIBYTE, inputIds }), MULTIBYTE, inputIds);
    assert.deepEqual(await keyProblems(), []);
  });

  it("突き合わせが空振りしていない（食い違えば検出される）", async () => {
    // 上の2件は「checker が何も見ていない」でも緑になります。
    // 実導出でない鍵を1本置いて、検出側が生きていることを確かめる
    const inputIds = [__unsafeVersionId("入力あ")];
    seedDerivation("der-1", MULTIBYTE, inputIds);
    assert.deepEqual(await keyProblems(), ["derivation_key_does_not_match_materials"]);
  });

  /**
   * `sourceId` は導出鍵に入りません（`der:` の場は processorName /
   * processorVersion / configHash / inputIds の4つだけ）。
   * checker は `documentId` を再導出しないので、こちらには突き合わせる相手がいません。
   *
   * 代わりに原像そのものを固定します。**バイト長でなければ落ちます。**
   */
  it("多バイトの sourceId と stableKey はバイト長で前置される", () => {
    const policy: KeyNormalizationPolicy = {
      unicodeForm: "NFC",
      caseFold: false,
      pathSeparator: "posix",
      trimSlashes: true,
    };
    // "源" は3バイト、"資料.txt" は 3+3+4 = 10 バイト。文字数なら 1 と 6
    assert.equal(
      documentIdPreimage(__unsafeSourceId("源"), "資料.txt", policy),
      "doc:3:源10:資料.txt",
    );
  });

  /** 原像の場の数と長さを1本で見る。鍵側の固定値（ASCII では差が出ない） */
  it("derivationKey の原像は多バイトでもバイト長を前置する", () => {
    const inputIds = [__unsafeVersionId("入力あ")] as ReadonlyArray<VersionId>;
    assert.equal(
      derivationKeyPreimage({ ...MULTIBYTE, inputIds }),
      "der:9:抽出器9:第一版15:設定の指紋1:9:入力あ",
    );
  });
});
