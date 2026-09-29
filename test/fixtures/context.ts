/**
 * 敵対フィクスチャの共通文脈。
 *
 * FIXTURES.md の委譲仕様が要求する3つの export（`setup` / `execute` / `assertions`）を
 * 受け取る側です。ランナーは各フィクスチャに真新しいメモリ DB と固定時計を渡し、
 * `execute` の後に必ず invariant-checker を走らせます。
 *
 * ## 設計の要点
 *
 * **状態の読み取りは生の SQL です。** `ctx.rows` / `ctx.one` / `ctx.count` は
 * `LineageStore` を経由しません。ストアのバグをストア自身の関数で検証すると、
 * 同じ誤解が2回起きたときに緑になります（invariant-checker と同じ理由）。
 * 逆に「攻撃」の側はストアの API を通します。攻撃者に見えるのは API だけだからです。
 *
 * **時刻は必ず `ctx.clock` です。** 実時間に依存するフィクスチャは、
 * CI の負荷で結果が変わります。`Date.now()` は AC-CLK-02 が禁じています。
 *
 * **再実行の前後は `ctx.declareReplay` で宣言します。** 宣言しないまま
 * `IDEMPOTENT_REPLAY` を `assertions` に挙げると、invariant-checker が
 * `not_checked` を返してランナーが落ちます。「検証しなかった」を
 * 「違反がなかった」と数えないためです（AGENTS.md 3.7）。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attestContentHash } from "../../src/domain/evidence.ts";

import { openStore, type StoreConnection } from "../../src/store/sqlite/connection.ts";
import { SqliteLineageStore } from "../../src/store/sqlite/lineage-store.ts";
import { TestClock } from "../support/clock.ts";
import { snapshotState, type SnapshotReader, type StateSnapshot } from "../support/state-snapshot.ts";
import { CrashInjector, type CrashSpec } from "../support/crash-injecting-store.ts";
import { FileBlobStore } from "../../src/store/blob/file-blob-store.ts";
import { configHashVectorResults } from "../support/config-hash-vectors.ts";
import type {
  BlobKey,
  ContentHash,
  VerifiedAt,
  VerifiedContentHash,
  DocumentId,
  InvariantName,
  KeyNormalizationPolicy,
  ObservationKind,
  ScanId,
  SourceId,
  VersionId,
} from "../../src/domain/types.ts";

// ----------------------------------------------------------------------------
// フィクスチャの形
// ----------------------------------------------------------------------------

export interface Fixture {
  /** 初期状態を作る。ここでの失敗は攻撃の失敗ではなく前提の失敗 */
  setup(ctx: FixtureContext): Promise<void>;
  /** 攻撃を実行し、シナリオ固有の検証を行う */
  execute(ctx: FixtureContext): Promise<void>;
  /** ランナーが検証する不変条件。宣言したものが not_checked なら落ちる */
  readonly assertions: ReadonlyArray<InvariantName>;
  /**
   * v0.1 で実装しない理由。設定すると `it.skip` になる。
   * KNOWN_LIMITATIONS.md の該当節を書くこと。
   */
  readonly deferred?: string;
  /**
   * **実行後に成立していないことが正しい不変条件。**
   *
   * FIXTURES.md の委譲仕様に対する4つ目の export です（オーナー承認済み）。
   *
   * ## 使ってよい条件（1つだけ。増やさないこと）
   *
   * **破れた不変条件が「世界についての主張」であって、
   * 「ストアについての主張」でない場合だけ**です。
   *
   * 唯一の例が #11 です。`DERIVATION_OUTPUT_STABLE` の定義は
   * `derivation_output_divergence_count == 0`。分岐が実際に起きた以上
   * 「世界が決定的だった」という主張は**本当に偽**です。
   * ストアのほうは正しく検出して拒んでいます。
   *
   * **ストアの欠陥に使った瞬間、この仕組みは消音ボタンになります。**
   * ストアが守るべきものを守れていないなら、それは修正すべきバグであって、
   * 宣言して緑にするものではありません。判断に迷ったら使わずに報告してください。
   * **2件目が出たらオーナーに上げること。** 1件で済んでいるうちは、
   * これは #11 のための例外であって、仕組みではありません。
   *
   * ## ランナーの扱い
   *
   * 緩めとしてではなく**追加の要求**として扱われます。
   *   - 宣言した違反が**実際に起きていなければ落ちます**（空振り防止）
   *   - 宣言していない違反は今まで通り落とします
   *   - 対象の不変条件は `assertions` にも入っていなければなりません
   */
  readonly expectedViolations?: ReadonlyArray<{
    readonly invariant: InvariantName;
    /** invariant-checker が返す `Finding.problem` の値と完全一致すること */
    readonly problem: string;
    /**
     * **なぜこれが「世界についての主張」なのか。**
     *
     * 必須です。理由を書けないなら、それはストアの欠陥を黙らせようとしています。
     */
    readonly reason: string;
  }>;
}

