/**
 * 攻撃 #10 — 1回目の残骸と2回目の出力が和集合になる。
 *
 * 元の穴: 1回目が10個中6個の Artifact を書いたところでクラッシュした。
 * 2回目は（入力が同じでも processor の都合で）9個を生成した。
 * `insertArtifactsIfAbsent` は既存を飛ばして足すだけなので、
 * **ordinal 6〜8 は2回目のもの、ordinal 9 は1回目の残骸**という
 * 混ざった集合が「この派生の出力」として確定しました。
 * 行数を数えても10件あるので、正常に見えます。
 *
 * 防御は3つ重なっています。
 *
 *   1. 同一トランザクション。**1回目の残骸がそもそも存在しません。**
 *      これが本命で、残りの2つは1が破れたときの受け皿です。
 *   2. `UNIQUE (derivation_key, ordinal)`。同じ ordinal が2行になれない。
 *   3. `artifactCount` と実際の行数の突き合わせ。数が合わなければ
 *      invariant-checker が `artifact_count_mismatch` として報告する。
 *
 * 2と3が要るのは、1が「1つのプロセスの1つのトランザクション」しか守らないからです。
 * 別プロセスが直接 INSERT すれば1は迂回できます。
 *
 * このフィクスチャは分岐（divergence）を起こしません。
 * ロールバック後は1行も残っていないので、2回目の commit は
 * 「既存と食い違う」ではなく「まだ何も無い」から始まります。
 * 食い違いそのものは #11 が受け持ちます。
 */

import assert from "node:assert/strict";

import { artifactId as deriveArtifactId } from "../../../src/domain/ids.ts";
import { DEFAULT_THRESHOLDS, type FixtureContext } from "../context.ts";
import { EchoProcessor } from "../../support/echo-processor.ts";
import { isInjectedCrash } from "../../support/crash-injecting-store.ts";
import { diffSnapshots, isEmptyDiff } from "../../support/state-snapshot.ts";
import type {
  DocumentId,
  InvariantName,
  RunId,
  SourceId,
  VersionId,
  WorkerId,
} from "../../../src/domain/types.ts";

export const assertions: ReadonlyArray<InvariantName> = [
  "DERIVATION_OUTPUT_STABLE",
  "IDEMPOTENT_REPLAY",
  // 防御3。冒頭の散文が3層目として名指ししているのに宣言に無かった。
  // 宣言すると、この不変条件が not_checked に落ちた時点でこのフィクスチャが落ちる
  "NO_ORPHAN_ARTIFACT",
];

const SRC = "derivation-lab" as SourceId;
const KEY = "input.txt";
const WORKER = "worker-1" as WorkerId;

/** 1回目の processor。10件を生成しようとして途中で落ちる */
const firstRun = new EchoProcessor({ artifactCount: 10 });
/** 2回目の processor。件数だけが違う。**鍵は同じ**（#10 の前提） */
const secondRun = new EchoProcessor({ artifactCount: 9 });

let documentId: DocumentId;
let rootVersionId: VersionId;
let runId: RunId;

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

  assert.equal(
    firstRun.keyFor(rootVersionId),
    secondRun.keyFor(rootVersionId),
    "前提: 件数が違っても derivationKey は同じ。件数は鍵の入力ではない",
  );

  const claimed = await ctx.store.claimRun({
    ...firstRun.claimMaterialsFor(rootVersionId),
    rootVersionId,
    workerId: WORKER,
    leaseSeconds: 600,
  });
  assert.ok(claimed);
  runId = claimed.runId;
}

