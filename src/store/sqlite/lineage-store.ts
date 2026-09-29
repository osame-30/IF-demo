/**
 * LineageStore の SQLite 実装。
 *
 * `implements LineageStore` を宣言しているので、メソッドの欠落と
 * 引数・戻り値の食い違いはコンパイラが判定します。
 * 実装途中で `throw new Error("not implemented")` を置かなかったのは、
 * 「行が存在する＝実装済み」と同じ誤りを型の上で犯さないためです。
 *
 * 判定関数は書きません。`promoteToCompleted` / `findOrphanedSources` /
 * `traceToOrigin` / `findMissingSince` は1行も書き込みません。
 * 「進めるか問い合わせただけ」で状態が変わってはいけないからです。
 *
 * **トランザクションの内側で await してはいけません。**
 * `LineageStore` は Promise を返す契約ですが、`node:sqlite` は同期 API なので、
 * トランザクション中に待つものは本来ありません。にもかかわらず await を挟むと、
 * BEGIN IMMEDIATE と COMMIT の間にイベントループへ制御が戻り、
 * 他のコードが同じ接続で文を発行できてしまいます。
 * async は「失敗を必ず reject で出す」ためにあり、待つためではありません。
 */

import type { Clock } from "../../domain/clock.ts";
import { assertNormalizationCommit } from "./office-artifact.ts";
import { attestContentHash } from "../../domain/evidence.ts";
import {
  ConcurrentScanError,
  DerivationDivergenceError,
  InvalidArgumentError,
  InvalidCountsError,
  ScanNotRunningError,
  StaleScanError,
  StoreError,
  StaleWorkerError,
} from "../../domain/errors.ts";
import {
  artifactId as deriveArtifactId,
  derivationKey as deriveDerivationKey,
  documentId as deriveDocumentId,
  outputsHash,
  versionId as deriveVersionId,
} from "../../domain/ids.ts";
import type {
  AclDraft,
  DeletionState,
  Artifact,
  ArtifactDraft,
  ArtifactId,
  BlobKey,
  BlobReference,
  CompletedScanRun,
  ContentHash,
  Derivation,
  DerivationDraft,
  DerivationKey,
  Document,
  DocumentId,
  DocumentVersion,
  EpochMs,
  KeyNormalizationPolicy,
  LineageStore,
  ProcessingRun,
  RunId,
  VersionDraft,
  ObservationDraft,
  ObservedEntry,
  ObservedResult,
  ScanId,
  ScanRun,
  SourceId,
  VersionId,
  WorkerId,
} from "../../domain/types.ts";
import type { StoreConnection } from "./connection.ts";

/** DB の行。列名は snake_case のまま扱い、境界でだけ変換する */
type Row = Record<string, unknown>;

/**
 * **「blob への参照がある」の定義。この1本だけ。**
 *
 * 参照を数える場所が複数あると、経路ごとに別々の閉包ができます。
 * 実際に起きた形: 列挙は `document_version` だけを見ていて、
 * `artifact.blob_key` だけが指している鍵が「参照ゼロ」に見えました。
 * その鍵の実体を消しても `artifact` 行は残るので `NO_ORPHAN_ARTIFACT` は
 * 緑のまま、`traceToOrigin` は成功するのに中身が取れません。
 *
 * 削除述語（`BlobDeletionJudge`）が入るときも、**この定数を通してください。**
 * 「参照がある」を別の SQL で書き直した時点で、その2つはいつか食い違います。
 *
 * `artifact.blob_key` が NULL 可なのは inline との排他があるためで、
 * NULL 行は参照ではありません。
 */
const BLOB_REFERENCE_CLOSURE = `
  SELECT 'artifact' AS kind, artifact_id AS ref_id, derivation_key,
         blob_key, content_hash
    FROM artifact WHERE blob_key IS NOT NULL
  UNION ALL
  SELECT 'version' AS kind, version_id AS ref_id, NULL AS derivation_key,
         blob_key, content_hash
    FROM document_version`;

/**
 * 継続位置の式。`kind` と `ref_id` を1本の全順序に畳む。
 *
 * 両方とも16進 ID か固定語なので `:` は出現しません。
 * 区切りが本文に出る形にすると、境界をまたいだ位置が別の位置と一致します。
 */
const REFERENCE_CURSOR = "kind || ':' || ref_id";

function toBlobReference(row: Row): BlobReference {
  const blobKey = str(row["blob_key"]) as BlobKey;
  const contentHash = str(row["content_hash"]) as ContentHash;
  return str(row["kind"]) === "artifact"
    ? {
        kind: "artifact",
        artifactId: str(row["ref_id"]) as ArtifactId,
        derivationKey: str(row["derivation_key"]) as DerivationKey,
        blobKey,
        contentHash,
      }
    : {
        kind: "version",
        versionId: str(row["ref_id"]) as VersionId,
        blobKey,
        contentHash,
      };
}

/**
 * `#liveLease` が拒否した理由。**「拒否した」だけでは監査にならない**ので、
 * 運用上まったく違う5つの事故を名前で分けています。
 *
 *   - `run_missing`   … その run 自体が無い（別の台、刈り取り済み、復元直後）
 *   - `key_mismatch`  … run は生きているが、指している鍵が違う（鍵の取り違え）
 *   - `not_leased`    … 既に閉じた世代（succeeded / failed / abandoned）
 *   - `lease_expired` … leased のままだが期限切れ（reap 前の窓）
 *   - `other_worker`  … 生きた世代だが、持ち主が別のワーカー
 *
 * `key_mismatch` は鍵を渡す commitDerivation でしか起こりません。
 *
 * **「原本の取り違え」がここに無いのは、表現できないからです。**
 * `DerivationDraft` は `rootVersionId` を持たず、commit は検証した run の
 * 原本をそのまま使います。照合する相手が無いので、分岐も要りません
 * （2026-09-10。束縛ではなく、受け取らないほうを採った）。
 */
type LeaseMismatch =
  | "run_missing"
  | "key_mismatch"
  | "not_leased"
  | "lease_expired"
  | "other_worker";

const num = (v: unknown): number => Number(v);
const str = (v: unknown): string => String(v);

export class SqliteLineageStore implements LineageStore {
  readonly #conn: StoreConnection;

  /**
   * `verifyBlobReferences` の継続位置（最後に列挙した version_id）。
   * 詳しい理由はそのメソッドのヘッダに書いてあります。
   */
  #blobScanCursor: string | null = null;

  constructor(connection: StoreConnection) {
    this.#conn = connection;
  }

  /** 時計はストアが握る。呼び出し側に渡す口は作らない（#14） */
  get clock(): Clock {
    return this.#conn.clock;
  }

  // --------------------------------------------------------------------------
  // 走査
  // --------------------------------------------------------------------------

