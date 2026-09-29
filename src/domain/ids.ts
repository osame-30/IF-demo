/**
 * ID 導出と正規化。**すべて純関数。I/O を持たない。**
 *
 * ここが揺れると全 ID が揺れ、他のすべてのテストが意味を失います
 * （AGENTS.md 5節「実装順序」の最優先項目）。
 *
 * 値と事象の区別:
 *   値の ID   = 入力から導出する。同じ入力なら必ず同じ ID
 *               documentId / versionId / derivationKey / artifactId
 *   事象の ID = 起きた回数だけ存在する。ストアが採番する
 *               scanId / runId / observationId
 *   事象の ID はこのファイルに存在しません。比較や整列にも使いません。
 *
 * **原像は長さ前置で符号化します。区切り文字は使いません。**
 *
 * 可変長フィールドを区切り文字で連結すると、区切り文字そのものを含む値が
 * 場の境界を動かせます。sourceId="a"+NUL+"b" / stableKey="c" と
 * sourceId="a" / stableKey="b"+NUL+"c" は、NUL 連結では同じ原像になります。
 * 長さ前置なら `1:a` と `3:a`+NUL+`b` が別物なので、値に何が入っていても
 * 場の境界は動きません。
 *
 * `SEP` が残っているのは `outputsHash` だけです。あちらは要素が
 * 小文字16進に限定されており（`assertLowercaseHex`）、区切り文字が
 * 値に現れません。
 */

import { createHash } from "node:crypto";

import type {
  ArtifactId,
  BlobKey,
  ContentHash,
  DerivationInput,
  DerivationKey,
  DocumentId,
  KeyNormalizationPolicy,
  SourceId,
  VersionId,
} from "./types.ts";

/** `outputsHash` 専用の区切り。ID の導出経路では使いません（上の説明） */
const SEP = "\u0000";

function sha256(preimage: string): string {
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

// ----------------------------------------------------------------------------
// 原像の符号化 — 長さ前置
// ----------------------------------------------------------------------------

/**
 * 可変長フィールド1つ。`<UTF-8バイト長の10進>":"<フィールド>`。
 *
 * 長さは**文字数ではなくバイト数**です。原像は UTF-8 でハッシュされるので、
 * 文字数だと非ASCII で長さと実体がずれます。
 */
function field(value: string): string {
  return `${String(Buffer.byteLength(value, "utf8"))}:${value}`;
}

/**
 * 可変長フィールドの配列。要素数を10進で前置し、続けて各要素を長さ前置で連結する。
 *
 * 要素数を前置しないと、配列と後続の場の境界が消えます
 * （空配列と「次の場が無い」が同じ原像になる）。
 */
function fieldList(values: ReadonlyArray<string>): string {
  return `${String(values.length)}:${values.map(field).join("")}`;
}

/**
 * 原像を組み立てる。**ID の導出はすべてここを通します。**
 *
 * `tag` は固定リテラル（"doc:" / "ver:" / "der:" / "art:"）なので長さ前置しません。
 * 可変長でないものに長さを付けても境界は動かず、読みにくくなるだけです。
 */
function preimageOf(tag: string, parts: ReadonlyArray<string>): string {
  return tag + parts.join("");
}

/** UTF-8 バイト列の昇順。UTF-16 のコード単位順とは補助面で食い違うため明示する */
function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function assertLowercaseHex(value: string, label: string): void {
  if (!/^[0-9a-f]+$/.test(value)) {
    throw new TypeError(`${label} must be lowercase hex, got ${JSON.stringify(value)}`);
  }
}

// ----------------------------------------------------------------------------
// stableKey の正規化
// ----------------------------------------------------------------------------

/**
 * 接続元の stableKey を正規化する。
 *
 * 攻撃 #6: 設定が /mnt/nas から /mnt/nas/ に変わっただけで全 documentId が変わった。
 * 攻撃 #23: macOS の NFD と他ツールの NFC で同一物理ファイルに2つの document ができた。
 *
 * 畳み込みは「正規化 → 大文字小文字畳み → もう一度正規化」の順で行います。
 * 畳み込みが正規化形を崩すことがあるためです（canonical caseless matching）。
 */
export function normalizeStableKey(key: string, policy: KeyNormalizationPolicy): string {
  let out = key;

  if (policy.pathSeparator === "posix") out = out.replace(/\\/g, "/");
  if (policy.trimSlashes) out = out.replace(/^\/+/, "").replace(/\/+$/, "");
  if (policy.unicodeForm !== "none") out = out.normalize(policy.unicodeForm);

  if (policy.caseFold) {
    // toLocaleLowerCase ではなく toLowerCase。ロケールで結果が変わってはいけない
    out = out.toLowerCase();
    if (policy.unicodeForm !== "none") out = out.normalize(policy.unicodeForm);
  }

  return out;
}

// ----------------------------------------------------------------------------
// 値の ID
// ----------------------------------------------------------------------------

export function documentIdPreimage(
  sourceId: SourceId,
  stableKey: string,
  policy: KeyNormalizationPolicy,
): string {
  return preimageOf("doc:", [field(sourceId), field(normalizeStableKey(stableKey, policy))]);
}

export function documentId(
  sourceId: SourceId,
  stableKey: string,
  policy: KeyNormalizationPolicy,
): DocumentId {
  return sha256(documentIdPreimage(sourceId, stableKey, policy)) as DocumentId;
}

export function versionIdPreimage(document: DocumentId, contentHash: ContentHash): string {
  return preimageOf("ver:", [field(document), field(contentHash)]);
}

export function versionId(document: DocumentId, contentHash: ContentHash): VersionId {
  assertLowercaseHex(contentHash, "contentHash");
  return sha256(versionIdPreimage(document, contentHash)) as VersionId;
}

export function derivationKeyPreimage(input: DerivationInput): string {
  const sorted = [...input.inputIds].map(String).sort(compareUtf8);

  // 同じ入力を2回渡すのは呼び出し側の誤り。黙って畳むと別の入力集合が同じ鍵になる
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === sorted[i - 1]) {
      throw new TypeError(`duplicate inputId in derivation input: ${sorted[i]}`);
    }
  }

  return preimageOf("der:", [
    field(input.processorName),
    field(input.processorVersion),
    field(input.configHash),
    fieldList(sorted),
  ]);
}