export async function execute(ctx: FixtureContext): Promise<void> {
  const key = firstRun.keyFor(rootVersionId);

  // --- 1回目: 10個中6個を書いたところでクラッシュ ---
  const crash = ctx.crash({
    at: "before_statement",
    matching: "INSERT INTO artifact",
    occurrence: 7,
  });
  await assert.rejects(
    () =>
      ctx.store.commitDerivation({
        derivation: firstRun.draftFor({ rootVersionId }),
        artifacts: firstRun.run(rootVersionId),
        runId,
        workerId: WORKER,
      }),
    isInjectedCrash,
  );
  assert.equal(crash.reached, 7, "6件は実際に書かれた後で落ちている");
  crash.restore();

  // 1回目の残骸がそもそも無い。これが本命の防御
  assert.equal(ctx.count("artifact"), 0, "ordinal 0〜5 の残骸が1件も残っていない");
  assert.equal(ctx.count("derivation"), 0);

  // --- 2回目: 件数が9件に変わる。和集合になるなら ordinal 9 が残るはず ---
  const committed = await ctx.store.commitDerivation({
    derivation: secondRun.draftFor({ rootVersionId }),
    artifacts: secondRun.run(rootVersionId),
    runId,
    workerId: WORKER,
  });
  assert.equal(committed.created, true);
  assert.equal(committed.derivationKey, key);

  const ordinals = ctx
    .rows<{ ordinal: number }>(
      "SELECT ordinal FROM artifact WHERE derivation_key=? ORDER BY ordinal",
      key,
    )
    .map((r) => r.ordinal);
  assert.deepEqual(
    ordinals,
    [0, 1, 2, 3, 4, 5, 6, 7, 8],
    "ordinal 9 が残っていたら、それが1回目の残骸との和集合",
  );

  // 宣言と実体が一致している。数が合わなければ invariant-checker が捕まえる
  assert.equal(
    ctx.one<{ artifact_count: number }>(
      "SELECT artifact_count FROM derivation WHERE derivation_key=?",
      key,
    )!.artifact_count,
    9,
  );

  // 内容も2回目のものだけ。1回目の内容が混ざっていない
  const first = ctx.one<{ inline_content: string }>(
    "SELECT inline_content FROM artifact WHERE derivation_key=? AND ordinal=0",
    key,
  )!;
  assert.equal(first.inline_content, secondRun.textFor(rootVersionId, 0));

  // --- 構造ガード: 同じ ordinal を後から差し込めない（プロセス跨ぎの受け皿） ---
  // トランザクションを迂回できる相手にも、この制約だけは効く
  //
  // artifact_id は**実導出値**を使います。`'leftover'` のような作り物だと、
  // 「ArtifactId の形式を満たさない行」と「和集合の種になる行」の2つを同時に
  // 作ることになり、どちらで止まったのか区別できません。
  // ordinal 9 の導出値を使うのは、1回目の残骸がまさにそれだからです
  // （1回目は10件 = ordinal 0..9、2回目は9件 = ordinal 0..8）。
  // この行が持つ欠陥は **(derivation_key, ordinal) の重複ただ1つ**です。
  assert.throws(
    () =>
      ctx.conn.db
        .prepare(
          `INSERT INTO artifact
             (artifact_id, derivation_key, ordinal, document_id, root_version_id,
              type, inline_content, blob_key, content_hash, size_bytes, created_at)
           VALUES (?, ?, 0, ?, ?, 'chunk', 'stale leftover', NULL, 'deadbeef', 14, ?)`,
        )
        .run(deriveArtifactId(key, 9), key, documentId, rootVersionId, ctx.clock.now()),
    // 制約を名指しで固定する。artifact_id の重複で落ちるようになったら
    // 「UNIQUE (derivation_key, ordinal) が効いている」の証拠にならない
    /UNIQUE constraint failed: artifact\.derivation_key, artifact\.ordinal/,
    "UNIQUE (derivation_key, ordinal) が無ければ、この行が和集合の種になる",
  );
  // 落ちたことの確認は、実際に入れようとした id で行う。
  // 入れていない値を数えても 0 は必ず出るので、何も確かめられない
  assert.equal(ctx.count("artifact WHERE artifact_id=?", deriveArtifactId(key, 9)), 0);

  // ordinal 9 を足すと UNIQUE には触れないが、宣言した件数と実体がずれる。
  // その形は invariant-checker の artifact_count_mismatch が受け止める（3層目）
  const beforeProbe = await ctx.snapshot();
  ctx.conn.db
    .prepare(
      `INSERT INTO artifact
         (artifact_id, derivation_key, ordinal, document_id, root_version_id,
          type, inline_content, blob_key, content_hash, size_bytes, created_at)
       VALUES (?, ?, 9, ?, ?, 'chunk', 'stale leftover', NULL, 'deadbeef', 14, ?)`,
    )
    .run(deriveArtifactId(key, 9), key, documentId, rootVersionId, ctx.clock.now());
  assert.equal(
    ctx.count("artifact WHERE derivation_key=?", key),
    10,
    "前提: UNIQUE では止まらない形の残骸",
  );
  assert.notEqual(
    ctx.one<{ artifact_count: number }>(
      "SELECT artifact_count FROM derivation WHERE derivation_key=?",
      key,
    )!.artifact_count,
    10,
    "宣言は9のまま。ここが不一致として現れる",
  );
  // 探りは元に戻す。invariant-checker には正しい状態を見せる
  ctx.conn.db.prepare("DELETE FROM artifact WHERE ordinal=9 AND derivation_key=?").run(key);
  assert.ok(
    isEmptyDiff(diffSnapshots(beforeProbe, await ctx.snapshot())),
    "探りの痕跡を残していない",
  );

  // --- 再実行: 同じ入力をもう一度処理しようとしても、状態は変わらない ---
  const before = await ctx.snapshot();
  assert.equal(
    await ctx.store.claimRun({
      ...firstRun.claimMaterialsFor(rootVersionId),
      rootVersionId,
      workerId: WORKER,
      leaseSeconds: 600,
    }),
    null,
    "成功済みの派生は取り直せない",
  );
  const after = await ctx.snapshot();
  ctx.declareReplay(before, after);
  assert.equal(ctx.observationCount("derivation_output_divergence"), 0);
}
