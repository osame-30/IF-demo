/**
 * AC-BLB-01..04 — BlobStore の契約が「何を書けなくしているか」の機械検査。
 *
 * 契約の値打ちは、**書けない誤りの集合**にあります。散文で「put に鍵を
 * 渡さないこと」と書いても、渡す実装は書けます。ここでは口の形そのものを
 * 検査して、4つの誤りが型として成立しないことを固定します。
 *
 * 実装（STEP 3）より先にこれを置くのは順序の問題です。実装が先にあると、
 * 検査を後から入れるときに「今動いているから」を理由に口が残ります。
 *
 * ---
 *
 * **この検査で守れないこと。**
 *
 * ブランド型は `as` を止めません（AGENTS.md 9節、実測済み）。`BlobDeletionGrant`
 * を偽造したコードは型検査を通ります。削除順序を実際に守らせているのは
 * `grant.token` の照合で、そちらは実装（STEP 3）の担当です。
 * ここが守るのは**事故**で、故意ではありません。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TYPES = fileURLToPath(new URL("../../src/domain/types.ts", import.meta.url));

const source = ts.createSourceFile(
  TYPES,
  readFileSync(TYPES, "utf8"),
  ts.ScriptTarget.ES2023,
  true,
);

function interfaceNamed(name: string): ts.InterfaceDeclaration {
  let found: ts.InterfaceDeclaration | undefined;
  source.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) found = node;
  });
  assert.ok(found, `interface ${name} not found in types.ts`);
  return found;
}

const blobStore = interfaceNamed("BlobStore");

function method(name: string): ts.MethodSignature {
  const member = blobStore.members.find(
    (m) => ts.isMethodSignature(m) && m.name?.getText() === name,
  );
  assert.ok(member, `BlobStore.${name} not found`);
  return member as ts.MethodSignature;
}

/** interface のプロパティの型を文字列で取る */
function propertyType(declaration: ts.InterfaceDeclaration, name: string): string {
  const member = declaration.members.find((m) => m.name?.getText() === name);
  assert.ok(member, `${declaration.name.text}.${name} not found`);
  return (member as ts.PropertySignature).type?.getText() ?? "?";
}

/** その口の引数を `名前: 型` で並べる */
const signature = (name: string): ReadonlyArray<string> =>
  method(name).parameters.map((p) => `${p.name.getText()}: ${p.type?.getText() ?? "?"}`);

