/**
 * 攻撃 #6 — 設定の末尾スラッシュが1文字増えただけで、全件が入れ替わる。
 *
 * 元の穴: root が `/mnt/nas` から `/mnt/nas/` に変わると、接続元が報告する鍵が
 * `a.txt` から `/a.txt` に変わりました。正規化がスラッシュを畳まないので
 * **全 documentId が変わり、旧 document は全件 tombstone、新 document は全件新規**
 * になります。ファイルは1つも動いていないのにです。
 *
 * 直接の被害は2つあります。
 *
 *   1. **全件が再取り込みになります。** 版も artifact も作り直しで、
 *      「同じものを投げたら何も起きない」という主張が崩れます
 *   2. **全件が墓標になります。** 消えていないファイルが検索対象から外れます
 *
 * ## 何が守っているか
 *
 * `KeyNormalizationPolicy.trimSlashes`。**既定値を持たない設定です**
 * （`SourceDescriptor` に焼き付き、後から変えられません）。
 *
 * ## 生存確認を先に置いてあります
 *
 * 「`/a.txt` と `a.txt` が同じ documentId になる」だけを見ると、
 * **鍵を一切見ずに常に同じ ID を返す実装でも緑になります。**
 * だから `trimSlashes: false` の接続元を先に作り、そこでは畳まれないことを
 * 確かめます。畳んでいるのがポリシーであって偶然ではない、と言うためです。
 *
 * 順序に意味があります。生存確認は**再実行の窓の外**で行います。
 * 窓の中で document を作ると、`NO_WORK_WITHOUT_CHANGE` が
 * その行を「変更なしの再実行で書かれた行」として数えます。
 *
 * ## 再実行の窓は、攻撃の**後**に取ります
 *
 * 末尾スラッシュが増えた走査そのものを窓にすると `IDEMPOTENT_REPLAY` が落ちます。
 * **`document.stable_key` が `a.txt` から `/a.txt` に更新されるからです**（S-18、実測）。
 * これは正しい挙動です —— 列の契約が「接続元が報告した生の鍵」なので、
 * 追随しなければその文が偽になります。
 *
 * つまりこの攻撃で不変なのは**状態のバイト列ではなく `documentId` と仕事の量**です。
 * 窓はスラッシュ付きの走査を2回並べて取り、増えないことのほうを見ます。
 */

import assert from "node:assert/strict";

import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import type { InvariantName, ScanId, SourceId } from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = [
  "CANONICAL_KEY_STABILITY",
  "NO_WORK_WITHOUT_CHANGE",
];

/** 末尾スラッシュを畳む接続元。root が `/x` でも `/x/` でも同じ鍵になるべき */
const TRIMMED = "nas-trimmed" as SourceId;
/** 畳まない接続元。生存確認のためだけに置く */
const RAW = "nas-raw" as SourceId;

/** root の末尾スラッシュは、接続元が報告する鍵の先頭スラッシュとして現れる */
const WITHOUT_SLASH = ["a.txt", "sub/b.txt"];
const WITH_SLASH = ["/a.txt", "/sub/b.txt/"];

const body = (name: string): string => `contents of ${name}`;

