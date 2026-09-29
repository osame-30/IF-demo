/**
 * ids.ts の凍結テスト。
 *
 * ここが緑でなければ他のテストは意味を持ちません（AGENTS.md 5節）。
 * 固定値は「全環境で同じ値が出ること」の証明なので、
 * 実装を変えて値が動いたらテストではなく実装を疑ってください。
 *
 * 低層の preimage 関数も直接叩きます。ハッシュだけを見ていると、
 * 区切りが消えたことに気づけるのが「たまたま衝突しなかったから」に
 * なってしまうためです。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  artifactId,
  blobKeyOf,
  artifactIdPreimage,
  canonicalConfigHash,
  canonicalConfigPreimage,
  derivationKey,
  derivationKeyPreimage,
  documentId,
  documentIdPreimage,
  normalizeStableKey,
  outputsHash,
  outputsHashPreimage,
  versionId,
} from "./ids.ts";
import type {
  ContentHash,
  DerivationKey,
  DocumentId,
  KeyNormalizationPolicy,
  SourceId,
  VersionId,
} from "./types.ts";
import { attestContentHash } from "./evidence.ts";
import { CONFIG_HASH_VECTORS } from "../../test/support/config-hash-vectors.ts";

const NUL = String.fromCharCode(0);

const policy = (over: Partial<KeyNormalizationPolicy> = {}): KeyNormalizationPolicy => ({
  unicodeForm: "NFC",
  caseFold: false,
  pathSeparator: "posix",
  trimSlashes: true,
  ...over,
});

// ----------------------------------------------------------------------------
// 凍結ベクタは test/support/config-hash-vectors.ts が正本。**ここに複製しない**
// ----------------------------------------------------------------------------

export const OUTPUTS_HASH_VECTORS = {
  empty: "7d33c9d029ac7d770c5ede79a2ae0989c9df1bd8b8ce5784e61ad7a8f0317ebe",
  pairA: "86268c9c541bca3aa1275b1ba7deea5b0023d8211d3a76a1482625aa22354c5a",
  pairB: "bfe2d83cab3d13025cd44b53b68ca22450755aa73993e58bc19a7c26db3ea0ed",
} as const;

// ----------------------------------------------------------------------------

describe("canonicalConfigHash (#22)", () => {
  for (const v of CONFIG_HASH_VECTORS) {
    it(`固定値: ${v.label}`, () => {
      assert.equal(canonicalConfigPreimage(v.config), v.preimage);
      assert.equal(canonicalConfigHash(v.config), v.expected);
    });
  }

  it("キーの順序は結果に影響しない", () => {
    assert.equal(canonicalConfigHash({ a: 1, b: 2 }), canonicalConfigHash({ b: 2, a: 1 }));
  });

  it("undefined のキーは欠落と同一に扱う", () => {
    assert.equal(canonicalConfigHash({ a: undefined }), canonicalConfigHash({}));
  });

  it("null は欠落と区別する", () => {
    assert.notEqual(canonicalConfigHash({ a: null }), canonicalConfigHash({}));
  });

  it("NFC と NFD は同一になる", () => {
    const nfc = { a: "café".normalize("NFC") };
    const nfd = { a: "café".normalize("NFD") };
    assert.notEqual(nfc.a, nfd.a, "前提: 2つの文字列は別物であること");
    assert.equal(canonicalConfigHash(nfc), canonicalConfigHash(nfd));
  });

  it("配列は順序を持つ", () => {
    assert.notEqual(canonicalConfigHash({ a: [1, 2] }), canonicalConfigHash({ a: [2, 1] }));
  });

  it("非ASCII を \\uXXXX にエスケープしない", () => {
    assert.equal(canonicalConfigPreimage({ a: "日本語" }), '{"a":"日本語"}');
  });

  it("出力に空白を含まない", () => {
    const preimage = canonicalConfigPreimage({ b: [1, 2], a: { c: "x" } });
    assert.ok(!/\s/.test(preimage), preimage);
  });

  it("浮動小数は例外", () => {
    assert.throws(() => canonicalConfigHash({ a: 1.5 }), /safe integers/);
    assert.throws(() => canonicalConfigHash({ a: 0.1 }), /safe integers/);
  });

  it("NaN と Infinity は例外", () => {
    assert.throws(() => canonicalConfigHash({ a: Number.NaN }), /NaN and Infinity/);
    assert.throws(() => canonicalConfigHash({ a: Number.POSITIVE_INFINITY }), /NaN and Infinity/);
  });

  it("bigint は凍結形式の外なので例外", () => {
    assert.throws(() => canonicalConfigHash({ a: 1n }), /bigint/);
  });

  it("NFC 正規化後に衝突するキーは例外（黙って畳まない）", () => {
    const key = { ["café".normalize("NFC")]: 1, ["café".normalize("NFD")]: 2 };
    assert.throws(() => canonicalConfigHash(key), /collide after NFC/);
  });

  it("-0 は 0 に畳む", () => {
    assert.equal(canonicalConfigHash({ a: -0 }), canonicalConfigHash({ a: 0 }));
  });

  /**
   * 2026-09-10 の指摘 4。
   *
   * `Array.prototype.map` は穴を飛ばして穴のまま返し、`join` はそれを空文字にします。
   * その結果 `new Array(1)` の原像は `"[]"` になり、**空配列と同じ要約**になっていました
   * （実測で hash 一致）。設定を替えた再 claim が「処理済み」で拒まれます。
   *
   * 穴は凍結規則のどの行にも無い形なので、配列要素の `undefined` と同じく落とします。
   */
  it("疎配列の穴は例外。空配列と同じ要約になっていた", () => {
    // 穴1個。**これが `[]` と同じ要約になっていた**
    assert.throws(() => canonicalConfigHash(new Array(1)), /sparse array/);
    // 穴2個
    assert.throws(() => canonicalConfigHash(new Array(2)), /sparse array/);
    // 途中に穴
    assert.throws(() => canonicalConfigHash([1, , 2]), /sparse array/);
    // 末尾に穴
    assert.throws(() => canonicalConfigHash([1, 2, , ]), /sparse array/);
    // 入れ子の中の穴
    assert.throws(() => canonicalConfigHash({ a: new Array(1) }), /sparse array/);
    assert.throws(() => canonicalConfigHash([[1, , 2]]), /sparse array/);
  });

  it("穴の位置が例外メッセージに出る（どこが穴かを黙らせない）", () => {
    assert.throws(() => canonicalConfigHash([1, , 2]), /\$\[1\]/);
    assert.throws(() => canonicalConfigHash({ a: [0, , 0] }), /\$\.a\[1\]/);
  });

  it("空配列は通る。穴を「要素が無い」と混同しない", () => {
    assert.equal(canonicalConfigPreimage([]), "[]");
    assert.equal(canonicalConfigPreimage({ a: [] }), '{"a":[]}');
  });

  it("穴と、要素としての undefined は別のメッセージで落ちる", () => {
    // どちらも落ちるが、理由は区別する。`[undefined]` は書いた人が値を置いている
    assert.throws(() => canonicalConfigHash([undefined]), /undefined/);
    assert.throws(() => canonicalConfigHash(new Array(1)), /sparse array/);
  });

  it("穴を削ったり null に置き換えたりしない", () => {
    // 黙って畳むと、`[1, , 2]` と `[1, 2]` / `[1, null, 2]` が同じ要約になる。
    // 例外にするのは、**どちらに寄せても嘘になる**から
    assert.notEqual(canonicalConfigPreimage([1, 2]), canonicalConfigPreimage([1, null, 2]));
    assert.throws(() => canonicalConfigHash([1, , 2]), /sparse array/);
  });

  it("穴を落としても、受理される値の原像は1つも変わらない", () => {
    // pipelineVersion を動かさない根拠。表の行はすべて穴を持たないので、
    // map は全要素を訪れており、追加した検査は結果に触れていない
    for (const v of CONFIG_HASH_VECTORS) {
      assert.equal(canonicalConfigPreimage(v.config), v.preimage);
    }
    assert.equal(canonicalConfigPreimage([[], [1]]), "[[],[1]]");
    assert.equal(canonicalConfigPreimage([]), "[]");
  });
});