export function derivationKey(input: DerivationInput): DerivationKey {
  return sha256(derivationKeyPreimage(input)) as DerivationKey;
}

export function artifactIdPreimage(key: DerivationKey, ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new TypeError(`ordinal must be a non-negative safe integer, got ${ordinal}`);
  }
  // 10進、ゼロ埋めなし。ゼロ埋めの有無は後から変えられないのでここで凍結する
  return preimageOf("art:", [field(key), field(String(ordinal))]);
}

export function artifactId(key: DerivationKey, ordinal: number): ArtifactId {
  return sha256(artifactIdPreimage(key, ordinal)) as ArtifactId;
}

// ----------------------------------------------------------------------------
// blobKey
// ----------------------------------------------------------------------------

/**
 * blob の鍵。**内容ハッシュそのものです。**
 *
 * `BlobKey` と `ContentHash` は別のブランドですが、運ぶ文字列は同じです。
 * 別の文字列にすると「鍵から内容ハッシュを導出できるのに、両方を持ち回る」
 * 対ができます（AGENTS.md 9節 軸0）。突き合わせる文が書けない対は作りません。
 *
 * **ディスク上の配置はここに現れません。** 置き場所の分割は BlobStore の
 * 実装詳細であって、鍵の一部ではありません。鍵に `blob/` のような接頭辞を
 * 持たせると鍵とパスが同じ値になり、置き場所を変えるたびに既存の鍵が
 * 意味を変えます。
 *
 * **小文字16進を要求します。** 鍵はそのままファイル名の材料になるので、
 * `..` や区切り文字が入る余地を残せません。検査をここに置くのは、
 * BlobStore が受け取るより前に落とすためです。
 */
export function blobKeyOf(contentHash: ContentHash): BlobKey {
  assertLowercaseHex(String(contentHash), "contentHash");
  return String(contentHash) as BlobKey;
}

// ----------------------------------------------------------------------------
// outputsHash
// ----------------------------------------------------------------------------

export interface ArtifactDigest {
  readonly artifactId: ArtifactId | string;
  readonly ordinal: number;
  readonly contentHash: ContentHash | string;
}

/**
 * Derivation の出力の指紋。
 *
 * 再実行でこの値が変われば決定性が壊れたということ。握りつぶさず失敗にします。
 *
 * ハッシュを計算する前に事前条件を確かめます。順序不正のまま黙って計算すると、
 * DERIVATION_OUTPUT_STABLE が「不正な状態同士が一致した」ことを緑で報告します。
 *
 * v0.1 は Artifact 0件が唯一の経路（KNOWN_LIMITATIONS 2節）なので、
 * 実運用で最初に走るのは空配列の枝＝sha256("out:") です。
 */
export function outputsHashPreimage(artifacts: ReadonlyArray<ArtifactDigest>): string {
  const sorted = [...artifacts].sort((a, b) => a.ordinal - b.ordinal);

  for (let i = 0; i < sorted.length; i += 1) {
    const entry = sorted[i]!;
    if (entry.ordinal !== i) {
      throw new TypeError(
        `artifact ordinals must be 0..n-1 with no gaps or duplicates; ` +
          `expected ${i} at position ${i} but found ${entry.ordinal}`,
      );
    }
    assertLowercaseHex(String(entry.artifactId), `artifacts[${i}].artifactId`);
    assertLowercaseHex(String(entry.contentHash), `artifacts[${i}].contentHash`);
  }

  return `out:${sorted.map((a) => `${a.artifactId}:${a.contentHash}`).join(SEP)}`;
}