describe("AC-BLB: BlobStore の契約が書けなくするもの", () => {
  it("AC-BLB-01: put は鍵を受け取らない（鍵と中身が食い違う put が書けない）", () => {
    assert.deepEqual(signature("put"), [
      "content: ReadableStream<Uint8Array>",
      "expectedSizeBytes: number",
    ]);
  });

  it("AC-BLB-01: exists() は無い。「存在する」を「正しい」の証拠にしない", () => {
    const names = blobStore.members.map((m) => m.name?.getText());
    assert.ok(!names.includes("exists"), "BlobStore must not have exists()");
    // 名前を変えた同型の口も塞ぐ。has / stat / size はどれも
    // 「読まずに存在だけ答える」形なので、exists() の言い換えになる
    for (const banned of ["has", "stat", "size", "head"]) {
      assert.ok(!names.includes(banned), `BlobStore must not have ${banned}()`);
    }
  });

  it("AC-BLB-02: get は expectedHash を要求する（検証を忘れた読み取りが書けない）", () => {
    assert.deepEqual(signature("get"), ["key: BlobKey", "expectedHash: ContentHash"]);
  });

  it("AC-BLB-02: 未検証の口は1つだけで、修復専用と名乗っている", () => {
    const unverified = blobStore.members
      .map((m) => m.name?.getText() ?? "")
      .filter((n) => /^get/.test(n) && n !== "get");
    // 名前で切っているので、増えたらここで数が合わなくなる。
    // 「検証していない読み手」を grep で全部数えられる状態を保つため
    assert.deepEqual(unverified, ["getUnverifiedForRepair"]);
    assert.deepEqual(signature("getUnverifiedForRepair"), ["key: BlobKey"]);
  });

  it("AC-BLB-03: put の結果は created を持つ（冪等な再実行と食い違いが同じ見え方にならない）", () => {
    const put = interfaceNamed("PutResult");
    const fields = put.members.map((m) => m.name?.getText());
    assert.ok(fields.includes("created"), "PutResult must carry `created`");
    assert.ok(fields.includes("verifiedAt"), "PutResult must carry `verifiedAt`");
  });

  it("AC-BLB-03: blob_divergence が StoreErrorCode にある（上書きが正常系にならない）", () => {
    const errorsFile = fileURLToPath(new URL("../../src/domain/errors.ts", import.meta.url));
    const text = readFileSync(errorsFile, "utf8");
    assert.match(text, /\|\s*"blob_divergence"/);
    assert.match(text, /class BlobDivergenceError extends StoreError/);
  });

  it("AC-BLB-02: get は証拠を返す。生のストリームではない", () => {
    // 「読み切った」と「途中でやめた」の型が同じだと、下流に区別がつきません。
    // 返り値が VerifiedRead であることが、その区別の置き場所です
    assert.equal(method("get").type?.getText(), "Promise<VerifiedRead>");
    const read = interfaceNamed("VerifiedRead");
    assert.deepEqual(
      read.members.map((m) => m.name?.getText()),
      ["stream", "completed"],
    );
    assert.equal(propertyType(read, "completed"), "Promise<VerifiedContentHash>");
  });

  it("AC-BLB-03: put の証拠は証拠型で返る（任意の値を書けない）", () => {
    const put = interfaceNamed("PutResult");
    assert.equal(propertyType(put, "contentHash"), "VerifiedContentHash");
    assert.equal(propertyType(put, "verifiedAt"), "VerifiedAt");
  });

  it("AC-BLB-04: delete は鍵だけでは呼べない。授権と述語の評価者を要求する", () => {
    assert.deepEqual(signature("delete"), [
      "key: BlobKey",
      "grant: BlobDeletionGrant",
      "judge: BlobDeletionJudge",
    ]);
  });

  it("AC-BLB-04: 授権は主張を運ばない（token も対象鍵も持たない）", () => {
    // 「この鍵は消してよい」を値にすると、発行時点の世界が実行時点まで運ばれます。
    // 保存でき、遅延でき、バックアップから復元でき、組み替えられる値です。
    // 運んでよいのは授権の範囲だけ（AGENTS.md 9節 軸5）
    const grant = interfaceNamed("BlobDeletionGrant");
    const fields = grant.members.map((m) => m.name?.getText());
    assert.deepEqual(fields, ["grantedTo", "basedOn", "maxDeletions", "grantedAt"]);
    for (const banned of ["token", "blobKey", "nonce", "signature"]) {
      assert.ok(!fields.includes(banned), `BlobDeletionGrant must not carry ${banned}`);
    }
    // 走査世代に基づく授権であること。物理削除を論理削除と同じ門に従属させる
    assert.equal(propertyType(grant, "basedOn"), "CompletedScanRun");
  });

  it("AC-BLB-04: 述語は関数で受け取る（評価が実行時点に起きる）", () => {
    const judge = interfaceNamed("BlobDeletionJudge");
    const members = judge.members.filter(ts.isMethodSignature);
    assert.deepEqual(
      members.map((m) => m.name?.getText()),
      ["confirmDeletable"],
    );
    assert.equal(members[0]?.type?.getText(), "Promise<DeletionVerdict>");
  });

  it("AC-BLB-05: 参照のある壊れた blob からの出口がある（閉区画を作らない）", () => {
    // put は上書きしない × grant は参照のある鍵に出ない × 未検証読みは読むだけ。
    // 門はどれも正しいのに、積が出口を塞ぎます（KNOWN_LIMITATIONS 12節）
    assert.deepEqual(signature("restoreFromVerifiedBytes"), [
      "key: BlobKey",
      "content: ReadableStream<Uint8Array>",
      "expectedSizeBytes: number",
    ]);
  });

  it("AC-BLB-06: 参照の列挙は version と artifact の両方を含む", () => {
    // 到達可能性の閉包が経路ごとに分かれると、片方から見て孤児・
    // もう片方から見て生存、という鍵が作れます
    const store = interfaceNamed("LineageStore");
    const member = store.members.find(
      (m) => ts.isMethodSignature(m) && m.name?.getText() === "verifyBlobReferences",
    ) as ts.MethodSignature | undefined;
    assert.ok(member, "verifyBlobReferences not found");
    assert.equal(member.type?.getText(), "AsyncIterable<BlobReference>");

    const text = readFileSync(TYPES, "utf8");
    assert.match(text, /kind:\s*"version"/);
    assert.match(text, /kind:\s*"artifact"/);
  });

  it("AC-BLB-04: v0.1 に許可証の発行元は無い。だから delete は呼べない", () => {
    // 発行元（token 表を要する = schema.sql の変更）はオーナーの判断事項。
    // 入るまでは「入手経路が無い」ことが削除禁止の実体。
    // 発行メソッドを足すときは、この試験も一緒に書き換えること
    const store = interfaceNamed("LineageStore");
    const issuers = store.members.filter((m) =>
      /BlobDeletionGrant/.test((m as ts.MethodSignature).type?.getText() ?? ""),
    );
    assert.deepEqual(issuers, []);
  });
});