// ----------------------------------------------------------------------------
// 既定値
// ----------------------------------------------------------------------------

/** 走査の既定閾値。0.90 と 0.10 は AGENTS.md 3.5 の例 */
export const DEFAULT_THRESHOLDS = {
  countRatioThresholdBp: 9000,
  missingRatioThresholdBp: 1000,
} as const;

export const DEFAULT_POLICY: KeyNormalizationPolicy = {
  unicodeForm: "NFC",
  caseFold: false,
  pathSeparator: "posix",
  trimSlashes: true,
};

const PIPELINE_VERSION = "v0.1";

// ----------------------------------------------------------------------------
// 文脈
// ----------------------------------------------------------------------------

export interface IngestResult {
  documentId: DocumentId;
  versionId: VersionId;
  contentHash: ContentHash;
}

/**
 * 実際に置いた blob。version 行に必要な4つをまとめて返す。
 *
 * **鍵も証拠も BlobStore が出したものです。** 以前はここを
 * `blobKeyOf(hash)` と `attestPersisted(clock.now(), hash)` で組み立てていました。
 * 形は同じですが**実体がどこにも無い**ので、`HASH_MATCHES_BLOB` を
 * 検証しようとすると全フィクスチャが偽になります。
 */
export interface FixtureBlob {
  readonly blobKey: BlobKey;
  readonly contentHash: VerifiedContentHash;
  readonly blobVerifiedAt: VerifiedAt;
  readonly sizeBytes: number;
}

export interface FixtureContext {
  readonly clock: TestClock;
  readonly conn: StoreConnection;
  readonly store: SqliteLineageStore;
  readonly reader: SnapshotReader;
  /** 実物の BlobStore。invariant-checker にそのまま渡せる（HASH_MATCHES_BLOB） */
  readonly blobs: FileBlobStore;
  /** blob の置き場所。フィクスチャが手で実体を触るときに使う（#8） */
  readonly blobRoot: string;
  /**
   * `canonicalConfigHash` の凍結ベクタと**実測値**。既定で入っています。
   *
   * `declareReplay` のような宣言制にしていません。この不変条件だけは
   * フィクスチャが作る状態に依存しないので、宣言制にすると
   * **宣言していないフィクスチャでは `not_checked` のまま静かに素通りします。**
   * `blobs` を常に渡しているのと同じ理由です（AGENTS.md 3.7）。
   */
  readonly configHashVectors: ReadonlyArray<{
    readonly label: string;
    readonly expected: string;
    readonly actual: string;
  }>;

  // --- 状態の読み取り（生 SQL） ---
  rows<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  one<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined;
  /** `count("document WHERE state='active'")` の形で使う */
  count(fromAndWhere: string, ...params: unknown[]): number;
  /** observation_seq 昇順の kind 列。**順序は seq で決まる**（observationId は整列不能） */
  observationOrder(): string[];
  observationCount(kind: ObservationKind, documentId?: string): number;
  /** 指定 kind の observation の detail を古い順に返す */
  observationDetails(kind: ObservationKind): Record<string, unknown>[];

