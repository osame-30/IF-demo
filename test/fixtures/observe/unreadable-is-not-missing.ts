/**
 * 攻撃 #17 — 読めなかったファイルが、消えたことにされる。
 *
 * 元の穴: `chmod 000` されたファイルは**列挙はできるが読めません**。
 * 「観測したが version 化しない」を表す型が無かったため、実装者に選べたのは
 * 「例外を投げて走査を止める」か「見えなかったことにする」の二択でした。
 * 後者を選ぶと `last_seen` が更新されず、次の削除判定で tombstone されます。
 * **権限が一時的に外れただけで、実在するファイルが消えます。**
 *
 * 防御: `IngestOutcome` の `unreadable` の枝。この枝を記録する経路が
 * `last_seen` を更新する経路と同一なので、
 * 「読めなかった → 欠損」というコードが書けません。
 *
 * ここで一緒に確かめているのは、**その逆に倒れていないこと**です。
 * 「読めなかったものを欠損にしない」が「何も欠損にしない」になっていたら、
 * 削除検知そのものが死にます。本当に消えたファイルは今も欠損として出ます。
 *
 * ## 実 FS での再現について
 *
 * `chmod 000` による再現は STEP 3 の local-fs アダプタの担当です。
 * ここでストアに渡しているのは、アダプタが「読めなかった」と判断した後の
 * `IngestOutcome` です。FS 側の再現には2つの落とし穴があり、どちらも
 * このフィクスチャでは触れません（`test/support/fs-scenario.ts` の
 * `detectFsCapabilities` が実測で報告します）:
 *
 *   - CI が root で走ると `chmod 000` が効かず、#17 が素通りする（AGENTS.md 5節）
 *   - Windows の開発機では POSIX 権限が再現できない
 *
 * ストア側の契約はどちらの環境でも同じなので、ここで固定します。
 */

import assert from "node:assert/strict";

import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import type { InvariantName, SourceId } from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = ["DELETION_ONLY_FROM_COMPLETED_SCAN"];

const SRC = "acl-shifting-share" as SourceId;
/** 弁の分母。18件あれば1件の欠損は閾値内に収まる */
const ORDINARY = Array.from({ length: 18 }, (_, i) => `f${i}.txt`);
const SECRET = "secret.txt";
const DELETED = "really-deleted.txt";
const body = (name: string): string => `contents of ${name}`;

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC);

  // 基準走査。secret.txt もこの時点では読めていた
  const base = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of [...ORDINARY, SECRET, DELETED]) {
    await ctx.ingest(base.scanId, name, body(name));
  }
  await ctx.store.finishScan(base.scanId, {
    enumeratedCount: 20,
    distinctCount: 20,
    writeFailureCount: 0,
  });
  assert.equal(ctx.count("document WHERE state='active'"), 20);
}

export async function execute(ctx: FixtureContext): Promise<void> {
  ctx.clock.advance(1000);
  const versionsBefore = ctx.count("document_version");

  // --- 攻撃: secret.txt の読み取り権限が外れ、really-deleted.txt は本当に消えた ---
  const scan = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of ORDINARY) await ctx.ingest(scan.scanId, name, body(name));

  const secretId = await ctx.observeOnly(scan.scanId, SECRET, {
    kind: "unreadable",
    errorKind: "EACCES",
  });

  const finished = await ctx.store.finishScan(scan.scanId, {
    enumeratedCount: 19,
    distinctCount: 19,
    writeFailureCount: 0,
  });
  assert.equal(finished.status, "completed", "1件の欠損は閾値内。弁は鳴らない");

  // --- 読めなかったことは記録され、版は作られない ---
  assert.deepEqual(ctx.observationDetails("document_unreadable"), [{ errorKind: "EACCES" }]);
  assert.equal(ctx.count("document_version"), versionsBefore, "読めていない以上、版は作れない");
  assert.equal(
    ctx.one<{ state: string }>("SELECT state FROM document WHERE document_id=?", secretId)!.state,
    "active",
    "読めなかったことは tombstone の理由にならない",
  );

  // --- 欠損集合に入っているのは、本当に消えたほうだけ ---
  const promoted = await ctx.store.promoteToCompleted(scan.scanId);
  assert.ok(promoted);

  const missing: string[] = [];
  for await (const doc of ctx.store.findMissingSince(promoted)) missing.push(doc.stableKey);
  assert.deepEqual(
    missing,
    [DELETED],
    "読めなかったものを欠損にしない、が『何も欠損にしない』になっていない",
  );

  // --- 権限が戻れば、そのまま版になる ---
  ctx.clock.advance(1000);
  const recovered = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  for (const name of ORDINARY) await ctx.ingest(recovered.scanId, name, body(name));
  // 権限が外れている間に内容も変わっていた。新しい版になるはず
  const restored = await ctx.ingest(recovered.scanId, SECRET, "contents after the acl was restored");

  assert.equal(restored.documentId, secretId, "同じ document に戻る。別物として作り直さない");
  assert.equal(ctx.count("document_version"), versionsBefore + 1, "読めるようになれば版になる");
  assert.equal(
    ctx.one<{ active_version_id: string | null }>(
      "SELECT active_version_id FROM document WHERE document_id=?",
      secretId,
    )!.active_version_id,
    restored.versionId,
  );
  assert.equal(ctx.observationCount("document_tombstoned"), 0);
}
