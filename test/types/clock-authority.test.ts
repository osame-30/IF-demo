/**
 * AC-CLK-01 / AC-CLK-02 — 時刻の権威が1つであることの機械検査。
 *
 * 規約ではなく検査にする理由は、`heartbeat(runId, workerId, now)` のような
 * 引数がレビューをすり抜けた瞬間に #14 が復活するためです。
 * 「時刻を渡す口が無い」ことは、読んで確かめるのではなく落として確かめます。
 *
 * AC-CLK-01 の判定範囲:
 *   LineageStore の各メソッドの引数を、types.ts 内で解決できる型参照を
 *   たどりながら再帰的に走査し、EpochMs に到達する経路をすべて集める。
 *   到達した経路は下の ALLOWED と完全一致でなければならない。
 *
 * ALLOWED は「時刻が入ってよい口」の全リストです。**空にはなりません。**
 * blobVerifiedAt のように「判定には使わないが証拠として持つ時刻」があるためです
 * （rule 7 は比較・判定に使う時刻の規則）。
 * 新しい経路が増えたらテストが落ち、意図的かどうかを人間が判断することになります。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import ts from "typescript";

import { indexOf, parameterPathsTo, parse } from "./type-paths.ts";

const DOMAIN = fileURLToPath(new URL("../../src/domain/types.ts", import.meta.url));

/**
 * 実時刻を読んではいけないディレクトリ。
 *
 * `src/domain` が入っているのは、契約と具象が同居していると
 * 検査を素通りして `new Date()` が store から domain へ移動するだけになるためです。
 * 読んでよいのは合成ルートの `src/runtime/system-clock.ts` だけです。
 */
const CLOCK_FREE_DIRS = ["../../src/store", "../../src/domain"].map((p) =>
  fileURLToPath(new URL(p, import.meta.url)),
);
const SYSTEM_CLOCK = fileURLToPath(new URL("../../src/runtime/system-clock.ts", import.meta.url));

/**
 * 時刻が入ってよい口の全リスト。`メソッド名: 引数からの経路`。
 *
 * STEP 2 完了時点で、残っているのは**すべて恒久的に許可される経路**です。
 * 共通するのは「判定に使わない証拠値」か「ストアが発行した token の返却」で、
 * どれも比較・順序判断には使いません。
 * rule 7「時刻の権威は1つ」は比較・判定に使う時刻の規則だからです。
 *
 * ここに行が増えたらテストが落ちます。増やすときは、その時刻が
 * 判定に使われないことを確認してからにしてください。
 */
