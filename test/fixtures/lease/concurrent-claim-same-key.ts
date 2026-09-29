/**
 * 攻撃 #12 — 同じ derivationKey を2人のワーカーが同時に掴む。
 *
 * 元の穴: リースの取得が「読んでから書く」2文で書かれていた。
 * 2つのワーカーが同時に「誰も持っていない」を読み、両方が書き込んだ。
 * 同じ入力が2回処理され、Artifact が二重に書かれた。
 *
 * 防御は2層あり、**守っている範囲が違います。**
 *
 *   1. `BEGIN IMMEDIATE` — 同一プロセス内の直列化。読みと書きの間に
 *      他の書き手が割り込めない。
 *   2. `idx_one_leased_run` — 部分ユニークインデックス。プロセスを跨いでも効く。
 *
 * 1層目だけでは足りません。別プロセス（別マシン）のワーカーは同じ
 * トランザクションに入らないので、直列化の外側から書き込めます。
 * 2層目だけでも足りません。制約違反は例外として返るので、
 * 「競合したから再試行すべき」なのか「既に誰かが持っている」なのかを
 * 呼び出し側が区別できません。
 *
 * だから `claimRun` は**例外の型ではなく DB の状態で判断します。**
 * `SQLITE_BUSY` は「既にリースされている」ではなく「競合している」です。
 * 前者なら `null`、後者なら再試行が正解なので、混ぜると
 * 「一時的な競合で永久に諦める」か「取れているのに再試行し続ける」になります。
 *
 * `node:sqlite` は同期 API なので、1プロセス内で本当の同時実行は起こせません。
 * ここでは (a) 逐次の2回目が `null` になること、(b) 直列化を迂回して
 * 直接 INSERT しても DB が拒むこと、の両方を確かめます。
 * (b) がプロセス跨ぎの防御の実測です。
 */

import assert from "node:assert/strict";

import { derivationKey as deriveDerivationKey } from "../../../src/domain/ids.ts";
import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import { diffSnapshots, isEmptyDiff } from "../../support/state-snapshot.ts";
import type {
  DerivationDraft,
  DocumentId,
  InvariantName,
  SourceId,
  VersionId,
  WorkerId,
} from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = ["IDEMPOTENT_REPLAY"];

const SRC = "lease-lab" as SourceId;
const KEY = "input.txt";
const W1 = "worker-1" as WorkerId;
const W2 = "worker-2" as WorkerId;

let documentId: DocumentId;
let rootVersionId: VersionId;

/** EchoProcessor 相当。v0.1 に Parser は無いので Artifact は0件 */
function draft(): DerivationDraft {
  return {
    processorName: "echo",
    processorVersion: "1",
    configHash: "cfg",
    inputIds: [rootVersionId],
  };
}

/** claimRun には鍵ではなく材料を渡す。導出はストアの中で1回だけ起きる */
function materials() {
  return {
    processorName: "echo",
    processorVersion: "1",
    configHash: "cfg",
    inputIds: [rootVersionId],
  };
}

/** ストアが導出するはずの鍵。生 SQL で行を突き合わせるときだけ使う */
function key(): ReturnType<typeof deriveDerivationKey> {
  return deriveDerivationKey(materials());
}

export async function setup(ctx: FixtureContext): Promise<void> {
  ctx.addSource(SRC);
  const scan = await ctx.store.beginScan(SRC, DEFAULT_THRESHOLDS);
  const ingested = await ctx.ingest(scan.scanId, KEY, "the only input");
  await ctx.store.finishScan(scan.scanId, {
    enumeratedCount: 1,
    distinctCount: 1,
    writeFailureCount: 0,
  });
  documentId = ingested.documentId;
  rootVersionId = ingested.versionId;
}

export async function execute(ctx: FixtureContext): Promise<void> {
  const claim = { ...materials(), rootVersionId, leaseSeconds: 60 };

  // --- 1層目: 直列化された2回目は null になる ---
  const first = await ctx.store.claimRun({ ...claim, workerId: W1 });
  assert.ok(first, "誰も持っていない鍵は取れる");
  assert.equal(first.status, "leased");
  assert.equal(first.attempt, 1);

  const second = await ctx.store.claimRun({ ...claim, workerId: W2 });
  assert.equal(second, null, "既に誰かが持っている鍵は取れない。例外ではなく null");

  assert.equal(
    ctx.count("processing_run WHERE derivation_key=? AND status='leased'", key()),
    1,
    "leased な run は同時に1件",
  );

  // --- 2層目: 直列化を迂回しても DB が拒む（プロセス跨ぎの防御） ---
  // 別プロセスのワーカーは同じトランザクションに入らない。
  // BEGIN IMMEDIATE だけが防御なら、この INSERT は通ってしまう
  assert.throws(
    () =>
      ctx.conn.db
        .prepare(
          `INSERT INTO processing_run
             (run_id, derivation_key, document_id, root_version_id, status, attempt,
              worker_id, started_at, heartbeat_at, lease_expires_at, lease_seconds)
           VALUES ('smuggled', ?, ?, ?, 'leased', 2, ?, ?, ?, ?, 60)`,
        )
        .run(
          key(),
          documentId,
          rootVersionId,
          W2,
          ctx.clock.now(),
          ctx.clock.now(),
          ctx.clock.now() + 60_000,
        ),
    "idx_one_leased_run が無ければ、この行が2つ目のリースとして通る",
  );
  assert.equal(ctx.count("processing_run WHERE run_id='smuggled'"), 0);

  // --- 仕事を終えると、その鍵はもう誰も掴めない ---
  const committed = await ctx.store.commitDerivation({
    derivation: draft(),
    artifacts: [],
    runId: first.runId,
    workerId: W1,
  });
  assert.equal(committed.created, true);
  assert.equal(committed.derivationKey, key(), "claim した鍵とストアが導出した鍵が一致する");
  assert.equal(
    ctx.one<{ status: string }>(
      "SELECT status FROM processing_run WHERE run_id=?",
      first.runId,
    )!.status,
    "succeeded",
  );

  // --- 再実行: 成功済みの鍵を掴み直しても、状態は1ビットも変わらない ---
  const before = await ctx.snapshot();

  const retryA = await ctx.store.claimRun({ ...claim, workerId: W2 });
  const retryB = await ctx.store.claimRun({ ...claim, workerId: W1 });
  assert.equal(retryA, null, "成功済みの派生は取り直せない");
  assert.equal(retryB, null);

  const after = await ctx.snapshot();
  assert.ok(isEmptyDiff(diffSnapshots(before, after)), "掴み直しは何も書かない");
  ctx.declareReplay(before, after);

  assert.equal(ctx.count("derivation"), 1, "同じ入力が2回処理されていない");
  assert.equal(ctx.observationCount("derivation_output_divergence"), 0);
}