describe("normalizeStableKey (#6, #23)", () => {
  it("末尾スラッシュの有無で結果が変わらない（#6）", () => {
    assert.equal(normalizeStableKey("/mnt/nas/", policy()), "mnt/nas");
    assert.equal(normalizeStableKey("/mnt/nas", policy()), "mnt/nas");
    assert.equal(normalizeStableKey("mnt/nas", policy()), "mnt/nas");
  });

  it("documentId が末尾スラッシュで揺れない（#6）", () => {
    const src = "src1" as SourceId;
    assert.equal(
      documentId(src, "/mnt/nas/a.txt", policy()),
      documentId(src, "mnt/nas/a.txt", policy()),
    );
  });

  it("NFD と NFC が同じ鍵に潰れる（#23）", () => {
    const nfd = "café.txt".normalize("NFD");
    const nfc = "café.txt".normalize("NFC");
    assert.notEqual(nfd, nfc);
    assert.equal(normalizeStableKey(nfd, policy()), normalizeStableKey(nfc, policy()));
  });

  it("caseFold が false なら大文字小文字を区別する", () => {
    assert.notEqual(normalizeStableKey("a.txt", policy()), normalizeStableKey("A.TXT", policy()));
  });

  it("caseFold が true なら畳む（#23）", () => {
    const p = policy({ caseFold: true });
    assert.equal(normalizeStableKey("a.txt", p), normalizeStableKey("A.TXT", p));
  });

  it("畳んだ後にもう一度正規化する（畳み込みが正規化形を崩すため）", () => {
    const p = policy({ caseFold: true, unicodeForm: "NFC" });
    const out = normalizeStableKey("CAFÉ.TXT".normalize("NFD"), p);
    assert.equal(out, out.normalize("NFC"));
    assert.equal(out, "café.txt");
  });

  it("pathSeparator=posix は逆スラッシュを畳む", () => {
    assert.equal(normalizeStableKey("a\\b\\c.txt", policy()), "a/b/c.txt");
  });

  it("unicodeForm=none は正規化しない", () => {
    const nfd = "café.txt".normalize("NFD");
    assert.equal(normalizeStableKey(nfd, policy({ unicodeForm: "none" })), nfd);
  });
});