  // --- 組み立て ---
  addSource(sourceId: string, policy?: Partial<KeyNormalizationPolicy>): SourceId;
  hashOf(text: string): VerifiedContentHash;
  /**
   * バイト列を実際に置いて、version 行に必要な4つを返す。
   *
   * `hashOf` と違い、**戻り値は実体の存在を伴います。**
   * version 行を直接組み立てるフィクスチャはこちらを使ってください。
   */
  putBlob(text: string): Promise<FixtureBlob>;
  /**
   * 走査ループの縮図。**blob を置いてから**観測 → 版 → ポインタを1件分行う。
   *
   * 置く順序が先なのは「版は接続元に実在したバイト列に立つ」ためです
   * （KNOWN_LIMITATIONS 11.2）。実体の無い版が書けると
   * `NO_VERSION_WITHOUT_VERIFIED_BLOB` は通るのに `HASH_MATCHES_BLOB` が偽になります。
   */
  ingest(scanId: ScanId, stableKey: string, text: string): Promise<IngestResult>;
  /** 版を作らずに観測だけ行う。読めなかった・サイズが合わなかった枝の再現用 */
  observeOnly(
    scanId: ScanId,
    stableKey: string,
    outcome: Parameters<SqliteLineageStore["recordObservedDocument"]>[1]["outcome"],
    quickFingerprint?: string,
  ): Promise<DocumentId>;

  // --- 再実行 ---
  snapshot(): Promise<StateSnapshot>;
  /**
   * 再実行の前後を宣言する。IDEMPOTENT_REPLAY と NO_WORK_WITHOUT_CHANGE の入力。
   * 宣言しないままこの2つを assertions に挙げると、ランナーが落ちる。
   */
  declareReplay(before: StateSnapshot, after: StateSnapshot): void;
  /**
   * 走査対象の sourceId を宣言する。SINGLE_ACTIVE_VERSION の孤児検出（#24）が有効になる。
   * 宣言しなければ孤児検出は走らない（#24 のフィクスチャ自身が別途検証する）。
   */
  declareKnownSources(sourceIds: ReadonlyArray<SourceId>): void;

  // --- クラッシュ注入 ---
  /** 接続層に注入する。ランナーが後片付けするので restore を書く必要はない */
  crash(spec: CrashSpec): CrashInjector;
}

/** ランナーだけが読む部分 */
export interface FixtureRun extends FixtureContext {
  readonly replay: { before: StateSnapshot; after: StateSnapshot } | undefined;
  readonly knownSourceIds: ReadonlyArray<SourceId> | undefined;
  close(): void;
}