/** keys を観測して完了させる。件数はストアが返した documentId の異なり数で数える */
async function scanOnce(
  ctx: FixtureContext,
  source: SourceId,
  keys: ReadonlyArray<string>,
): Promise<{ scanId: ScanId; documentIds: string[] }> {
  const scan = await ctx.store.beginScan(source, DEFAULT_THRESHOLDS);
  const documentIds: string[] = [];
  for (const key of keys) {
    // 内容は鍵の**正規化後の姿**で決めます。`/a.txt` と `a.txt` に別の内容を
    // 入れると、同じ documentId に2つの版が立ち、この検査が
    // 「畳まれたか」ではなく「版が増えたか」を見ることになります
    const normalized = key.split("/").filter((s) => s.length > 0).join("/");
    const result = await ctx.ingest(scan.scanId, key, body(normalized));
    documentIds.push(String(result.documentId));
  }
  const distinct = new Set(documentIds).size;
  const finished = await ctx.store.finishScan(scan.scanId, {
    enumeratedCount: keys.length,
    distinctCount: distinct,
    writeFailureCount: 0,
  });
  assert.equal(finished.status, "completed", `fixture scan aborted: ${finished.abortReason}`);
  return { scanId: scan.scanId, documentIds };
}

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(TRIMMED, { trimSlashes: true });
  ctx.addSource(RAW, { trimSlashes: false });

  const first = await scanOnce(ctx, TRIMMED, WITHOUT_SLASH);
  assert.equal(new Set(first.documentIds).size, 2, "前提: 2件が別の文書になっている");
  assert.equal(ctx.count("document WHERE source_id=?", TRIMMED), 2);
}

export async function execute(ctx: FixtureContext): Promise<void> {
  // --- 生存確認（再実行の窓の外） ---
  //
  // 畳まない接続元では、末尾スラッシュの有無が別の文書になります。
  // ここが1件になったら、畳んでいるのはポリシーではなく別の何かです
  ctx.clock.advance(1000);
  const raw = await scanOnce(ctx, RAW, ["a.txt", "/a.txt"]);
  assert.equal(
    new Set(raw.documentIds).size,
    2,
    "trimSlashes:false でも畳まれている。ポリシーが効いていない",
  );

  // --- 攻撃: root の末尾にスラッシュが1つ増える ---
  ctx.clock.advance(1000);
  const second = await scanOnce(ctx, TRIMMED, WITH_SLASH);

  // 同じ2件を指している。順序も鍵の並びどおり
  const firstIds = ctx.rows<{ document_id: string; stable_key: string }>(
    "SELECT document_id, stable_key FROM document WHERE source_id=? ORDER BY document_id",
    TRIMMED,
  );
  assert.equal(firstIds.length, 2, "末尾スラッシュだけで文書が増えている");
  assert.deepEqual(
    [...second.documentIds].sort(),
    firstIds.map((r) => r.document_id).sort(),
    "同じファイルが別の documentId になった（#6 そのもの）",
  );

  // 版も増えていない。**内容が同じなら、鍵の書き方が変わっても仕事は起きない**
  assert.equal(
    ctx.count("document_version dv JOIN document d USING(document_id) WHERE d.source_id=?", TRIMMED),
    2,
    "同じ内容なのに版が増えている",
  );

  // 墓標も立っていない
  assert.equal(ctx.observationCount("document_tombstoned"), 0);
  assert.equal(ctx.count("document WHERE source_id=? AND state='active'", TRIMMED), 2);

  // **`stable_key` は今回報告された生の鍵に更新されます**（S-18）。
  // documentId は正規化値から導くので動きません
  const keys = ctx
    .rows<{ stable_key: string }>(
      "SELECT stable_key FROM document WHERE source_id=? ORDER BY stable_key",
      TRIMMED,
    )
    .map((r) => r.stable_key);
  assert.deepEqual([...keys].sort(), [...WITH_SLASH].sort(), "報告された生の鍵に追随していない");

  // --- 再実行の窓: 同じ鍵でもう一度投げても、仕事は起きない ---
  ctx.clock.advance(1000);
  const before = await ctx.snapshot();
  const third = await scanOnce(ctx, TRIMMED, WITH_SLASH);
  const after = await ctx.snapshot();
  ctx.declareReplay(before, after);

  assert.deepEqual(
    [...third.documentIds].sort(),
    [...second.documentIds].sort(),
    "3回目で documentId が動いている",
  );
  assert.equal(
    ctx.count(
      "document_version dv JOIN document d USING(document_id) WHERE d.source_id=?",
      TRIMMED,
    ),
    2,
    "再実行で版が増えている",
  );
  assert.equal(ctx.observationCount("document_tombstoned"), 0);
}