const ALLOWED: ReadonlyArray<string> = [
  // ストアが返した token をそのまま返してもらうだけ。呼び出し側は作れない（#4）
  "findMissingSince: scan.startedAt",
  "findMissingSince: scan.finishedAt",
  "findMissingSince: scan.approvedByOperator.approvedAt",
  // tombstone も同じ CompletedScanRun を要求します（ScanId を裸で受け取る
  // 削除系 API を作らないため）。**読んでいるのは sourceId / scanId /
  // completionSeq だけで、時刻は1つも判定に使いません。**
  // 墓標を立てた時刻はストアの時計が付けます
  "tombstone: scan.startedAt",
  "tombstone: scan.finishedAt",
  "tombstone: scan.approvedByOperator.approvedAt",
  // markDeletionApplied も同じ CompletedScanRun を要求します。**同じ理由です**
  // ——削除系の口が ScanId を裸で受け取ると、門を通っていない走査の ID を
  // 渡せます。読んでいるのは sourceId / scanId / completionSeq だけで、
  // 時刻は1つも判定に使いません（completion_seq は行から引き直します）。
  // 印を付ける時刻はそもそもありません。状態だけを書きます
  "markDeletionApplied: scan.startedAt",
  "markDeletionApplied: scan.finishedAt",
  "markDeletionApplied: scan.approvedByOperator.approvedAt",
  // 恒久的に許可。どちらも「判定に使わない証拠値」で、比較や順序には使わない。
  // blobVerifiedAt は BlobStore が検証を行った事実（#8, #21）、
  // sourceModifiedAt は接続元が報告した参考値（#19）
  "insertVersionIfAbsent: version.blobVerifiedAt",
  "insertVersionIfAbsent: version.sourceModifiedAt",
];

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkFiles(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("AC-CLK-01: LineageStore に時刻を渡す口がない", () => {
  const index = indexOf(parse(DOMAIN));
  const store = index.interfaces.get("LineageStore");
  assert.ok(store, "LineageStore interface not found in types.ts");

  // 走査は AC-KEY-01 と共有。閉包の定義が2つに割れないようにする
  const found = parameterPathsTo("EpochMs", store, index);

  it("時刻が入る口は許可リストと完全一致する", () => {
    // 経路が重複するのは継承で同名プロパティが再宣言されている場合
    // （CompletedScanRun が ScanRun の finishedAt を必須に絞り直している）。
    // 同じ経路なので1本として数える
    assert.deepEqual([...new Set(found)].sort(), [...new Set(ALLOWED)].sort());
  });

  it("リース系のメソッドは時刻を1つも受け取らない（#14）", () => {
    const leaseMethods = ["claimRun", "heartbeat", "completeRun", "reapAbandonedRuns"];
    const offending = found.filter((f) => leaseMethods.some((m) => f.startsWith(`${m}:`)));
    assert.deepEqual(offending, []);
  });

  it("reapAbandonedRuns は引数を1つも取らない（AC-RUN-08）", () => {
    const member = store.members.find(
      (m) => ts.isMethodSignature(m) && m.name?.getText() === "reapAbandonedRuns",
    ) as ts.MethodSignature | undefined;
    assert.ok(member, "reapAbandonedRuns not found");
    assert.equal(member.parameters.length, 0);
  });

  it("appendObservation は observationId と occurredAt を受け取らない", () => {
    const member = store.members.find(
      (m) => ts.isMethodSignature(m) && m.name?.getText() === "appendObservation",
    ) as ts.MethodSignature | undefined;
    assert.ok(member, "appendObservation not found");
    assert.equal(member.parameters[0]?.type?.getText(), "ObservationDraft");

    const draft = index.interfaces.get("ObservationDraft");
    assert.ok(draft, "ObservationDraft not found");
    const names = draft.members.map((m) => m.name?.getText());
    assert.ok(!names.includes("occurredAt"), "ObservationDraft must not carry occurredAt");
    assert.ok(!names.includes("observationId"), "ObservationDraft must not carry observationId");
  });
});

describe("AC-CLK-02: src/store と src/domain が実時刻を直接読まない", () => {
  it("Date.now() / new Date() が現れない", () => {
    const offenders: string[] = [];
    for (const dir of CLOCK_FREE_DIRS) {
      for (const file of walkFiles(dir)) {
        const text = readFileSync(file, "utf8");
        // コメント中の言及は除く。実際の呼び出しだけを見る
        const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
        if (/\bDate\s*\.\s*now\s*\(/.test(code)) offenders.push(`${file}: Date.now()`);
        if (/\bnew\s+Date\s*\(/.test(code)) offenders.push(`${file}: new Date()`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("実時刻を読んでよいのは合成ルートの systemClock だけ", () => {
    const source = readFileSync(SYSTEM_CLOCK, "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const occurrences = code.match(/\bDate\s*\.\s*now\s*\(/g) ?? [];
    assert.equal(occurrences.length, 1, "src/runtime/system-clock.ts reads the wall clock exactly once");
  });

  it("domain の Clock は契約だけで、具象実装を持たない", () => {
    const clock = readFileSync(fileURLToPath(new URL("../../src/domain/clock.ts", import.meta.url)), "utf8");
    // 具象が同居した瞬間、AC-CLK-02 の検査範囲が意味を失う
    assert.ok(!/export\s+function\s+systemClock/.test(clock));
  });
});