export function createFixtureContext(startAt = 1_700_000_000_000): FixtureRun {
  const clock = new TestClock(startAt);
  const conn = openStore({ clock });
  const store = new SqliteLineageStore(conn);
  // フィクスチャごとに真新しい置き場所。close() で消す
  const blobRoot = mkdtempSync(join(tmpdir(), "fixture-blob-"));
  const blobs = new FileBlobStore({ root: blobRoot, clock });
  const injectors: CrashInjector[] = [];

  let replay: { before: StateSnapshot; after: StateSnapshot } | undefined;
  let knownSourceIds: ReadonlyArray<SourceId> | undefined;

  const rows = <T>(sql: string, ...params: unknown[]): T[] =>
    conn.db.prepare(sql).all(...(params as never[])) as T[];
  const one = <T>(sql: string, ...params: unknown[]): T | undefined =>
    conn.db.prepare(sql).get(...(params as never[])) as T | undefined;

  const ctx: FixtureRun = {
    clock,
    conn,
    store,
    blobs,
    blobRoot,
    configHashVectors: configHashVectorResults(),
    reader: { all: (sql: string) => Promise.resolve(rows<Record<string, unknown>>(sql)) },

    rows,
    one,
    count(fromAndWhere, ...params) {
      return (
        one<{ n: number }>(`SELECT count(*) AS n FROM ${fromAndWhere}`, ...params) ?? { n: -1 }
      ).n;
    },
    observationOrder() {
      return rows<{ kind: string }>("SELECT kind FROM observation ORDER BY observation_seq").map(
        (r) => r.kind,
      );
    },
    observationCount(kind, documentId) {
      return documentId === undefined
        ? ctx.count("observation WHERE kind=?", kind)
        : ctx.count("observation WHERE kind=? AND document_id=?", kind, documentId);
    },
    observationDetails(kind) {
      return rows<{ detail: string }>(
        "SELECT detail FROM observation WHERE kind=? ORDER BY observation_seq",
        kind,
      ).map((r) => JSON.parse(r.detail) as Record<string, unknown>);
    },

    addSource(sourceId, policy = {}) {
      const merged = { ...DEFAULT_POLICY, ...policy };
      conn.db
        .prepare(
          `INSERT INTO source (source_id, kind, config_hash, display_name,
             key_unicode_form, key_case_fold, key_path_separator, key_trim_slashes)
           VALUES (?, 'local-fs', 'cfg', ?, ?, ?, ?, ?)`,
        )
        .run(
          sourceId,
          sourceId,
          merged.unicodeForm,
          merged.caseFold ? 1 : 0,
          merged.pathSeparator,
          merged.trimSlashes ? 1 : 0,
        );
      return sourceId as SourceId;
    },

    hashOf(text) {
      // 実バイト列を読んで計算する。宣言値ではなく証拠
      return attestContentHash(Buffer.from(text, "utf8"));
    },

    async putBlob(text) {
      const bytes = Buffer.from(text, "utf8");
      const result = await blobs.put(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        bytes.byteLength,
      );
      return {
        blobKey: result.blobKey,
        contentHash: result.contentHash,
        blobVerifiedAt: result.verifiedAt,
        sizeBytes: result.sizeBytes,
      };
    },

    async ingest(scanId, stableKey, text) {
      // 先に実体を置く。版は接続元に実在したバイト列に立つ
      const blob = await ctx.putBlob(text);
      const contentHash = blob.contentHash;
      const observed = await store.recordObservedDocument(scanId, {
        stableKey,
        outcome: { kind: "content", contentHash, sizeBytes: blob.sizeBytes },
      });
      const version = await store.insertVersionIfAbsent({
        documentId: observed.documentId,
        contentHash,
        sizeBytes: blob.sizeBytes,
        blobKey: blob.blobKey,
        blobVerifiedAt: blob.blobVerifiedAt,
        mimeType: "text/plain",
        discoveredByScanId: scanId,
        pipelineVersion: PIPELINE_VERSION,
      });
      // created の値に関わらず必ず呼ぶ。created を「変更なし」の根拠にしない（#15）
      await store.setActiveVersion({
        documentId: observed.documentId,
        observedHash: contentHash,
        versionId: version.versionId,
        scanId,
      });
      return { documentId: observed.documentId, versionId: version.versionId, contentHash };
    },

    async observeOnly(scanId, stableKey, outcome, quickFingerprint) {
      const result = await store.recordObservedDocument(scanId, {
        stableKey,
        ...(quickFingerprint === undefined ? {} : { quickFingerprint }),
        outcome,
      });
      return result.documentId;
    },

    snapshot: () => snapshotState(ctx.reader),
    declareReplay(before, after) {
      replay = { before, after };
    },
    declareKnownSources(ids) {
      knownSourceIds = ids;
    },

    crash(spec) {
      const injector = new CrashInjector(conn).arm(spec);
      injectors.push(injector);
      return injector;
    },

    get replay() {
      return replay;
    },
    get knownSourceIds() {
      return knownSourceIds;
    },

    close() {
      // 注入を戻してから閉じる。戻し忘れた接続は次のテストを汚染する
      for (const injector of injectors) injector.restore();
      conn.close();
      rmSync(blobRoot, { recursive: true, force: true });
    },
  };

  return ctx;
}