  /**
   * 走査を開始する。
   *
   * 基準値は **completed の走査からのみ**採ります。failed の走査を基準にすると
   * 「マウント半死で120件しか取れなかった」状態が次回の基準になり、
   * 9890件の誤 tombstone が安全弁を通過します（#3）。
   *
   * 最新完了走査の選び方は completion_seq です。finished_at は同値になりえます。
   */
  async beginScan(
    sourceId: SourceId,
    thresholds: { countRatioThresholdBp: number; missingRatioThresholdBp: number },
  ): Promise<ScanRun> {
    assertBp(thresholds.countRatioThresholdBp, "countRatioThresholdBp");
    assertBp(thresholds.missingRatioThresholdBp, "missingRatioThresholdBp");

    return this.#conn.transaction(() => {
      const source = this.#conn.db
        .prepare("SELECT source_id FROM source WHERE source_id = ?")
        .get(sourceId) as Row | undefined;
      if (source === undefined) {
        throw new InvalidArgumentError(`unknown sourceId: ${sourceId}`);
      }

      // 基準は completed のみ。failed は基準値になれない（#3）
      const previous = this.#conn.db
        .prepare(
          `SELECT scan_id, distinct_count FROM scan_run
            WHERE source_id = ? AND status = 'completed'
            ORDER BY completion_seq DESC LIMIT 1`,
        )
        .get(sourceId) as Row | undefined;

      const scanId = this.#conn.newEventId();
      const startedAt = this.#conn.clock.now();
      // 開始順は **この INSERT と同じトランザクション**で採る。
      // completion_seq と同じ理由（started_at では同値が起こる）に加え、
      // 削除判定が「後から始まった走査」を見分ける唯一の根拠になる（攻撃 #1）
      const startSeq =
        num(
          (
            this.#conn.db
              .prepare("SELECT COALESCE(MAX(start_seq), 0) AS m FROM scan_run WHERE source_id=?")
              .get(sourceId) as Row
          )["m"],
        ) + 1;

      try {
        this.#conn.db
          .prepare(
            `INSERT INTO scan_run
               (scan_id, source_id, started_at, start_seq, status,
                enumerated_count, distinct_count,
                previous_completed_scan_id, previous_distinct_count,
                count_ratio_threshold_bp, missing_ratio_threshold_bp, write_failure_count)
             VALUES (?, ?, ?, ?, 'running', 0, 0, ?, ?, ?, ?, 0)`,
          )
          .run(
            scanId,
            sourceId,
            startedAt,
            startSeq,
            previous === undefined ? null : str(previous["scan_id"]),
            previous === undefined ? 0 : num(previous["distinct_count"]),
            thresholds.countRatioThresholdBp,
            thresholds.missingRatioThresholdBp,
          );
      } catch (error) {
        // idx_one_running_scan の違反。例外の型ではなく DB の状態で判断する
        const running = this.#conn.db
          .prepare("SELECT scan_id FROM scan_run WHERE source_id = ? AND status = 'running'")
          .get(sourceId) as Row | undefined;
        if (running !== undefined) {
          throw new ConcurrentScanError(
            `source ${sourceId} already has a running scan (${str(running["scan_id"])})`,
            { cause: error },
          );
        }
        throw error;
      }

      return this.#loadScan(scanId as ScanId);
    });
  }

  /**
   * 運用者による1回限りの承認（#28）。
   *
   * 閾値には触れません。この走査の承認時刻・理由・欠損上限を保存します（S4-3）。
   */
  async approveScan(scanId: ScanId, note: string, maxMissingCount: number): Promise<ScanRun> {
    assertCount(maxMissingCount, "maxMissingCount");
    if (note.trim() === "") {
      // 理由のない承認は監査に使えない。空文字を「承認済み」として残さない
      throw new InvalidArgumentError("approveScan requires a non-empty note");
    }
    return this.#conn.transaction(() => {
      const row = this.#conn.db
        .prepare("SELECT status, approved_at FROM scan_run WHERE scan_id = ?")
        .get(scanId) as Row | undefined;
      if (row === undefined || str(row["status"]) !== "running") {
        throw new ScanNotRunningError(
          `approveScan targets a running scan; ${scanId} is ${row === undefined ? "missing" : str(row["status"])}`,
        );
      }
      if (row["approved_at"] !== null) {
        throw new InvalidArgumentError("approval is already recorded for this scan");
      }
      this.#conn.db
        .prepare("UPDATE scan_run SET approved_at = ?, approved_note = ?, approved_max_missing_count = ? WHERE scan_id = ?")
        .run(this.#conn.clock.now(), note, maxMissingCount, scanId);
      return this.#loadScan(scanId);
    });
  }

  async findRunningScan(sourceId: SourceId): Promise<ScanRun | null> {
    const row = this.#conn.db.prepare(
      "SELECT * FROM scan_run WHERE source_id=? AND status='running'",
    ).get(sourceId) as Row | undefined;
    return row === undefined ? null : toScanRun(row);
  }

  async countMissingInRunningScan(scanId: ScanId): Promise<number> {
    return this.#conn.read(() => {
      const scan = this.#loadScan(scanId);
      if (scan.status !== "running") throw new ScanNotRunningError(`scan ${scanId} is not running`);
      return this.#countMissing(scan.sourceId, scanId);
    });
  }

  // 承認前の表示と確定時の検算は同じ述語を使う。表示値を確定の口には戻さない。
  #countMissing(sourceId: string, scanId: ScanId): number {
    return num((this.#conn.db.prepare(
      "SELECT count(*) AS n FROM document WHERE source_id=? AND state='active' AND last_seen_scan_id<>?",
    ).get(sourceId, scanId) as Row)["n"]);
  }

  /**
   * 走査を `failed` で閉じる。
   *
   * **安全弁は通しません。** `failed` は「世界がこうなっている」ではなく
   * 「自分の観測が続けられなくなった」という表明なので、件数比も欠損率も
   * 意味を持ちません。基準値にもなれず（#3）、`promoteToCompleted` も通らないので、
   * この走査から削除判定へ進む経路はありません。
   *
   * この口が無いと、クラッシュした走査が `running` のまま残り、
   * `idx_one_running_scan` によってその source では二度と `beginScan` できません。
   * 「安全に閉じる手段が無い」のは fail-closed ではなく、ただの閉塞です。
   */
  async failScan(scanId: ScanId, reason: string): Promise<ScanRun> {
    if (reason.trim() === "") {
      // 理由のない失敗は監査に使えない。空文字を「失敗した」として残さない
      throw new InvalidArgumentError("failScan requires a non-empty reason");
    }
    return this.#conn.transaction(() => {
      const row = this.#conn.db
        .prepare("SELECT status FROM scan_run WHERE scan_id = ?")
        .get(scanId) as Row | undefined;
      if (row === undefined || str(row["status"]) !== "running") {
        throw new ScanNotRunningError(
          `failScan targets a running scan; ${scanId} is ${row === undefined ? "missing" : str(row["status"])}`,
        );
      }
      // completion_seq は立てない。失敗した走査は完了順に並ばない
      this.#conn.db
        .prepare(
          "UPDATE scan_run SET status='failed', finished_at=?, abort_reason=? WHERE scan_id=?",
        )
        .run(this.#conn.clock.now(), reason, scanId);
      return this.#loadScan(scanId);
    });
  }

  /**
   * 走査を完了させ、安全弁を判定する。
   *
   * 判定順序（確定仕様）:
   *   G1 write_failures  — 承認で免除しない。立ったら G2/G3 は評価しない
   *   G2 count_ratio     — 承認で免除する
   *   G3 missing_ratio   — 承認で免除する。G2 とは独立に評価し理由を両方残す
   *
   * G1 を先に見て免除しないのは、書き込み失敗が「世界の状態ではなく
   * 自分の記録が不完全」だという表明だからです。その状態で G2/G3 を評価すると、
   * 記録されなかった観測が欠損に見え、missing_ratio という**誤った理由**が
   * 運用者に提示されます。運用者は記録されなかったものを知る手段がないので、
   * 承認という判断が原理的にできません（#16）。
   *
   * G2 と G3 を承認が両方免除するのは、source が正当に空になった場合に
   * 件数比と欠損率が**必ず同時に**発火するためです。片方しか免除しないと
   * 走査を完了させる手段が無くなり、運用者は閾値を 0 にします。それが #28 です。
   */
  /**
   * 部分木を一覧できなかったことを記録する。
   *
   * 数を積むだけでなく observation も書きます。**件数だけでは
   * 「どこを見ていないのか」が残らず、監査の対象が消えます。**
   */
  async recordUnlistableSubtree(
    scanId: ScanId,
    subtree: { subtreeKey: string; errorKind: string },
  ): Promise<void> {
    if (subtree.subtreeKey.trim() === "") {
      // どこが見えなかったのか分からない記録は監査に使えない
      throw new InvalidArgumentError("recordUnlistableSubtree requires a non-empty subtreeKey");
    }
    if (subtree.errorKind.trim() === "") {
      throw new InvalidArgumentError("recordUnlistableSubtree requires a non-empty errorKind");
    }
    this.#conn.transaction(() => {
      const row = this.#conn.db
        .prepare("SELECT status FROM scan_run WHERE scan_id = ?")
        .get(scanId) as Row | undefined;
      if (row === undefined || str(row["status"]) !== "running") {
        // 黙って無視しない。走っていない走査への記録は呼び出し側の誤り
        throw new ScanNotRunningError(
          `scan ${scanId} is not running (status: ${row === undefined ? "missing" : str(row["status"])})`,
        );
      }
      this.#conn.db
        .prepare(
          "UPDATE scan_run SET unlistable_subtree_count = unlistable_subtree_count + 1 WHERE scan_id = ?",
        )
        .run(scanId);
      this.#observe({
        kind: "subtree_unlistable",
        scanId,
        detail: { subtreeKey: subtree.subtreeKey, errorKind: subtree.errorKind },
      });
    });
  }

  async finishScan(
    scanId: ScanId,
    counts: { enumeratedCount: number; distinctCount: number; writeFailureCount: number },
  ): Promise<ScanRun> {
    // 検証は書き込みの前。違反時に1行も書かない（AC-FIN-10）
    assertCount(counts.enumeratedCount, "enumeratedCount");
    assertCount(counts.distinctCount, "distinctCount");
    assertCount(counts.writeFailureCount, "writeFailureCount");
    if (counts.distinctCount > counts.enumeratedCount) {
      throw new InvalidCountsError(
        `distinctCount (${counts.distinctCount}) cannot exceed enumeratedCount (${counts.enumeratedCount})`,
      );
    }

    return this.#conn.transaction(() => {
      const scan = this.#conn.db
        .prepare("SELECT * FROM scan_run WHERE scan_id = ?")
        .get(scanId) as Row | undefined;
      if (scan === undefined || str(scan["status"]) !== "running") {
        throw new ScanNotRunningError(
          `scan ${scanId} is not running (status: ${scan === undefined ? "missing" : str(scan["status"])})`,
        );
      }

      const sourceId = str(scan["source_id"]);
      const approved = scan["approved_at"] !== null;
      const prevDistinct = num(scan["previous_distinct_count"]);
      const countBp = num(scan["count_ratio_threshold_bp"]);
      const missingBp = num(scan["missing_ratio_threshold_bp"]);

      // ストア側で数えた失敗があれば大きいほうを採る。値が失われない
      const writeFailures = Math.max(num(scan["write_failure_count"]), counts.writeFailureCount);
      // 走査中に積まれた分だけ。呼び出し側から渡す口は無い（渡せると数を偽れる）
      const unlistable = num(scan["unlistable_subtree_count"]);

      this.#conn.db
        .prepare(
          `UPDATE scan_run SET enumerated_count=?, distinct_count=?, write_failure_count=?
            WHERE scan_id=?`,
        )
        .run(counts.enumeratedCount, counts.distinctCount, writeFailures, scanId);

      // 今回の走査で見なかった active 文書。今回作られた文書は
      // last_seen_scan_id が今回の scanId なので自動的に分母から外れる
      const missing = this.#countMissing(sourceId, scanId);

      const reasons: string[] = [];
      if (writeFailures > 0 || unlistable > 0) {
        // G1 が立ったら G2/G3 は評価しない。誤った理由を提示しないため。
        // 一覧できなかった部分木も同じ側に置く。**見えなかった範囲について
        // 「欠損した」と述べる根拠が無いので、比率を計算しても意味がない**
        if (writeFailures > 0) reasons.push("write_failures");
        if (unlistable > 0) reasons.push("unlistable_subtree");
      } else if (prevDistinct > 0) {
        // 除算しない。交差積なので 0除算も NaN も構造的に起きない
        if (counts.distinctCount * 10000 < prevDistinct * countBp) reasons.push("count_ratio");
        if (missing * 10000 > prevDistinct * missingBp) reasons.push("missing_ratio");
      }

      // S4-3: 比率が通る場合も承認の上限は守る。G1 の理由とは混ぜない。
      if (approved && writeFailures === 0 && unlistable === 0 &&
          missing > num(scan["approved_max_missing_count"])) reasons.push("approval_missing_limit");

      // 承認で免除できるのは比率の理由だけ。観測そのものが欠けている理由は
      // 運用者の確信では埋まらない（AGENTS.md 3.5）
      const excusable =
        reasons.length > 0 &&
        !reasons.includes("write_failures") &&
        !reasons.includes("unlistable_subtree") &&
        !reasons.includes("approval_missing_limit");
      const passes = reasons.length === 0 || (approved && excusable);
      const now = this.#conn.clock.now();

      if (passes) {
        const seq =
          num(
            (
              this.#conn.db
                .prepare("SELECT COALESCE(MAX(completion_seq), 0) AS m FROM scan_run WHERE source_id=?")
                .get(sourceId) as Row
            )["m"],
          ) + 1;
        // **`completed` は「弁を通った」であって「削除を反映した」ではありません。**
        // 削除の反映はこの後の別の書き込みなので、ここで `pending` を立てて
        // 「まだ終わっていない仕事がある」を行に残します（C1）。
        // これが無いと、反映前に落ちた走査と反映済みの走査が区別できず、
        // 基準値だけが進んだ状態から自力で戻れません
        this.#conn.db
          .prepare(
            `UPDATE scan_run SET status='completed', finished_at=?, completion_seq=?,
                                 deletion_state='pending'
              WHERE scan_id=?`,
          )
          .run(now, seq, scanId);

        if (approved && reasons.length > 0) {
          this.#observe({
            kind: "scan_approved_by_operator",
            scanId,
            detail: { excused: [...reasons].sort(), note: str(scan["approved_note"]),
              missing, maxMissingCount: num(scan["approved_max_missing_count"]) },
          });
        }
      } else {
        // 自由文だと機械判定できない。正準トークンの昇順カンマ連結に限定する
        const reason = [...reasons].sort().join(",");
        this.#conn.db
          .prepare(
            "UPDATE scan_run SET status='aborted_safety', finished_at=?, abort_reason=? WHERE scan_id=?",
          )
          .run(now, reason, scanId);
        this.#observe({
          kind: "scan_aborted_safety",
          scanId,
          detail: {
            reason,
            distinctCount: counts.distinctCount,
            previousDistinctCount: prevDistinct,
            missing,
            ...(approved ? { maxMissingCount: num(scan["approved_max_missing_count"]) } : {}),
            writeFailureCount: writeFailures,
            countRatioThresholdBp: countBp,
            missingRatioThresholdBp: missingBp,
          },
        });
      }

      return this.#loadScan(scanId);
    });
  }

  // --------------------------------------------------------------------------
  // 版とポインタ
  // --------------------------------------------------------------------------

  /**
   * 版を挿入する。既にあれば何も書かない。
   *
   * versionId はここで導出します。呼び出し側が渡せると、
   * documentId と contentHash から決まるはずの ID が食い違いえます。
   *
   * ingestedAt はストアの時計が刻みます。blobVerifiedAt は BlobStore が
   * 刻んだ証拠値をそのまま受け取ります（判定には使いません）。
   */
  async insertVersionIfAbsent(
    draft: VersionDraft,
  ): Promise<{ created: boolean; versionId: VersionId }> {
    if (!Number.isSafeInteger(draft.sizeBytes) || draft.sizeBytes < 0) {
      throw new InvalidArgumentError(`sizeBytes must be a non-negative integer, got ${draft.sizeBytes}`);
    }
    // 未検証の blob を参照する行を書かない（#8, #21）。
    // 0 や負値は「検証していない」を表す値として通さない
    if (!Number.isSafeInteger(draft.blobVerifiedAt) || draft.blobVerifiedAt <= 0) {
      throw new InvalidArgumentError(
        `blobVerifiedAt must be a positive EpochMs; a version row may not reference an unverified blob`,
      );
    }
    if (draft.blobKey.trim() === "") {
      throw new InvalidArgumentError("blobKey must not be empty");
    }

    // contentHash が小文字 hex でなければここで落ちる
    const vid = deriveVersionId(draft.documentId, draft.contentHash);

    return this.#conn.transaction(() => {
      const existing = this.#conn.db
        .prepare("SELECT version_id FROM document_version WHERE version_id = ?")
        .get(vid) as Row | undefined;
      if (existing !== undefined) return { created: false, versionId: vid };

      this.#conn.db
        .prepare(
          `INSERT INTO document_version
             (version_id, document_id, content_hash, size_bytes, blob_key, blob_verified_at,
              mime_type, source_modified_at, ingested_at, discovered_by_scan_id, pipeline_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          vid,
          draft.documentId,
          draft.contentHash,
          draft.sizeBytes,
          draft.blobKey,
          draft.blobVerifiedAt,
          draft.mimeType,
          draft.sourceModifiedAt ?? null,
          this.#conn.clock.now(),
          draft.discoveredByScanId,
          draft.pipelineVersion,
        );
      return { created: true, versionId: vid };
    });
  }

  /**
   * active ポインタを更新する。
   *
   * **挿入結果ではなく現在の観測から決めます。**
   * version 挿入後・ポインタ更新前にクラッシュすると、再実行時に
   * `insertVersionIfAbsent` が `created:false` を返します。そこで
   * 「変更なし」と判断するとポインタが永久に古いままになります（#15）。
   * ここでは observedHash と現 active の hash を比べるので、
   * version が既存でも必要ならポインタは動きます。
   *
   * 古い走査からの更新は拒みます（#2）。同一 source で running な走査は
   * 高々1件なので、「running でない走査からの更新」＝「追い越された走査」です。
   */
  async setActiveVersion(args: {
    documentId: DocumentId;
    observedHash: ContentHash;
    versionId: VersionId;
    scanId: ScanId;
  }): Promise<{ updated: boolean; reason?: "stale_scan" | "already_current" }> {
    // 引数の内部矛盾を通さない。versionId は documentId と observedHash から決まる
    const expected = deriveVersionId(args.documentId, args.observedHash);
    if (expected !== args.versionId) {
      throw new InvalidArgumentError(
        `versionId does not match documentId + observedHash (expected ${expected}, got ${args.versionId})`,
      );
    }

    return this.#conn.transaction(() => {
      const doc = this.#conn.db
        .prepare(
          `SELECT d.document_id, d.source_id, v.content_hash AS active_hash
             FROM document d
             LEFT JOIN document_version v ON v.version_id = d.active_version_id
            WHERE d.document_id = ?`,
        )
        .get(args.documentId) as Row | undefined;
      if (doc === undefined) {
        throw new InvalidArgumentError(`unknown documentId: ${args.documentId}`);
      }

      const scan = this.#conn.db
        .prepare("SELECT status, source_id FROM scan_run WHERE scan_id = ?")
        .get(args.scanId) as Row | undefined;

      // **走査と文書が同じ接続元に属することを先に見ます。**
      // 「running か」だけを見ると、同一 source の running が高々1件でも、
      // *別 source* の running 走査は常に存在しえます。その ID に差し替えるだけで
      // 「追い越された走査」の拒否を回避でき、観測にも他所の scan_id が載ります
      // （`POINTER_MATCHES_OBSERVATION` は載った ID の所属を見ていません）。
      // これは競合ではなく取り違えなので、`tombstone` / `#gateForDeletion` と
      // 同じく `stale_scan` に畳まず例外にします。
      if (scan !== undefined && str(scan["source_id"]) !== str(doc["source_id"])) {
        throw new InvalidArgumentError(
          `scan ${args.scanId} belongs to ${str(scan["source_id"])}, ` +
            `but document ${args.documentId} belongs to ${str(doc["source_id"])}`,
        );
      }

      if (scan === undefined || str(scan["status"]) !== "running") {
        // 追い越された走査の観測でポインタを巻き戻さない（#2）
        return { updated: false, reason: "stale_scan" as const };
      }

      if (doc["active_hash"] !== null && str(doc["active_hash"]) === args.observedHash) {
        return { updated: false, reason: "already_current" as const };
      }

      this.#conn.db
        .prepare("UPDATE document SET active_version_id = ? WHERE document_id = ?")
        .run(args.versionId, args.documentId);

      // 既にこの版を指したことがあるなら、戻ったということ（#19 の復元など）
      const seenBefore = this.#conn.db
        .prepare(
          "SELECT 1 AS x FROM observation WHERE kind='version_created' AND version_id = ? LIMIT 1",
        )
        .get(args.versionId) as Row | undefined;

      this.#observe({
        kind: seenBefore === undefined ? "version_created" : "version_reverted",
        documentId: args.documentId,
        versionId: args.versionId,
        scanId: args.scanId,
        detail: { contentHash: args.observedHash },
      });

      return { updated: true };
    });
  }

  // --------------------------------------------------------------------------
  // 削除判定への入口
  // --------------------------------------------------------------------------

  /**
   * 削除判定に進めるかを問う。**唯一の入口。**
   *
   * **1行も書きません。** 判定関数が書き込むと、「削除判定に進めるか
   * 問い合わせただけ」で状態が変わります。
   *
   * 4条件のうち「弁を通過または承認済み」は status に畳まれています
   * （弁が発火して承認もなければ aborted_safety になるため）。
   * 冗長と承知で明示チェックを残しているのは、status の意味が将来変わったときに
   * ここが黙って通らないようにするためです。
   */
  async promoteToCompleted(scanId: ScanId): Promise<CompletedScanRun | null> {
    return this.#conn.read(() => {
      const row = this.#conn.db.prepare("SELECT * FROM scan_run WHERE scan_id = ?").get(scanId) as
        | Row
        | undefined;
      if (row === undefined) return null;

      const scan = toScanRun(row);
      if (scan.status !== "completed") return null;
      if (scan.finishedAt === undefined || scan.completionSeq === undefined) return null;
      // 書き込み失敗のある走査は削除判定に進めない（#16）
      if (scan.writeFailureCount !== 0) return null;
      // 後から完了した走査があれば、この走査はもう最新ではない（#1, #2）
      if (!this.#isLatestCompleted(scan.sourceId, scan.completionSeq)) return null;

      return {
        ...scan,
        status: "completed",
        finishedAt: scan.finishedAt,
        writeFailureCount: 0,
        isLatestCompleted: true,
      };
    });
  }

  /**
   * 今回の走査で見なかった active 文書を返す。
   *
   * **欠損集合を単一の読み取りトランザクション内で確定してから yield します。**
   * `AsyncIterable` の見た目に引きずられて遅延クエリにすると、呼び出し側の
   * tombstone 書き込みが自分の読み取り集合を変えます。そうなると
   * SAFETY_ABORT_WRITES_NOTHING も DELETION_ONLY_FROM_COMPLETED_SCAN も
   * 緑のまま集合だけが変質します（#4 と同じ形）。
   *
   * 反復中に1行も書きません。
   */
  async *findMissingSince(scan: CompletedScanRun): AsyncIterable<Document> {
    const rows = this.#conn.read(() => {
      // promote から時間が経っている。TOCTOU があるので冒頭で再確認する
      const startSeq = this.#gateForDeletion(scan);
      // **「この走査より後に始まった走査が見た文書」は欠損ではありません。**
      // 以前は `last_seen_scan_id <> scanId` だけを見ていました。それだと
      // 「誰も見なかった」と「後続の走査が見た」が同じ値になり、走査が
      // **自分で観測した文書まで**欠損集合に入ります（攻撃 #1、実測）。
      // 後続がまだ completed でない間は completion_seq の追い越し判定も
      // 発火しないので、開始順で見分けるほかありません。
      return this.#conn.db
        .prepare(
          `SELECT d.* FROM document d
             JOIN scan_run s ON s.scan_id = d.last_seen_scan_id
            WHERE d.source_id = ? AND d.state = 'active' AND s.start_seq < ?
            ORDER BY d.document_id`,
        )
        .all(scan.sourceId, startSeq) as Row[];
    });

    for (const row of rows) yield toDocument(row);
  }

  /**
   * 欠損した文書に墓標を立てる。
   *
   * 追い越しの判定を**書く直前にもう一度**行います。`findMissingSince` は
   * 列挙の各 yield の前に確かめますが、列挙と書き込みの間にも窓があります。
   */
  async tombstone(scan: CompletedScanRun, documentId: DocumentId): Promise<boolean> {
    return this.#conn.transaction(() => {
      // 追い越された走査から削除判定へ進ませない（#1, #2）。
      // 判定は引数ではなく行から行う（構造的部分型で偽造できるため）
      const startSeq = this.#gateForDeletion(scan);

      const row = this.#conn.db
        .prepare("SELECT source_id, state, last_seen_scan_id FROM document WHERE document_id = ?")
        .get(documentId) as Row | undefined;
      if (row === undefined) {
        throw new InvalidArgumentError(`unknown document: ${documentId}`);
      }
      if (str(row["source_id"]) !== String(scan.sourceId)) {
        // 別 source の文書を、この走査の権限で消させない
        throw new InvalidArgumentError(
          `document ${documentId} belongs to ${str(row["source_id"])}, not ${scan.sourceId}`,
        );
      }
      // 既に墓標がある、またはこの走査以降に観測されている。どちらも
      // 呼び出し側の誤りではありません。列挙と書き込みの間に観測が入るのは
      // 正常です（`findMissingSince` と同じ門を、書く直前にもう一度）
      if (str(row["state"]) !== "active") return false;
      const seenBy = this.#conn.db
        .prepare("SELECT start_seq FROM scan_run WHERE scan_id = ?")
        .get(str(row["last_seen_scan_id"])) as Row | undefined;
      // 自分自身（同値）と、後から始まった走査（大）の両方をここで弾きます
      if (seenBy !== undefined && num(seenBy["start_seq"]) >= startSeq) return false;

      const now = this.#conn.clock.now();
      this.#conn.db
        .prepare("UPDATE document SET state='tombstoned', tombstoned_at=? WHERE document_id=?")
        .run(now, documentId);
      // 観測が墓標の出所そのもの。状態だけ動かすと出所が辿れなくなる
      this.#observe({ kind: "document_tombstoned", documentId, scanId: scan.scanId, detail: {} });
      return true;
    });
  }

  /**
   * 削除判定に進んでよい走査かを **`scan_run` の行から**確かめ、開始順を返す。
   *
   * **渡された値を信じません。** `CompletedScanRun` は構造的部分型なので、
   * `promoteToCompleted` を通らずにオブジェクトリテラルで組めます（`as` すら
   * 要りません。`tsc --noEmit` が exit 0 になることを実測済み）。status や
   * completionSeq を引数から読むと、`aborted_safety` で終わった走査からでも
   * 墓標が立ちます。**数えるのは常に行のほうです。**
   */
  #gateForDeletion(scan: CompletedScanRun): number {
    const row = this.#conn.db
      .prepare(
        `SELECT source_id, status, completion_seq, start_seq, write_failure_count
           FROM scan_run WHERE scan_id = ?`,
      )
      .get(scan.scanId) as Row | undefined;
    if (row === undefined) {
      throw new InvalidArgumentError(`unknown scan: ${scan.scanId}`);
    }
    if (str(row["source_id"]) !== String(scan.sourceId)) {
      throw new InvalidArgumentError(
        `scan ${scan.scanId} belongs to ${str(row["source_id"])}, not ${scan.sourceId}`,
      );
    }
    if (str(row["status"]) !== "completed" || num(row["write_failure_count"]) !== 0) {
      throw new StaleScanError(
        `scan ${scan.scanId} may not run deletion (status=${str(row["status"])}, ` +
          `writeFailures=${String(num(row["write_failure_count"]))})`,
      );
    }
    // 追い越しの判定（#1, #2）。ここも行の completion_seq で行う
    if (!this.#isLatestCompleted(scan.sourceId, num(row["completion_seq"]))) {
      throw new StaleScanError(
        `scan ${scan.scanId} is no longer the latest completed scan for ${scan.sourceId}`,
      );
    }
    return num(row["start_seq"]);
  }

  /**
   * **削除の反映が済んでいない完了走査を探す。1行も書きません。**
   *
   * 返すのは `scanId` だけで、`CompletedScanRun` は返しません。
   * 削除判定へ進める門は `promoteToCompleted` 1つだけであるべきで、
   * ここが値を返すと2つ目の門になります（「判定関数は書き込まない」と
   * 同じ理由で、「入口を増やさない」も守ります）。
   *
   * 見るのは **source ごとの最新完了走査だけ**です。より古い pending は
   * 後続の完了走査が同じ欠損を見ているので、そちらの反映で足ります
   * （`markDeletionApplied` が `superseded` に畳みます）。
   * 最新でない走査を返すと `promoteToCompleted` が必ず `null` を返し、
   * 呼び出し側は「再開できない仕事」を永久に持ち回ることになります。
   */
  async findPendingDeletion(sourceId: SourceId): Promise<ScanId | null> {
    return this.#conn.read(() => {
      const row = this.#conn.db
        .prepare(
          `SELECT scan_id, deletion_state FROM scan_run
            WHERE source_id = ? AND status = 'completed'
            ORDER BY completion_seq DESC LIMIT 1`,
        )
        .get(sourceId) as Row | undefined;
      if (row === undefined || str(row["deletion_state"]) !== "pending") return null;
      return str(row["scan_id"]) as ScanId;
    });
  }

  /**
   * 削除の反映が終わったことを記録する。**最後の検査点です。**
   *
   * 渡された `CompletedScanRun` を信じません。`#gateForDeletion` を通すので、
   * 追い越された走査や書き込み失敗のある走査には印が付きません
   * （`tombstone` と同じ門。オブジェクトリテラルで組んだ値では通りません）。
   *
   * 同じ source のより古い pending は `superseded` に畳みます。**この走査は
   * それらより後に列挙しているので、古い走査が欠損と見た文書は、この走査でも
   * 欠損として見えています。** 畳まないと、二度と反映されない `pending` が
   * 残り続け、運用表示が「未完了の仕事がある」と言い続けます。
   */
  async markDeletionApplied(scan: CompletedScanRun): Promise<void> {
    return this.#conn.transaction(() => {
      this.#gateForDeletion(scan);

      const completionSeq = num(
        (
          this.#conn.db
            .prepare("SELECT completion_seq FROM scan_run WHERE scan_id=?")
            .get(scan.scanId) as Row
        )["completion_seq"],
      );

      this.#conn.db
        .prepare("UPDATE scan_run SET deletion_state='applied' WHERE scan_id=?")
        .run(scan.scanId);
      this.#conn.db
        .prepare(
          `UPDATE scan_run SET deletion_state='superseded'
            WHERE source_id=? AND status='completed' AND deletion_state='pending'
              AND completion_seq < ?`,
        )
        .run(scan.sourceId, completionSeq);
    });
  }

  #isLatestCompleted(sourceId: SourceId, completionSeq: number): boolean {
    const row = this.#conn.db
      .prepare(
        `SELECT count(*) AS n FROM scan_run
          WHERE source_id = ? AND status = 'completed' AND completion_seq > ?`,
      )
      .get(sourceId, completionSeq) as Row;
    return num(row["n"]) === 0;
  }

  // --------------------------------------------------------------------------
  // 観測
  // --------------------------------------------------------------------------

  /**
   * 1件の観測を記録する。
   *
   * outcome がどの枝でも last_seen を更新します。読めなかったこと（#17）や
   * サイズが合わなかったこと（#7）は、**見えなかったことではありません**。
   * ここで last_seen を更新し損ねると、その文書は次の削除判定で欠損に見えます。
   *
   * **`stable_key` も毎回上書きします。** 以前は INSERT 時にしか書いておらず、
   * `caseFold: true` の source で `Report.txt` が `report.txt` に改名されても
   * 古い値が残っていました。`ObservedEntry.stableKey` の契約は
   * 「接続元が報告した生の鍵」なので、`Document` 側だけ古いままだと
   * その文が偽になります。**`documentId` は正規化値から導くので動きません。**
   *
   * `UNIQUE (source_id, stable_key)` と衝突しません。ここで書く鍵 K' は
   * `documentId(K') == docId` を満たすので、別の行が K' を持っていたら
   * その行の documentId も docId になり、同じ行だったことになります。
   */
  async recordObservedDocument(scanId: ScanId, entry: ObservedEntry): Promise<ObservedResult> {
    return this.#conn.transaction(() => {
      const scan = this.#conn.db
        .prepare("SELECT scan_id, source_id, status FROM scan_run WHERE scan_id = ?")
        .get(scanId) as Row | undefined;
      if (scan === undefined || str(scan["status"]) !== "running") {
        // 黙って無視しない。走っていない走査への記録は呼び出し側の誤り
        throw new ScanNotRunningError(
          `scan ${scanId} is not running (status: ${scan === undefined ? "missing" : str(scan["status"])})`,
        );
      }

      const sourceId = str(scan["source_id"]) as SourceId;
      const policy = this.#loadPolicy(sourceId);
      const docId = deriveDocumentId(sourceId, entry.stableKey, policy);
      const now = this.#conn.clock.now();

      const existing = this.#conn.db
        .prepare(
          `SELECT d.document_id, d.state, d.stable_key, d.last_seen_scan_id,
                  d.last_fingerprint, v.content_hash AS active_hash
             FROM document d
             LEFT JOIN document_version v ON v.version_id = d.active_version_id
            WHERE d.document_id = ?`,
        )
        .get(docId) as Row | undefined;

      const created = existing === undefined;
      let revived = false;

      // 同じ走査の中で、別の生の鍵が同じ documentId に潰れた。
      // **どちらが正かはシステムには言えません**（正規化は単射ではなく、
      // どちらが勝つかは列挙順で決まります）。記録だけします
      if (
        existing !== undefined &&
        str(existing["last_seen_scan_id"]) === String(scanId) &&
        str(existing["stable_key"]) !== entry.stableKey
      ) {
        this.#observe({
          kind: "stable_key_collision",
          documentId: docId,
          scanId,
          detail: {
            existingStableKey: str(existing["stable_key"]),
            incomingStableKey: entry.stableKey,
          },
        });
      }

      if (created) {
        this.#conn.db
          .prepare(
            `INSERT INTO document
               (document_id, source_id, stable_key, state, active_version_id,
                first_seen_at, last_seen_at, last_seen_scan_id)
             VALUES (?, ?, ?, 'active', NULL, ?, ?, ?)`,
          )
          .run(docId, sourceId, entry.stableKey, now, now, scanId);
        this.#observe({ kind: "document_discovered", documentId: docId, scanId, detail: { stableKey: entry.stableKey } });
      } else {
        // 復活時は tombstonedAt を必ず消す。残すと内部矛盾になる（#25）
        revived = str(existing["state"]) === "tombstoned";
        if (revived) {
          this.#conn.db
            .prepare(
              `UPDATE document SET state='active', tombstoned_at=NULL,
                 stable_key=?, last_seen_at=?, last_seen_scan_id=? WHERE document_id=?`,
            )
            .run(entry.stableKey, now, scanId, docId);
          this.#observe({ kind: "document_revived", documentId: docId, scanId, detail: {} });
          this.#recheckRenames(docId, scanId);
        } else {
          this.#conn.db
            .prepare(
              "UPDATE document SET stable_key=?, last_seen_at=?, last_seen_scan_id=? WHERE document_id=?",
            )
            .run(entry.stableKey, now, scanId, docId);
        }
      }

      // 同 fingerprint で別 hash（#18）。記録のみ。自動対処はしない
      if (
        entry.outcome.kind === "content" &&
        entry.quickFingerprint !== undefined &&
        existing !== undefined &&
        existing["last_fingerprint"] !== null &&
        str(existing["last_fingerprint"]) === entry.quickFingerprint &&
        existing["active_hash"] !== null &&
        str(existing["active_hash"]) !== entry.outcome.contentHash
      ) {
        this.#observe({
          kind: "fingerprint_collision",
          documentId: docId,
          scanId,
          detail: {
            quickFingerprint: entry.quickFingerprint,
            knownHash: str(existing["active_hash"]),
            observedHash: entry.outcome.contentHash,
          },
        });
      }

      if (entry.quickFingerprint !== undefined) {
        this.#conn.db
          .prepare("UPDATE document SET last_fingerprint=?, last_fingerprint_at=? WHERE document_id=?")
          .run(entry.quickFingerprint, now, docId);
      }

      // 版にならなかった枝は、そうと分かる形で残す（根本原因 #6）
      switch (entry.outcome.kind) {
        case "unreadable":
          this.#observe({
            kind: "document_unreadable",
            documentId: docId,
            scanId,
            detail: { errorKind: entry.outcome.errorKind },
          });
          break;
        case "size_mismatch":
          this.#observe({
            kind: "size_mismatch_rejected",
            documentId: docId,
            scanId,
            detail: {
              declaredSizeBytes: entry.outcome.declaredSizeBytes,
              actualSizeBytes: entry.outcome.actualSizeBytes,
            },
          });
          break;
        case "content":
          // 版の作成は insertVersionIfAbsent / setActiveVersion の責務。
          // ここで観測を足すと無変更の再実行でも書き込みが増える
          break;
      }

      return { documentId: docId as DocumentId, created, revived };
    });
  }

  // --------------------------------------------------------------------------
  // 実行管理（リース）
  // --------------------------------------------------------------------------

  /**
   * 原子的にリースを取得する。
   *
   * **結果は例外ではなくデータから判断します。**
   * `SQLITE_BUSY` は「既にリースされている」ではなく「競合している」です。
   * 前者なら `null`、後者なら再試行が正解なので、両者を混ぜてはいけません。
   * BUSY はそのまま投げ、本番接続は `busy_timeout` で待ちます（#12）。
   *
   * `idx_one_leased_run` の違反はプロセス跨ぎでは到達可能なので、
   * 捕捉して状態を読み直し `null` に翻訳します（2層目の防壁）。
   */
  async claimRun(args: {
    processorName: string;
    processorVersion: string;
    configHash: string;
    inputIds: ReadonlyArray<VersionId | ArtifactId>;
    rootVersionId: VersionId;
    workerId: WorkerId;
    leaseSeconds: number;
  }): Promise<ProcessingRun | null> {
    if (!Number.isSafeInteger(args.leaseSeconds) || args.leaseSeconds <= 0) {
      throw new InvalidArgumentError(`leaseSeconds must be a positive integer, got ${args.leaseSeconds}`);
    }

    // 鍵は材料から導出する。commitDerivation と同じ関数、同じ材料。
    // 重複 inputId などの材料側の誤りはここで例外になる（ids.ts の事前条件）
    const derivationKey = deriveDerivationKey({
      processorName: args.processorName,
      processorVersion: args.processorVersion,
      configHash: args.configHash,
      inputIds: args.inputIds,
    });

    return this.#conn.transaction(() => {
      // documentId は rootVersionId から一意に決まる。**同一トランザクション内**で
      // 引くのが条件で、外で引いた値を持ち込むと「導出した」ではなく
      // 「古い値を写した」になる（AGENTS.md 9節 軸1）
      const version = this.#conn.db
        .prepare("SELECT document_id FROM document_version WHERE version_id = ?")
        .get(args.rootVersionId) as Row | undefined;
      if (version === undefined) {
        throw new InvalidArgumentError(
          `rootVersionId ${args.rootVersionId} does not exist; a run cannot reference a missing version`,
        );
      }
      const documentId = str(version["document_id"]);

      const blocking = this.#blockingRun(derivationKey);
      if (blocking !== null) return null;

      // 失効済みだが未回収のリースを、この鍵に限って先に片付ける。
      // #blockingRun は期限切れを「妨げない」と判断するが、行は leased のままなので
      // idx_one_leased_run が INSERT を拒む。放置するとクラッシュしたワーカーの
      // リースが reapAbandonedRuns を誰かが呼ぶまでこの鍵を占有し続ける
      this.#conn.db
        .prepare(
          `UPDATE processing_run SET status='abandoned', finished_at=?
            WHERE derivation_key=? AND status='leased' AND lease_expires_at<=?`,
        )
        .run(this.#conn.clock.now(), derivationKey, this.#conn.clock.now());

      const attempt =
        num(
          (
            this.#conn.db
              .prepare("SELECT COALESCE(MAX(attempt), 0) AS m FROM processing_run WHERE derivation_key = ?")
              .get(derivationKey) as Row
          )["m"],
        ) + 1;

      const runId = this.#conn.newEventId();
      const now = this.#conn.clock.now();
      const expires = now + args.leaseSeconds * 1000;

      try {
        this.#conn.db
          .prepare(
            `INSERT INTO processing_run
               (run_id, derivation_key, document_id, root_version_id, status, attempt,
                worker_id, started_at, heartbeat_at, lease_expires_at, lease_seconds)
             VALUES (?, ?, ?, ?, 'leased', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            runId,
            derivationKey,
            documentId,
            args.rootVersionId,
            attempt,
            args.workerId,
            now,
            now,
            expires,
            args.leaseSeconds,
          );
      } catch (error) {
        // 例外の型ではなく状態で判断する。別プロセスが先に取っていたなら null
        if (this.#blockingRun(derivationKey) !== null) return null;
        throw error;
      }

      return toProcessingRun(
        this.#conn.db.prepare("SELECT * FROM processing_run WHERE run_id = ?").get(runId) as Row,
      );
    });
  }

  /**
   * ワーカーが生きていることを伝え、リースを延長する。
   *
   * 延長幅は claim 時に決まった lease_seconds を使います。呼び出し側が
   * 期間を渡せると、失効寸前のワーカーが自分で寿命を伸ばせてしまいます。
   *
   * **失効したリースは自己延長できません（AC-RUN-06）。** 所有者が正しくても、
   * 期限を過ぎていれば拒否します。reap がまだ走っていないだけで、
   * そのリースは既に他のワーカーのものになりうるからです。
   */
  async heartbeat(runId: RunId, workerId: WorkerId): Promise<{ ok: boolean; reason?: "stale_worker" }> {
    return this.#conn.transaction(() => {
      const lease = this.#liveLease(runId, workerId);
      if (!lease.ok) return this.#rejectStaleWorker("heartbeat", runId, workerId, lease);

      const { row, now } = lease;
      this.#conn.db
        .prepare("UPDATE processing_run SET heartbeat_at = ?, lease_expires_at = ? WHERE run_id = ?")
        .run(now, now + num(row["lease_seconds"]) * 1000, runId);
      return { ok: true };
    });
  }

  /** 実行を終える。リースの検査は heartbeat と同じ `#liveLease` を通る（#13） */
  async completeRun(args: {
    runId: RunId;
    workerId: WorkerId;
    status: "succeeded" | "failed";
    error?: { kind: string; message: string; permanent: boolean };
  }): Promise<{ ok: boolean; reason?: "stale_worker" }> {
    return this.#conn.transaction(() => {
      const lease = this.#liveLease(args.runId, args.workerId);
      if (!lease.ok) return this.#rejectStaleWorker("completeRun", args.runId, args.workerId, lease);

      const { row, now } = lease;
      this.#conn.db
        .prepare(
          `UPDATE processing_run
              SET status = ?, finished_at = ?, error_kind = ?, error_message = ?, permanent = ?
            WHERE run_id = ?`,
        )
        .run(
          args.status,
          now,
          args.error?.kind ?? null,
          args.error?.message ?? null,
          args.error === undefined ? null : args.error.permanent ? 1 : 0,
          args.runId,
        );

      if (args.status === "failed") {
        this.#observe({
          kind: "run_failed",
          documentId: str(row["document_id"]) as DocumentId,
          runId: args.runId,
          detail: {
            errorKind: args.error?.kind ?? "unknown",
            permanent: args.error?.permanent ?? false,
            attempt: num(row["attempt"]),
          },
        });
      }

      return { ok: true };
    });
  }

  /**
   * 失効したリースを回収する。
   *
   * **引数に時刻を取りません。ストア側の時計だけを使います（#14）。**
   * 呼び出し側の時計を使うと、時計が遅いワーカーは生きたままリースを奪われ、
   * 進んだワーカーはクラッシュ後も永久に leased のまま残ります。
   */
  async reapAbandonedRuns(): Promise<number> {
    return this.#conn.transaction(() => {
      const now = this.#conn.clock.now();
      const result = this.#conn.db
        .prepare(
          `UPDATE processing_run SET status = 'abandoned', finished_at = ?
            WHERE status = 'leased' AND lease_expires_at <= ?`,
        )
        .run(now, now);
      return Number(result.changes);
    });
  }

  /**
   * この derivationKey に対して新たな claim を妨げる run。
   * 「既に誰かが持っている」「もう成功している」「永久に失敗した」の3つ。
   */
  #blockingRun(derivationKey: DerivationKey): Row | null {
    const now = this.#conn.clock.now();
    const row = this.#conn.db
      .prepare(
        `SELECT * FROM processing_run
          WHERE derivation_key = ?
            AND ( (status = 'leased' AND lease_expires_at > ?)
               OR status = 'succeeded'
               OR (status = 'failed' AND permanent = 1) )
          LIMIT 1`,
      )
      .get(derivationKey, now) as Row | undefined;
    return row ?? null;
  }

  /**
   * **「リースが生きている」の唯一の定義。** heartbeat / completeRun /
   * commitDerivation の3経路がここだけを通ります。
   *
   * 述語を各経路に写経すると、片方だけ条件が抜けた瞬間に
   * 「heartbeat は ok なのに commit は lease_expired」という食い違いが生まれます。
   * 失効済みで未刈り取りの窓はまさにその形で開くので、一本にしてあります。
   *
   * 通すのは次が全部そろった場合だけです。
   *
   *   - その `runId` の run が存在する
   *   - （鍵を渡した場合）その run の鍵が、`derivation` から導出した鍵と一致する
   *   - `leased` である
   *   - 期限内（＝この世代がまだ生きている）
   *   - `worker_id` が名乗りと一致する
   *
   * 鍵だけで引くと、失効して reap された世代の遅れてきた commit が、
   * 同じワーカーが取り直した次の世代を閉じます。runId だけで引くと、
   * 鍵Xのリースで鍵Yの派生を確定できます。**両方を要求する以外にありません。**
   *
   * **鍵の一致は原本の一致ではありません（2026-09-10 実測）。** `derivationKey` の
   * 材料は processor 3値と `inputIds` だけなので、`rootVersionId` は鍵に
   * 入っていません。以前は `DerivationDraft` が原本を持っており、文書 A の run で
   * 原本を文書 B の版に差し替えた commit が、この検査を素通りしました。
   * **いまは照合ではなく、この関数が返す行の `root_version_id` を
   * commit がそのまま使います。** 検査を足すのではなく、口を1つ減らしました。
   *
   * **権威は `lease_expires_at` というタイムスタンプであって、
   * `reapAbandonedRuns` による status 更新ではありません。** reap は
   * 「期限切れの行を後片付けする」だけで、リースの生死を決めていません。
   * 決めているのは期限との比較です。だから reap が走る前でも失効は失効です。
   * 比較に使う時刻は `#conn.clock`（ストア側の時計）から一度だけ読み、
   * 結果に載せて返します。SQL 側の `datetime('now')` は使いません（#14 / AC-CLK-02）。
   *
   * 書かないのも要点です。呼び出し元が例外を投げるとロールバックが起きるので、
   * ここで拒否を記録すると記録ごと消えます。記録は commit 後に別途行います。
   */
  #liveLease(
    runId: RunId,
    workerId: WorkerId,
    expectedKey?: DerivationKey,
  ):
    | { ok: true; row: Row; now: EpochMs }
    | { ok: false; row: Row | undefined; mismatch: LeaseMismatch; now: EpochMs } {
    const row = this.#conn.db
      .prepare("SELECT * FROM processing_run WHERE run_id = ?")
      .get(runId) as Row | undefined;
    const now = this.#conn.clock.now();

    if (row === undefined) return { ok: false, row: undefined, mismatch: "run_missing", now };
    // 鍵の取り違えを最優先で名指しする。世代や名乗りより先に疑うべき事故なので
    if (expectedKey !== undefined && str(row["derivation_key"]) !== expectedKey) {
      return { ok: false, row, mismatch: "key_mismatch", now };
    }
    if (str(row["status"]) !== "leased") return { ok: false, row, mismatch: "not_leased", now };
    if (num(row["lease_expires_at"]) <= now) return { ok: false, row, mismatch: "lease_expired", now };
    if (str(row["worker_id"]) !== workerId) return { ok: false, row, mismatch: "other_worker", now };
    return { ok: true, row, now };
  }

  /**
   * 拒否の記録の中身。commit 経路では書き込みはロールバック後に呼び出し元が行う。
   *
   * **どの条件で落ちたかを構造化して残します。** 「拒否した」だけでは、
   * 鍵を取り違えたのか、世代が古いのか、他人のリースなのかが監査から
   * 区別できません。この3つは運用上まったく違う事故です。
   *
   * 判定の材料は `#liveLease` が**同じトランザクション内で一度だけ読んだ行**です。
   * ここで読み直すと、拒否と診断の間に reaper が入って
   * 「拒否理由は other_worker、記録は not_leased」という食い違いが起こります。
   * 行を引き回すのは、その窓を構文的に無くすためです。
   *
   * `runDerivationKey` は run 側が指している鍵、`derivationKey` は
   * 今回の `derivation` から導出した鍵。両方を残すのは、食い違いを
   * 「どちらが正しかったか」まで含めて後から読めるようにするためです。
   * 鍵を渡さない heartbeat / completeRun にはこの2つは載りません
   * （突き合わせる相手が無いので `key_mismatch` も起こり得ません）。
   */
  #staleLeaseDraft(args: {
    operation: string;
    runId: RunId;
    workerId: WorkerId;
    row: Row | undefined;
    mismatch: LeaseMismatch;
    documentId?: DocumentId;
    expectedKey?: DerivationKey;
  }): ObservationDraft {
    const run = args.row;
    const documentId =
      args.documentId ?? (run === undefined ? undefined : (str(run["document_id"]) as DocumentId));

    return {
      kind: "stale_worker_rejected",
      // run が無い場合に run_id 列へ入れると FK 違反になる。detail には必ず残す
      ...(run === undefined ? {} : { runId: args.runId }),
      ...(documentId === undefined ? {} : { documentId }),
      detail: {
        operation: args.operation,
        workerId: args.workerId,
        runId: args.runId,
        owner: run === undefined ? null : run["worker_id"],
        status: run === undefined ? "missing" : str(run["status"]),
        mismatch: args.mismatch,
        ...(args.expectedKey === undefined
          ? {}
          : {
              derivationKey: args.expectedKey,
              runDerivationKey: run === undefined ? null : run["derivation_key"],
            }),
      },
    };
  }

  /** commitDerivation の中から run を閉じる。トランザクションは呼び出し元が持つ */
  #succeedRun(runId: RunId): void {
    this.#conn.db
      .prepare("UPDATE processing_run SET status='succeeded', finished_at=? WHERE run_id=?")
      .run(this.#conn.clock.now(), runId);
  }

  /**
   * 失効後に復活したワーカーの操作を拒否し、記録に残す（#13）。
   *
   * commit と違ってロールバックが起きないので、ここでは即座に書けます。
   * 判定は `#liveLease` の結果をそのまま受け取ります。読み直しません。
   */
  #rejectStaleWorker(
    operation: string,
    runId: RunId,
    workerId: WorkerId,
    bad: { row: Row | undefined; mismatch: LeaseMismatch },
  ): { ok: false; reason: "stale_worker" } {
    this.#observe(
      this.#staleLeaseDraft({ operation, runId, workerId, row: bad.row, mismatch: bad.mismatch }),
    );
    return { ok: false, reason: "stale_worker" };
  }

  // --------------------------------------------------------------------------
  // 派生
  // --------------------------------------------------------------------------

  /**
   * Derivation・全 Artifact・run 完了を**同一トランザクションで**書く。
   * 部分的な成立はあり得ない（#9）。
   *
   * derivationKey / artifactCount / outputsHash は**導出**します。呼び出し側が
   * 「宣言した個数」を渡せると、実際の個数と食い違う余地が残る（#9 の穴）ためです。
   *
   * `runId` は導出できないので**受け取り、束縛します**。鍵は「何を処理するか」、
   * runId は「その鍵のどの世代か」で、意味が違います。`#liveLease` が
   * 「その runId の run は、この導出鍵のもので、生きていて、この名乗りのものか」を
   * 一度に検査します。鍵だけで引くと世代が守れず、runId だけで引くと鍵が守れません。
   *
   * 既存と同じ derivationKey で内容が違えば `DerivationDivergenceError`。
   * **無言でスキップしません。**「存在するから正しい」とは扱いません（#10, #11）。
   */
  async commitDerivation(args: {
    derivation: DerivationDraft;
    artifacts: ReadonlyArray<ArtifactDraft>;
    runId: RunId;
    workerId: WorkerId;
  }): Promise<{ created: boolean; derivationKey: DerivationKey }> {
    const key = deriveDerivationKey({
      processorName: args.derivation.processorName,
      processorVersion: args.derivation.processorVersion,
      configHash: args.derivation.configHash,
      inputIds: args.derivation.inputIds,
    });

    // **inline の値はここで導出します。受け取りません。**
    //
    // AGENTS.md 9節 軸4 は `contentHash` について「述語は書けるが
    // `commitDerivation` の中では払えない（全 artifact の blob を再読することになる）」
    // と裁定し、費用を生成時へ移しました（`VerifiedContentHash`）。
    // **その理由が当てはまらない枝が1つあります。** inline の本文は draft の中に
    // あるので、再読も I/O も要りません。
    //
    // 実測（2026-09-10）: 本文 `"WRONG"` に `attestContentHash(Buffer.from("RIGHT"))`
    // ——正規の鋳造元から出た本物の証拠——を付けた artifact が確定でき、
    // `sizeBytes` は 99999 でも通り、15項目すべてが緑でした。証拠型が運ぶのは
    // 「ある実在のバイト列を読み切った」までで、*どの*バイト列かは運びません
    // （KNOWN_LIMITATIONS 11.4 と同じ形）。
    //
    // 突き合わせる（一致しなければ拒む）形も書けますが、**受け取らないほうが
    // 強い**です。渡す口が無ければ、食い違いは表現できません。
    // **本文は正規化しません**——保存する本文とハッシュの原像を同じにするためです。
    const resolved = args.artifacts.map((a) => {
      if (a.kind === "blob") {
        return {
          ordinal: a.ordinal,
          type: a.type,
          inlineContent: null,
          blobKey: a.blobKey as string,
          contentHash: a.contentHash as string,
          sizeBytes: a.sizeBytes,
        };
      }
      const bytes = Buffer.from(a.content, "utf8");
      return {
        ordinal: a.ordinal,
        type: a.type,
        inlineContent: a.content,
        blobKey: null,
        contentHash: attestContentHash(bytes) as string,
        sizeBytes: bytes.byteLength,
      };
    });

    // ordinal の連続性と hex の検査はここで落ちる。
    // 順序不正のまま黙ってハッシュを計算すると、DERIVATION_OUTPUT_STABLE が
    // 「不正な状態同士が一致した」ことを緑で報告する
    const digests = resolved.map((a) => ({
      artifactId: deriveArtifactId(key, a.ordinal),
      ordinal: a.ordinal,
      contentHash: a.contentHash as ContentHash,
    }));
    const computedHash = outputsHash(digests);

    // ロールバック後に書き直す観測。トランザクション内で書くと一緒に消える。
    // SQLite に自律トランザクションは無いので、順序で解決する（8節）
    let deferred: ObservationDraft | null = null;

    try {
      return this.#conn.transaction(() => {
        // 鍵・世代・名乗りの3つが揃わなければ通さない
        const lease = this.#liveLease(args.runId, args.workerId, key);
        if (!lease.ok) {
          deferred = this.#staleLeaseDraft({
            operation: "commitDerivation",
            runId: args.runId,
            workerId: args.workerId,
            row: lease.row,
            mismatch: lease.mismatch,
            expectedKey: key,
          });
          throw new StaleWorkerError(
            `commitDerivation: run ${args.runId} is not a live lease held by ${args.workerId} ` +
              `on derivation ${key}`,
          );
        }
        const runId = args.runId;

        // **原本は run が持っている。文書はその原本から引く。**
        // どちらも呼び出し側からは来ません（`DerivationDraft` に口がない）。
        // 文書を run の `document_id` から写さないのは、`claimRun` が導出した
        // 値を運ぶより、**その場で原本から引くほうが閉包が小さい**からです
        // （9節 軸1）。同一トランザクション内なので、引けば一意に決まります。
        const rootVersionId = str(lease.row["root_version_id"]) as VersionId;
        const origin = this.#conn.db
          .prepare("SELECT document_id FROM document_version WHERE version_id = ?")
          .get(rootVersionId) as Row | undefined;
        if (origin === undefined) {
          // run が指す版が消えている。FK があるので通常は起こらない
          throw new InvalidArgumentError(
            `run ${runId} references version ${rootVersionId}, which does not exist`,
          );
        }
        const documentId = str(origin["document_id"]) as DocumentId;

        // ⑥の入力辺は鍵の一致だけでは守れない。確定と同じスナップショットで検査する。
        assertNormalizationCommit(this.#conn, args.derivation, args.artifacts, rootVersionId);

        const existing = this.#conn.db
          .prepare("SELECT artifact_count, outputs_hash FROM derivation WHERE derivation_key = ?")
          .get(key) as Row | undefined;

        if (existing !== undefined) {
          const sameHash = str(existing["outputs_hash"]) === computedHash;
          const sameCount = num(existing["artifact_count"]) === args.artifacts.length;
          if (!sameHash || !sameCount) {
            const stored = str(existing["outputs_hash"]);
            const storedCount = num(existing["artifact_count"]);
            deferred = {
              kind: "derivation_output_divergence",
              documentId,
              runId,
              detail: {
                derivationKey: key,
                storedOutputsHash: stored,
                storedArtifactCount: storedCount,
                incomingOutputsHash: computedHash,
                incomingArtifactCount: args.artifacts.length,
              },
            };
            // 無言でスキップしない。「存在するから正しい」とは扱わない（#10, #11）
            throw new DerivationDivergenceError(
              `derivation ${key} already exists with different outputs ` +
                `(stored ${stored} x${storedCount}, incoming ${computedHash} x${args.artifacts.length})`,
            );
          }
          // 冪等な no-op。run だけ閉じる
          this.#succeedRun(runId);
          return { created: false, derivationKey: key };
        }

        const now = this.#conn.clock.now();
        this.#conn.db
          .prepare(
            `INSERT INTO derivation
               (derivation_key, processor_name, processor_version, config_hash, input_ids,
                root_version_id, document_id, created_at, artifact_count, outputs_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            key,
            args.derivation.processorName,
            args.derivation.processorVersion,
            args.derivation.configHash,
            JSON.stringify([...args.derivation.inputIds].map(String).sort()),
            rootVersionId,
            documentId,
            now,
            args.artifacts.length,
            computedHash,
          );

        // 書くのは `resolved` の値です。inline の hash / size はそこで
        // 本文から導出されており、`outputsHash` に入ったものと同じ値です
        for (const [index, artifact] of resolved.entries()) {
          this.#conn.db
            .prepare(
              `INSERT INTO artifact
                 (artifact_id, derivation_key, ordinal, document_id, root_version_id, type,
                  inline_content, blob_key, content_hash, size_bytes, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              digests[index]!.artifactId,
              key,
              artifact.ordinal,
              documentId,
              rootVersionId,
              artifact.type,
              artifact.inlineContent,
              artifact.blobKey,
              artifact.contentHash,
              artifact.sizeBytes,
              now,
            );
        }

        this.#succeedRun(runId);
        return { created: true, derivationKey: key };
      });
    } catch (error) {
      // ここは既にロールバック済み。新しいトランザクションで記録してから投げ直す。
      // 「分岐が起きたのに記録が無い」「拒否したのに記録が無い」を作らないため
      if (deferred !== null) {
        try {
          await this.appendObservation(deferred);
        } catch (writeError) {
          // **監査の失敗で例外の型を変えません。** 呼び出し側の再試行判断は
          // code に依存しているので、ここで型が化けると「分岐が起きた」が
          // 「一時的な書き込みエラー」に見え、そのまま再試行されます。
          // 記録が消えうることは受け入れた制約ですが（KNOWN_LIMITATIONS 9節）、
          // 記録が消えたうえに例外まで化けるのは別の話です
          if (error instanceof StoreError) error.observationWriteError = writeError;
        }
      }
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // ACL / 診断
  // --------------------------------------------------------------------------

  /**
   * ACL を更新する。
   *
   * **取得失敗は既存 ACL を上書きしません（#29）。**
   * state が "unknown" で既存が "synced" なら principals は据え置き、
   * lastAttemptAt と lastError だけを更新します。
   * 空の principals を「制限なし」とも「全拒否」とも解釈させないための規則です。
   */
  async upsertAcl(acl: AclDraft): Promise<void> {
    if (acl.state === "unknown" && acl.principals.length > 0) {
      throw new InvalidArgumentError("an ACL in state 'unknown' must not carry principals");
    }

    return this.#conn.transaction(() => {
      const now = this.#conn.clock.now();
      const existing = this.#conn.db
        .prepare("SELECT state FROM access_control WHERE document_id = ? AND tenant_id = ?")
        .get(acl.documentId, acl.tenantId) as Row | undefined;

      // 比較を安定させるため昇順に正規化して保存する
      const principals = JSON.stringify([...acl.principals].sort());

      if (existing !== undefined && acl.state === "unknown" && str(existing["state"]) === "synced") {
        this.#conn.db
          .prepare(
            `UPDATE access_control SET last_attempt_at = ?, last_error = ?
              WHERE document_id = ? AND tenant_id = ?`,
          )
          .run(now, acl.lastError ?? null, acl.documentId, acl.tenantId);
        this.#observe({
          kind: "acl_fetch_failed",
          documentId: acl.documentId,
          detail: { tenantId: acl.tenantId, keptExistingSynced: true, error: acl.lastError ?? null },
        });
        return;
      }

      this.#conn.db
        .prepare(
          `INSERT INTO access_control
             (document_id, tenant_id, state, principals, classification, acl_hash,
              synced_at, last_attempt_at, last_error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (document_id, tenant_id) DO UPDATE SET
             state = excluded.state,
             principals = excluded.principals,
             classification = excluded.classification,
             acl_hash = excluded.acl_hash,
             synced_at = excluded.synced_at,
             last_attempt_at = excluded.last_attempt_at,
             last_error = excluded.last_error`,
        )
        .run(
          acl.documentId,
          acl.tenantId,
          acl.state,
          principals,
          acl.classification ?? null,
          acl.aclHash,
          acl.state === "synced" ? now : null,
          now,
          acl.lastError ?? null,
        );

      this.#observe({
        kind: acl.state === "synced" ? "acl_changed" : "acl_fetch_failed",
        documentId: acl.documentId,
        detail: { tenantId: acl.tenantId, state: acl.state },
      });
    });
  }

  /**
   * 走査対象に含まれない sourceId の active 文書を検出する（#24）。
   *
   * **1行も書きません。** 自動的な統合も tombstone もしません。
   * 誤爆すると元に戻せないので、人間の判断待ちにします（KNOWN_LIMITATIONS 3節）。
   */
  async findOrphanedSources(
    knownSourceIds: ReadonlyArray<SourceId>,
  ): Promise<ReadonlyArray<SourceId>> {
    return this.#conn.read(() => {
      const rows = this.#conn.db
        .prepare("SELECT DISTINCT source_id FROM document WHERE state = 'active'")
        .all() as Row[];
      const known = new Set<string>(knownSourceIds.map(String));
      return rows
        .map((r) => str(r["source_id"]) as SourceId)
        .filter((id) => !known.has(id))
        .sort();
    });
  }

  /** Artifact から原本までの系譜を1本引く（LINEAGE_COMPLETE の実地確認） */
  async traceToOrigin(artifactId: ArtifactId): Promise<{
    artifact: Artifact;
    derivation: Derivation;
    version: DocumentVersion;
    document: Document;
  }> {
    return this.#conn.read(() => {
      const artifact = this.#conn.db
        .prepare("SELECT * FROM artifact WHERE artifact_id = ?")
        .get(artifactId) as Row | undefined;
      if (artifact === undefined) {
        throw new InvalidArgumentError(`unknown artifactId: ${artifactId}`);
      }
      const derivation = this.#conn.db
        .prepare("SELECT * FROM derivation WHERE derivation_key = ?")
        .get(str(artifact["derivation_key"])) as Row | undefined;
      const version = this.#conn.db
        .prepare("SELECT * FROM document_version WHERE version_id = ?")
        .get(str(artifact["root_version_id"])) as Row | undefined;
      const document = this.#conn.db
        .prepare("SELECT * FROM document WHERE document_id = ?")
        .get(str(artifact["document_id"])) as Row | undefined;

      // 到達できないなら系譜が切れている。null を返さず失敗として表面化させる
      if (derivation === undefined || version === undefined || document === undefined) {
        throw new InvalidArgumentError(
          `lineage is broken for artifact ${artifactId}: ` +
            `derivation=${derivation !== undefined} version=${version !== undefined} document=${document !== undefined}`,
        );
      }

      return {
        artifact: toArtifact(artifact),
        derivation: toDerivation(derivation),
        version: toDocumentVersion(version),
        document: toDocument(document),
      };
    });
  }

  /**
   * blob 参照整合性の検査対象を列挙する（#30）。
   *
   * 実際の照合は呼び出し側が BlobStore で行います。ここは件数上限つきの
   * サンプリング列挙だけです。全件検証は数百万件規模で現実的でないため、
   * 別途バッチとして v0.2 以降に回します（KNOWN_LIMITATIONS 4節）。
   *
   * **列挙するのは version 参照と artifact 参照の両方です。**
   * 「参照がある」の定義は `BLOB_REFERENCE_CLOSURE` 1本で、削除述語も
   * 同じ定義を通します。片方だけを見る列挙を別に持つと、
   * **version 参照ゼロ・artifact 参照ありの鍵が「孤児」に見えます。**
   * `artifact` 行は残るので `NO_ORPHAN_ARTIFACT` は緑のまま、実体だけが消えます。
   *
   * **選択順序は `kind:ref_id` の昇順で固定し、継続位置を保持します。**
   * 順序が決まっていないと、DB の返す順に依存した「たまたまの並び」で
   * 毎回同じ行が返り、上限を超える部分が永久に検査されません。
   * サンプリングは「全件見ないこと」を認めた設計であって、
   * 「同じ一部だけを見続けること」を認めた設計ではありません。
   *
   * 継続位置はこのインスタンスが持ちます。`limit?: number` に足す形の
   * カーソル引数は `LineageStore` のシグネチャ変更になるため採りません。
   * 終端まで来たら先頭へ折り返します。
   *
   * **既知の制約**: 継続位置はプロセスをまたぎません。起動時チェックが
   * 毎回新しいインスタンスで走る運用では、常に先頭 limit 件だけが検査されます。
   * 位置を永続化するには判定関数が書き込む必要があり、それは
   * 「問い合わせただけで状態が変わる」ことになるので、ここでは選びません
   * （KNOWN_LIMITATIONS 4節）。
   *
   * `limit` の意味（1回あたりの件数か、全体の上限か）は STEP 3 の実消費者を
   * 見てから見直す前提です。現状は「1回の呼び出しで返す最大件数」です。
   */
  async *verifyBlobReferences(limit?: number): AsyncIterable<BlobReference> {
    const page = (after: string | null): Row[] =>
      this.#conn.read(() => {
        const cap = limit === undefined ? "" : ` LIMIT ${Math.max(0, Math.trunc(limit))}`;
        return this.#conn.db
          .prepare(
            `SELECT kind, ref_id, derivation_key, blob_key, content_hash
               FROM (${BLOB_REFERENCE_CLOSURE})
              WHERE ${REFERENCE_CURSOR} > ? ORDER BY ${REFERENCE_CURSOR}${cap}`,
          )
          .all(after ?? "") as Row[];
      });

    // 折り返しは1回だけ試す。空の表で無限に回らない
    let rows = page(this.#blobScanCursor);
    if (rows.length === 0 && this.#blobScanCursor !== null) {
      this.#blobScanCursor = null;
      rows = page(null);
    }

    for (const row of rows) {
      // 消費された分だけ進める。途中で打ち切られたら、その位置から次が始まる
      this.#blobScanCursor = `${str(row["kind"])}:${str(row["ref_id"])}`;
      yield toBlobReference(row);
    }
  }

  // --------------------------------------------------------------------------
  // 監査
  // --------------------------------------------------------------------------

  /**
   * 監査記録の追記。
   *
   * observationId と occurredAt はここで付けます。引数には無いので、
   * 呼び出し側が時刻を持ち込む経路がありません。
   *
   * 既にトランザクションの内側なら、それに参加します。
   * finishScan のように「状態変更と観測を同一トランザクションで書く」場面が
   * あるためで、ここで独自にトランザクションを張ると分離してしまいます。
   */
  // async にしてあるのは、同期 throw を呼び出し側の .catch() で捕まえられない
  // API にしないため。Promise を返すと宣言した以上、失敗は必ず reject で出す
  async appendObservation(draft: ObservationDraft): Promise<void> {
    if (this.#conn.inTransaction()) this.#observe(draft);
    else this.#conn.transaction(() => this.#observe(draft));
  }

  // --------------------------------------------------------------------------
  // 内部
  // --------------------------------------------------------------------------

  /** トランザクション内から呼ぶ同期版。await を挟まないための分離 */
  #observe(draft: ObservationDraft): void {
    this.#conn.db
      .prepare(
        `INSERT INTO observation
           (observation_id, kind, document_id, version_id, scan_id, run_id, occurred_at, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.#conn.newEventId(),
        draft.kind,
        draft.documentId ?? null,
        draft.versionId ?? null,
        draft.scanId ?? null,
        draft.runId ?? null,
        this.#conn.clock.now(),
        JSON.stringify(draft.detail),
      );
  }

  /**
   * 復活した文書に紐づく確定済みリネームを差し戻す（#25）。
   * 再確認のワークフローは v0.1 では作りません（KNOWN_LIMITATIONS 3節）。
   */
  #recheckRenames(docId: string, scanId: ScanId): void {
    const affected = this.#conn.db
      .prepare(
        `SELECT disappeared_document_id, appeared_document_id FROM rename_candidate
          WHERE resolution = 'confirmed_rename'
            AND (disappeared_document_id = ? OR appeared_document_id = ?)`,
      )
      .all(docId, docId) as Row[];

    if (affected.length === 0) return;

    this.#conn.db
      .prepare(
        `UPDATE rename_candidate SET resolution = 'needs_recheck'
          WHERE resolution = 'confirmed_rename'
            AND (disappeared_document_id = ? OR appeared_document_id = ?)`,
      )
      .run(docId, docId);

    this.#observe({
      kind: "rename_needs_recheck",
      documentId: docId as DocumentId,
      scanId,
      detail: { candidates: affected.length },
    });
  }

  #loadPolicy(sourceId: SourceId): KeyNormalizationPolicy {
    const row = this.#conn.db
      .prepare(
        `SELECT key_unicode_form, key_case_fold, key_path_separator, key_trim_slashes
           FROM source WHERE source_id = ?`,
      )
      .get(sourceId) as Row | undefined;
    if (row === undefined) throw new InvalidArgumentError(`unknown sourceId: ${sourceId}`);
    return {
      unicodeForm: str(row["key_unicode_form"]) as KeyNormalizationPolicy["unicodeForm"],
      caseFold: num(row["key_case_fold"]) === 1,
      pathSeparator: str(row["key_path_separator"]) as KeyNormalizationPolicy["pathSeparator"],
      trimSlashes: num(row["key_trim_slashes"]) === 1,
    };
  }

  #loadScan(scanId: ScanId): ScanRun {
    const row = this.#conn.db.prepare("SELECT * FROM scan_run WHERE scan_id = ?").get(scanId) as
      | Row
      | undefined;
    if (row === undefined) throw new InvalidArgumentError(`unknown scanId: ${scanId}`);
    return toScanRun(row);
  }
}

function assertCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidCountsError(`${label} must be a non-negative integer, got ${value}`);
  }
}

function assertBp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 10000) {
    throw new InvalidArgumentError(
      `${label} must be an integer between 0 and 10000 (basis points), got ${value}`,
    );
  }
}

export function toArtifact(row: Row): Artifact {
  const has = (key: string): boolean => row[key] !== null && row[key] !== undefined;
  return {
    artifactId: str(row["artifact_id"]) as ArtifactId,
    derivationKey: str(row["derivation_key"]) as DerivationKey,
    ordinal: num(row["ordinal"]),
    documentId: str(row["document_id"]) as DocumentId,
    rootVersionId: str(row["root_version_id"]) as VersionId,
    type: str(row["type"]) as Artifact["type"],
    ...(has("inline_content") ? { inlineContent: str(row["inline_content"]) } : {}),
    ...(has("blob_key") ? { blobKey: str(row["blob_key"]) as BlobKey } : {}),
    contentHash: str(row["content_hash"]) as ContentHash,
    sizeBytes: num(row["size_bytes"]),
    createdAt: num(row["created_at"]) as EpochMs,
  };
}

export function toDerivation(row: Row): Derivation {
  return {
    derivationKey: str(row["derivation_key"]) as DerivationKey,
    processorName: str(row["processor_name"]),
    processorVersion: str(row["processor_version"]),
    configHash: str(row["config_hash"]),
    inputIds: JSON.parse(str(row["input_ids"])) as ReadonlyArray<string>,
    rootVersionId: str(row["root_version_id"]) as VersionId,
    documentId: str(row["document_id"]) as DocumentId,
    createdAt: num(row["created_at"]) as EpochMs,
    artifactCount: num(row["artifact_count"]),
    outputsHash: str(row["outputs_hash"]),
  };
}

export function toDocumentVersion(row: Row): DocumentVersion {
  const has = (key: string): boolean => row[key] !== null && row[key] !== undefined;
  return {
    versionId: str(row["version_id"]) as VersionId,
    documentId: str(row["document_id"]) as DocumentId,
    contentHash: str(row["content_hash"]) as ContentHash,
    sizeBytes: num(row["size_bytes"]),
    blobKey: str(row["blob_key"]) as BlobKey,
    blobVerifiedAt: num(row["blob_verified_at"]) as EpochMs,
    mimeType: str(row["mime_type"]),
    ...(has("source_modified_at")
      ? { sourceModifiedAt: num(row["source_modified_at"]) as EpochMs }
      : {}),
    ingestedAt: num(row["ingested_at"]) as EpochMs,
    discoveredByScanId: str(row["discovered_by_scan_id"]) as ScanId,
    pipelineVersion: str(row["pipeline_version"]),
  };
}

export function toProcessingRun(row: Row): ProcessingRun {
  const has = (key: string): boolean => row[key] !== null && row[key] !== undefined;
  const at = (key: string) => num(row[key]) as EpochMs;
  return {
    runId: str(row["run_id"]) as RunId,
    derivationKey: str(row["derivation_key"]) as DerivationKey,
    documentId: str(row["document_id"]) as DocumentId,
    rootVersionId: str(row["root_version_id"]) as VersionId,
    status: str(row["status"]) as ProcessingRun["status"],
    attempt: num(row["attempt"]),
    ...(has("worker_id") ? { workerId: str(row["worker_id"]) as WorkerId } : {}),
    ...(has("started_at") ? { startedAt: at("started_at") } : {}),
    ...(has("heartbeat_at") ? { heartbeatAt: at("heartbeat_at") } : {}),
    ...(has("lease_expires_at") ? { leaseExpiresAt: at("lease_expires_at") } : {}),
    ...(has("finished_at") ? { finishedAt: at("finished_at") } : {}),
    ...(has("error_kind") ? { errorKind: str(row["error_kind"]) } : {}),
    ...(has("error_message") ? { errorMessage: str(row["error_message"]) } : {}),
    ...(has("permanent") ? { permanent: num(row["permanent"]) === 1 } : {}),
  };
}

export function toDocument(row: Row): Document {
  const has = (key: string): boolean => row[key] !== null && row[key] !== undefined;
  return {
    documentId: str(row["document_id"]) as DocumentId,
    sourceId: str(row["source_id"]) as SourceId,
    stableKey: str(row["stable_key"]),
    state: str(row["state"]) as Document["state"],
    ...(has("active_version_id")
      ? { activeVersionId: str(row["active_version_id"]) as VersionId }
      : {}),
    firstSeenAt: num(row["first_seen_at"]) as Document["firstSeenAt"],
    lastSeenAt: num(row["last_seen_at"]) as Document["lastSeenAt"],
    lastSeenScanId: str(row["last_seen_scan_id"]) as ScanId,
    ...(has("last_fingerprint") ? { lastFingerprint: str(row["last_fingerprint"]) } : {}),
    ...(has("last_fingerprint_at")
      ? { lastFingerprintAt: num(row["last_fingerprint_at"]) as Document["firstSeenAt"] }
      : {}),
    ...(has("tombstoned_at")
      ? { tombstonedAt: num(row["tombstoned_at"]) as Document["firstSeenAt"] }
      : {}),
  };
}

export function toScanRun(row: Row): ScanRun {
  const optional = <T>(key: string, map: (v: unknown) => T): T | undefined =>
    row[key] === null || row[key] === undefined ? undefined : map(row[key]);

  const approvedAt = optional("approved_at", num);

  return {
    scanId: str(row["scan_id"]) as ScanRun["scanId"],
    sourceId: str(row["source_id"]) as ScanRun["sourceId"],
    startedAt: num(row["started_at"]) as ScanRun["startedAt"],
    ...(optional("finished_at", num) === undefined
      ? {}
      : { finishedAt: num(row["finished_at"]) as ScanRun["startedAt"] }),
    status: str(row["status"]) as ScanRun["status"],
    enumeratedCount: num(row["enumerated_count"]),
    distinctCount: num(row["distinct_count"]),
    ...(optional("previous_completed_scan_id", str) === undefined
      ? {}
      : { previousCompletedScanId: str(row["previous_completed_scan_id"]) as ScanRun["scanId"] }),
    previousDistinctCount: num(row["previous_distinct_count"]),
    countRatioThresholdBp: num(row["count_ratio_threshold_bp"]),
    missingRatioThresholdBp: num(row["missing_ratio_threshold_bp"]),
    writeFailureCount: num(row["write_failure_count"]),
    ...(approvedAt === undefined
      ? {}
      : {
          approvedByOperator: {
            approvedAt: approvedAt as ScanRun["startedAt"],
            note: str(row["approved_note"]),
            maxMissingCount: num(row["approved_max_missing_count"]),
          },
        }),
    ...(optional("completion_seq", num) === undefined
      ? {}
      : { completionSeq: num(row["completion_seq"]) }),
    ...(optional("abort_reason", str) === undefined
      ? {}
      : { abortReason: str(row["abort_reason"]) }),
    ...(optional("deletion_state", str) === undefined
      ? {}
      : { deletionState: str(row["deletion_state"]) as DeletionState }),
  };
}