export function outputsHash(artifacts: ReadonlyArray<ArtifactDigest>): string {
  return sha256(outputsHashPreimage(artifacts));
}

// ----------------------------------------------------------------------------
// canonicalConfigHash
// ----------------------------------------------------------------------------

/**
 * 設定オブジェクトの正規化ハッシュ。
 *
 * 攻撃 #22: キー順ソートはしていても、undefined とキー欠落、Unicode エスケープ、
 *          浮動小数の表現が環境で違い、同じ設定から違う derivationKey が出た。
 *
 * 規則（types.ts で凍結。変更は pipelineVersion の更新を伴う）:
 *   - キーは UTF-8 バイト列の昇順
 *   - undefined のキーは存在しないものとして扱う（null とは区別する）
 *   - 数値は整数のみ。浮動小数は例外
 *   - 文字列は NFC 正規化。非ASCII はエスケープせず生の UTF-8
 *   - 配列の順序は意味を持つ（ソートしない）
 *   - 疎配列の穴は例外。`undefined` を配列要素として拒むのと同じ扱い
 *   - 出力に空白を含めない
 *
 * 引用符と逆スラッシュの構造的エスケープは行います。
 * 「エスケープしない」は非ASCIIを \uXXXX にしないという意味であり、
 * 構造の区切りまで曖昧にすると異なる設定が同じ文字列になります。
 */
export function canonicalConfigPreimage(config: unknown): string {
  return encodeValue(config, "$");
}

export function canonicalConfigHash(config: unknown): string {
  return sha256(canonicalConfigPreimage(config));
}

function encodeValue(value: unknown, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";

    case "number": {
      if (!Number.isFinite(value)) {
        throw new TypeError(`${path}: NaN and Infinity are not permitted in config`);
      }
      if (!Number.isSafeInteger(value)) {
        // 1.0 は JS では整数 1 と区別できない。弾けるのは真に小数を持つ値だけ
        throw new TypeError(
          `${path}: only safe integers are permitted in config, got ${value}. ` +
            "Express fractional values as integers with an explicit unit.",
        );
      }
      return String(value === 0 ? 0 : value); // -0 を 0 に畳む
    }

    case "string":
      return encodeString(value);

    case "bigint":
      throw new TypeError(
        `${path}: bigint is not part of the frozen config format. ` +
          "Use a safe integer or a string.",
      );

    case "undefined":
      // オブジェクトの値としては呼び出し元が除外済み。ここに来るのは配列要素か根
      throw new TypeError(`${path}: undefined is only permitted as an absent object property`);

    default:
      break;
  }

  if (Array.isArray(value)) {
    // **穴（疎配列）を先に落とす。** `Array.prototype.map` は穴を飛ばして穴のまま
    // 返し、`join` はそれを空文字にします。つまり `new Array(1)` は `[]` と
    // 同じ原像 `"[]"` になり、**別の設定が同じ configHash を持ちます**
    // （2026-09-10 実測。`[]` と `new Array(1)` で hash 一致）。
    // 穴は凍結規則のどの行にも無い形なので、`[1, undefined, 2]` を落とすのと
    // 同じ理由で落とします。**受理される値の原像は1つも変わりません**
    // （穴の無い配列で map は全要素を訪れる）。pipelineVersion は動きません。
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) {
        throw new TypeError(
          `${path}[${String(i)}]: a hole in a sparse array is not part of the frozen config format. ` +
            "Use an explicit null.",
        );
      }
    }
    // 配列の順序は意味を持つ。ソートしない
    return `[${value.map((v, i) => encodeValue(v, `${path}[${i}]`)).join(",")}]`;
  }

  if (typeof value === "object") {
    const entries: Array<[string, unknown]> = [];
    const seen = new Map<string, string>();

    for (const [rawKey, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue; // キー欠落と同一に扱う（null とは区別する）
      const key = rawKey.normalize("NFC");
      const previous = seen.get(key);
      if (previous !== undefined) {
        throw new TypeError(
          `${path}: keys ${JSON.stringify(previous)} and ${JSON.stringify(rawKey)} ` +
            "collide after NFC normalization",
        );
      }
      seen.set(key, rawKey);
      entries.push([key, v]);
    }

    entries.sort((a, b) => compareUtf8(a[0], b[0]));
    return `{${entries.map(([k, v]) => `${encodeString(k)}:${encodeValue(v, `${path}.${k}`)}`).join(",")}}`;
  }

  throw new TypeError(`${path}: unsupported value of type ${typeof value}`);
}

/**
 * 文字列を NFC 正規化して引用する。
 * JSON.stringify は非ASCII をそのまま出し、制御文字と引用符だけを
 * 決定的にエスケープするので、凍結規則にそのまま合致します。
 */
function encodeString(value: string): string {
  return JSON.stringify(value.normalize("NFC"));
}