describe("outputsHash", () => {
  const A = [
    { artifactId: "a", ordinal: 0, contentHash: "bc" },
    { artifactId: "d", ordinal: 1, contentHash: "e" },
  ];
  const B = [
    { artifactId: "a", ordinal: 0, contentHash: "b" },
    { artifactId: "cd", ordinal: 1, contentHash: "e" },
  ];

  it("空配列 = sha256(\"out:\")。v0.1 で実際に走る唯一の枝", () => {
    assert.equal(outputsHashPreimage([]), "out:");
    assert.equal(outputsHash([]), OUTPUTS_HASH_VECTORS.empty);
  });

  it("固定値ベクタ A", () => {
    assert.equal(outputsHashPreimage(A), `out:a:bc${NUL}d:e`);
    assert.equal(outputsHash(A), OUTPUTS_HASH_VECTORS.pairA);
  });

  it("固定値ベクタ B", () => {
    assert.equal(outputsHashPreimage(B), `out:a:b${NUL}cd:e`);
    assert.equal(outputsHash(B), OUTPUTS_HASH_VECTORS.pairB);
  });

  it("区切りが無いと A と B が潰れる（区切り欠落の回帰検出）", () => {
    // 区切りを消したときに何が起きるかを、実装ではなくテスト側で再現する
    const withoutSep = (xs: typeof A) => `out:${xs.map((x) => `${x.artifactId}:${x.contentHash}`).join("")}`;
    assert.equal(withoutSep(A), withoutSep(B));
    // 区切りがあるので実装では潰れない
    assert.notEqual(outputsHash(A), outputsHash(B));
  });

  it("ordinal 順に並べ替えてから計算する", () => {
    assert.equal(outputsHash([...A].reverse()), outputsHash(A));
  });

  it("ordinal に欠番があれば計算せず例外", () => {
    assert.throws(
      () => outputsHash([{ artifactId: "a", ordinal: 0, contentHash: "b" }, { artifactId: "c", ordinal: 2, contentHash: "d" }]),
      /ordinals must be 0\.\.n-1/,
    );
  });

  it("ordinal が 0 始まりでなければ例外", () => {
    assert.throws(
      () => outputsHash([{ artifactId: "a", ordinal: 1, contentHash: "b" }]),
      /ordinals must be 0\.\.n-1/,
    );
  });

  it("ordinal が重複していれば例外", () => {
    assert.throws(
      () => outputsHash([{ artifactId: "a", ordinal: 0, contentHash: "b" }, { artifactId: "c", ordinal: 0, contentHash: "d" }]),
      /ordinals must be 0\.\.n-1/,
    );
  });

  it("大文字の hex は例外（表記揺れで別ハッシュになるのを防ぐ）", () => {
    assert.throws(
      () => outputsHash([{ artifactId: "AB", ordinal: 0, contentHash: "cd" }]),
      /lowercase hex/,
    );
  });
});

describe("artifactId", () => {
  const key = "der1" as DerivationKey;

  it("固定値", () => {
    assert.equal(artifactIdPreimage(key, 0), "art:4:der11:0");
    assert.equal(artifactId(key, 0), "e38aac571b7a0e0f8712453cdbd32d3f8af9ad57c4dfc9f18b4dd4724f945a40");
    assert.equal(artifactId(key, 1), "4aa1d1429d8eb4143b4443e1502d85b2345cb09233fcaaf990599a68fadf85e3");
    assert.equal(artifactId(key, 10), "4c4b65292beb682acbe81b9ec5f888c3a56879ca71c74074075ebee9b9409551");
  });

  it("ゼロ埋めしない（10進表記を凍結）", () => {
    assert.equal(artifactIdPreimage(key, 10), "art:4:der12:10");
    assert.notEqual(artifactId(key, 1), artifactId(key, 10));
  });

  it("負数と小数は例外", () => {
    assert.throws(() => artifactId(key, -1), /non-negative safe integer/);
    assert.throws(() => artifactId(key, 1.5), /non-negative safe integer/);
  });
});

describe("blobKeyOf", () => {
  const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" as ContentHash;

  it("鍵は内容ハッシュそのもの（文字列として同一）", () => {
    // ここが「対」になっていないことの固定です。別の文字列にすると、
    // 鍵から内容ハッシュを導出できるのに両方を持ち回る形になります
    assert.equal(String(blobKeyOf(hash)), String(hash));
  });

  it("接頭辞を持たない（置き場所は鍵の一部ではない）", () => {
    // 以前フィクスチャは `blob/${contentHash}` を鍵にしていました。
    // それだと置き場所を変えるたびに既存の鍵が意味を変えます
    assert.match(String(blobKeyOf(hash)), /^[0-9a-f]+$/);
  });

  it("小文字16進でなければ例外（鍵はそのままファイル名の材料になる）", () => {
    assert.throws(() => blobKeyOf("AB" as ContentHash), /lowercase hex/);
    assert.throws(() => blobKeyOf("../etc/passwd" as ContentHash), /lowercase hex/);
    assert.throws(() => blobKeyOf("" as ContentHash), /lowercase hex/);
  });

  it("読み切った証拠からも作れる（証拠型は ContentHash の部分型）", () => {
    // put が返すのは VerifiedContentHash です。ここが通らないと、
    // 本物の経路から鍵を作れず __unsafeBlobKey に戻ることになります
    assert.equal(String(blobKeyOf(attestContentHash(new Uint8Array()))), String(hash));
  });
});

describe("derivationKey", () => {
  const base = { processorName: "echo", processorVersion: "1", configHash: "c" };

  /**
   * 入力 ID は**実導出したもの**を使います。
   *
   * `["v1", "v2"] as never` と書けば読みやすいのですが、それは
   * 「並び順は結果に影響しない」を**実際には現れない形の値**で確かめることになります。
   * ソートは UTF-8 バイト列の昇順なので、64桁16進で確かめるほうが本番に近い。
   */
  const src = "src1" as SourceId;
  const doc = documentId(src, "a.txt", policy());
  const V1 = versionId(doc, attestContentHash(Buffer.from("one", "utf8")));
  const V2 = versionId(doc, attestContentHash(Buffer.from("two", "utf8")));

  it("入力の並び順は結果に影響しない", () => {
    assert.equal(
      derivationKey({ ...base, inputIds: [V2, V1] }),
      derivationKey({ ...base, inputIds: [V1, V2] }),
    );
  });

  it("重複した入力は例外（黙って畳むと別の入力集合が同じ鍵になる）", () => {
    assert.throws(
      () => derivationKey({ ...base, inputIds: [V1, V1] }),
      /duplicate inputId/,
    );
  });

  it("processorVersion が変われば別の鍵になる（AGENTS.md 3.3）", () => {
    const a = derivationKey({ ...base, processorVersion: "1", inputIds: [V1] });
    const b = derivationKey({ ...base, processorVersion: "2", inputIds: [V1] });
    assert.notEqual(a, b);
  });

  it("configHash が変われば別の鍵になる", () => {
    const a = derivationKey({ ...base, configHash: "c1", inputIds: [V1] });
    const b = derivationKey({ ...base, configHash: "c2", inputIds: [V1] });
    assert.notEqual(a, b);
  });

  it("区切りで場が分かれている（連結の曖昧さがない）", () => {
    const a = derivationKeyPreimage({ processorName: "ab", processorVersion: "c", configHash: "x", inputIds: [] });
    const b = derivationKeyPreimage({ processorName: "a", processorVersion: "bc", configHash: "x", inputIds: [] });
    assert.notEqual(a, b);
  });
});

/**
 * 原像の場の境界。**区切り文字連結では、区切り文字を含む値が境界を動かせました。**
 *
 * `sourceId="a"+NUL+"b"` / `stableKey="c"` と `sourceId="a"` / `stableKey="b"+NUL+"c"` は、
 * NUL 連結だとどちらも `doc:a`+NUL+`b`+NUL+`c` になり、**別の文書が同じ documentId** を持ちます。
 * 長さ前置なら `1:a` と `3:a`+NUL+`b` で長さが違うので、境界は値に左右されません。
 *
 * `SourceId` / `processorName` / `configHash` はいずれも `Brand<string>` で
 * 文字クラスの制約が無く、鋳造関数も無いため、NUL を含む値を型では止められません。
 * 止めているのは符号化です。
 */
describe("原像の場の境界（長さ前置）", () => {
  const NUL_IN = (a: string, b: string): [string, string] => [a, b];

  it("sourceId と stableKey の境界は動かない", () => {
    const [s1, k1] = NUL_IN(`a${NUL}b`, "c");
    const [s2, k2] = NUL_IN("a", `b${NUL}c`);
    assert.notEqual(
      documentIdPreimage(s1 as SourceId, k1, policy()),
      documentIdPreimage(s2 as SourceId, k2, policy()),
    );
    assert.notEqual(
      documentId(s1 as SourceId, k1, policy()),
      documentId(s2 as SourceId, k2, policy()),
    );
  });

  it("processorName と processorVersion の境界は動かない", () => {
    const base = { configHash: "x", inputIds: [] };
    const a = { ...base, processorName: `a${NUL}b`, processorVersion: "c" };
    const b = { ...base, processorName: "a", processorVersion: `b${NUL}c` };
    assert.notEqual(derivationKeyPreimage(a), derivationKeyPreimage(b));
    assert.notEqual(derivationKey(a), derivationKey(b));
  });

  it("configHash と先頭 inputId の境界は動かない", () => {
    const base = { processorName: "p", processorVersion: "1" };
    const a = { ...base, configHash: `a${NUL}b`, inputIds: ["c" as VersionId] };
    const b = { ...base, configHash: "a", inputIds: [`b${NUL}c` as VersionId] };
    assert.notEqual(derivationKeyPreimage(a), derivationKeyPreimage(b));
    assert.notEqual(derivationKey(a), derivationKey(b));
  });
});

describe("versionId", () => {
  it("documentId と contentHash から決まる", () => {
    const doc = "d1" as DocumentId;
    assert.equal(versionId(doc, "ab" as ContentHash), versionId(doc, "ab" as ContentHash));
    assert.notEqual(versionId(doc, "ab" as ContentHash), versionId(doc, "ac" as ContentHash));
  });

  it("contentHash が小文字 hex でなければ例外", () => {
    assert.throws(() => versionId("d1" as DocumentId, "AB" as ContentHash), /lowercase hex/);
  });
});
