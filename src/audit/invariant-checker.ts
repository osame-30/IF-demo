/**
 * INVARIANTS 全項目の一括検証。
 *
 * 設計の要点は「検証できなかったものを合格として数えない」ことです。
 * 入力が足りない項目は `not_checked` になり、フィクスチャがその項目を
 * 宣言していれば assertInvariants が落とします。
 * 「チェックが走らなかった」を「違反がなかった」と混同するのは、
 * このプロジェクトが最も嫌う「存在する＝正しい」と同じ誤りです（AGENTS.md 3.7）。
 *
 * SQL は SQLite で動かすが PostgreSQL 互換に保つ（AGENTS.md 6節）。
 * ストアの実装を経由せず生の表を直接読むのは、ストア自身のバグを
 * ストア自身の関数で検証する循環を避けるためです。
 */

import { createHash } from "node:crypto";

import { INVARIANTS } from "../domain/types.ts";
import type {
  BlobKey,
  ContentHash,
  InvariantName,
  SourceId,
} from "../domain/types.ts";
import type { SnapshotReader, StateSnapshot } from "./state-snapshot.ts";
import { diffSnapshots, isEmptyDiff, formatDiff } from "./state-snapshot.ts";

// ----------------------------------------------------------------------------
// 結果の型
// ----------------------------------------------------------------------------

export type InvariantStatus = "ok" | "violated" | "not_checked";

export interface Finding {
  /** 違反の種類。SQL 側の problem 列と対応する */
  readonly problem: string;
  /** 対象の ID（documentId / versionId / derivationKey など） */
  readonly subject: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface InvariantResult {
  readonly name: InvariantName;
  readonly status: InvariantStatus;
  /** not_checked のときに必ず入る。何が足りなかったか */
  readonly reason?: string;
  readonly findings: ReadonlyArray<Finding>;
}

/**
 * 不変条件15項目には含まれないが、型でも実行時テストでも守れない構造的な前提。
 * AGENTS.md 7節が「省略しないでください」と書いている2本のインデックスは
 * ここで存在そのものを確かめる。無ければ #1 と #12 の防御が丸ごと消えるため。
 */
export interface SchemaGuardResult {
  readonly name: string;
  readonly status: InvariantStatus;
  readonly reason?: string;
  readonly findings: ReadonlyArray<Finding>;
}

export interface InvariantReport {
  readonly results: ReadonlyArray<InvariantResult>;
  readonly schemaGuards: ReadonlyArray<SchemaGuardResult>;
}

// ----------------------------------------------------------------------------
// 入力
// ----------------------------------------------------------------------------

/** BlobStore.verify と同じ形。実物の BlobStore をそのまま渡せる */
export interface BlobVerifier {
  verify(key: BlobKey, expectedHash: ContentHash): Promise<boolean>;
}

export interface CheckContext {
  readonly reader: SnapshotReader;

  /** 渡すと HASH_MATCHES_BLOB を検証する */
  readonly blobs?: BlobVerifier;

  /** 渡すと IDEMPOTENT_REPLAY と NO_WORK_WITHOUT_CHANGE を検証する */
  readonly replay?: { readonly before: StateSnapshot; readonly after: StateSnapshot };

  /** 渡すと SINGLE_ACTIVE_VERSION の一部として孤児 source を検出する（#24） */
  readonly knownSourceIds?: ReadonlyArray<SourceId>;

  /**
   * 渡すと CANONICAL_KEY_STABILITY を検証する。
   * `keys/config-hash-test-vectors.ts` が固定値ベクタを持ち、ここへ結果を渡す。
   */
  readonly configHashVectors?: ReadonlyArray<{
    readonly label: string;
    readonly expected: string;
    readonly actual: string;
  }>;

  /** HASH_MATCHES_BLOB を検証する件数の上限。既定は全件 */
  readonly blobSampleLimit?: number;
}

// ----------------------------------------------------------------------------
// 独立再実装（domain と意図的に別実装にしている）
// ----------------------------------------------------------------------------

/**
 * outputsHash の再計算。
 *
 * 凍結仕様: sha256("out:" + (artifactId + ":" + contentHash) を ordinal 順に \x00 で連結)
 *
 * `src/domain/ids.ts` の実装を import せず、ここで独立に計算します。
 * ストアが書いた値をストア自身の関数で検算しても何も証明できないためです。
 * 両者は同じ凍結ベクタで別々に検証されており、食い違えば人間が判断する材料になります。
 *
 * Artifact が0件の Derivation の outputsHash は sha256("out:") です。
 * v0.1 は Artifact を1件も作らないため、実際に通るのはこの経路だけです。
 */
function recomputeOutputsHash(
  entries: ReadonlyArray<{ artifactId: string; contentHash: string }>,
): string {
  const preimage = `out:${entries.map((e) => `${e.artifactId}:${e.contentHash}`).join("\u0000")}`;
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

/** UTF-8 バイト列の昇順。UTF-16 のコード単位順とは補助面で食い違う */
function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * derivationKey の再導出。
 *
 * 凍結仕様: sha256("der:" + F(processorName) + F(processorVersion) + F(configHash)
 *           + <要素数の10進> + ":" + sortedInputIds.map(F).join(""))
 *           F(s) = <s の UTF-8 バイト長の10進> + ":" + s（長さ前置。区切り文字は使わない）
 *
 * これも `src/domain/ids.ts` を import せず独立に持ちます。
 * **ストアが書いた鍵をストア自身の関数で検算しても何も証明できません。**
 * ここが独立していないと、簡略式で鍵を作るテストと、その簡略式で検算する
 * checker が自己整合し、`IDEMPOTENT_REPLAY` が「実導出経路を一度も
 * 通らずに緑」になります。
 */
function recomputeDerivationKey(materials: {
  processorName: string;
  processorVersion: string;
  configHash: string;
  sortedInputIds: ReadonlyArray<string>;
}): string {
  // ids.ts とは独立に持ちます。同じ規則を、こちら側の言葉で書き下したものです
  const f = (v: string): string => `${String(Buffer.byteLength(v, "utf8"))}:${v}`;
  const preimage =
    "der:" +
    f(materials.processorName) +
    f(materials.processorVersion) +
    f(materials.configHash) +
    `${String(materials.sortedInputIds.length)}:` +
    materials.sortedInputIds.map(f).join("");
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

export interface StoredKeyPolicy {
  unicodeForm: "NFC" | "NFD" | "none";
  caseFold: boolean;
  pathSeparator: "posix" | "as-is";
  trimSlashes: boolean;
}

/**
 * stableKey の正規化。#23（NFD/NFC と大文字小文字）の衝突検出に使います。
 *
 * これも domain 実装を import せず独立に持ちます。
 * 2つの document 行が同じ正規化結果になるなら、documentId の導出が
 * ポリシーを適用していなかったということです。
 */
function normalizeStableKey(key: string, policy: StoredKeyPolicy): string {
  let out = key;
  if (policy.pathSeparator === "posix") out = out.replace(/\\/g, "/");
  if (policy.trimSlashes) out = out.replace(/^\/+/, "").replace(/\/+$/, "");
  if (policy.unicodeForm !== "none") out = out.normalize(policy.unicodeForm);
  if (policy.caseFold) {
    out = out.toLowerCase();
    // 畳み込みが正規化形を崩すことがあるので、もう一度正規化する
    if (policy.unicodeForm !== "none") out = out.normalize(policy.unicodeForm);
  }
  return out;
}

// ----------------------------------------------------------------------------
// SQL 実行の小道具
// ----------------------------------------------------------------------------

type Rows = ReadonlyArray<Record<string, unknown>>;

/** problem / subject 列を持つ検出クエリを実行して Finding に変換する */
async function findingsFrom(
  reader: SnapshotReader,
  sql: string,
  problem: string,
): Promise<Finding[]> {
  const rows = await reader.all(sql);
  return rows.map((row) => {
    const { subject, ...rest } = row;
    return {
      problem,
      subject: String(subject ?? "?"),
      ...(Object.keys(rest).length > 0 ? { detail: rest } : {}),
    };
  });
}

function resolve(name: InvariantName, findings: ReadonlyArray<Finding>): InvariantResult {
  return { name, status: findings.length === 0 ? "ok" : "violated", findings };
}

function skipped(name: InvariantName, reason: string): InvariantResult {
  return { name, status: "not_checked", reason, findings: [] };
}

// ----------------------------------------------------------------------------
// 構造的な前提（不変条件15項目の外側）
// ----------------------------------------------------------------------------

/**
 * 型でも実行時の観測でも守れず、UNIQUE 制約の存在だけが守っているもの。
 *
 * 例えば「ACL 変更が version を作らない」は、同一 document に同一 contentHash の
 * 版を2つ書けないことで構造的に成立している。制約が消えれば
 * 不変条件は静かに検証不能になるので、制約そのものの存在を確かめる。
 */
const REQUIRED_UNIQUE_CONSTRAINTS: ReadonlyArray<{
  table: string;
  columns: ReadonlyArray<string>;
  guards: string;
}> = [
  { table: "document", columns: ["source_id", "stable_key"], guards: "documentId の導出元の一意性" },
  {
    table: "document_version",
    columns: ["document_id", "content_hash"],
    guards: "ACL_DOES_NOT_VERSION (AGENTS.md 3.4)",
  },
  { table: "artifact", columns: ["derivation_key", "ordinal"], guards: "#10 の和集合防止" },
  // 順序を observation_seq に移した後も、事象の同一性は observation_id が持つ。
  // ここが一意でなくなると「同じ事象が2回記録された」を検出できなくなる
  {
    table: "observation",
    columns: ["observation_id"],
    guards: "事象の同一性（順序は observation_seq が持つ）",
  },
];

/**
 * observation の追記順に全順序があること。
 *
 * UUIDv4 の observation_id は整列できず、occurred_at は同一トランザクション内で
 * 必ず同値になる。この列が無いと、分岐検出（#10, #11）と失効ワーカーの拒否（#13）の
 * 前後関係が監査から復元できない。
 *
 * DDL 文字列との一致では見ない。列の実在と主キーであることを PRAGMA で確かめる。
 * 文字列一致は、空白やコメントを変えただけで落ちる一方、
 * 列の型が変わっても気づかないという最悪の組み合わせになる。
 */
async function checkObservationTotalOrder(reader: SnapshotReader): Promise<SchemaGuardResult> {
  try {
    const columns = await reader.all("PRAGMA table_info('observation')");
    const seq = columns.find((c) => String(c["name"]) === "observation_seq");
    const findings: Finding[] = [];

    if (seq === undefined) {
      findings.push({
        problem: "missing_total_order_column",
        subject: "observation.observation_seq",
      });
    } else {
      // INTEGER PRIMARY KEY でなければ rowid の別名にならず、追記順が保証されない
      if (Number(seq["pk"]) !== 1) {
        findings.push({
          problem: "total_order_column_is_not_primary_key",
          subject: "observation.observation_seq",
          detail: { pk: seq["pk"] },
        });
      }
      if (String(seq["type"]).toUpperCase() !== "INTEGER") {
        findings.push({
          problem: "total_order_column_is_not_integer",
          subject: "observation.observation_seq",
          detail: { type: seq["type"] },
        });
      }
    }

    return { name: "OBSERVATION_TOTAL_ORDER", ...statusOf(findings) };
  } catch (error) {
    return {
      name: "OBSERVATION_TOTAL_ORDER",
      status: "not_checked",
      reason: `column metadata is not readable: ${(error as Error).message}`,
      findings: [],
    };
  }
}

/**
 * 構造ガードの全リスト。**報告の網羅性はここで数える。**
 *
 * 不変条件15項目は `INVARIANTS` が正本なので、報告漏れは
 * `Object.keys(INVARIANTS)` との突き合わせで捕まります。
 * 構造ガードにはその正本が無いので、無いままだと
 * 「ガードを1本足したが報告集合に入れ忘れた」が誰にも見えません。
 * それは「検証しなかったものを緑と数える」のと同じことです（AGENTS.md 3.7）。
 *
 * ガードを足したらここに1行足してください。足さないと checkInvariants が落ちます。
 */
export const SCHEMA_GUARDS = [
  "REQUIRED_PARTIAL_UNIQUE_INDEXES",
  "REQUIRED_UNIQUE_CONSTRAINTS",
  "OBSERVATION_TOTAL_ORDER",
  "DOCUMENT_VERSION_IMMUTABLE_TRIGGER",
  "ONE_LEASED_RUN_PER_KEY",
] as const;

async function checkSchemaGuards(reader: SnapshotReader): Promise<SchemaGuardResult[]> {
  const guards: SchemaGuardResult[] = [];

  // AGENTS.md 7節が明示的に要求する2本 + 完了走査の全順序（B-4）。
  // 無ければ #1 / #12 の防御と isLatestCompleted の判定根拠が消える
  const required = ["idx_one_running_scan", "idx_one_leased_run", "idx_scan_completion_seq"];
  try {
    const rows = await reader.all(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'",
    );
    const present = new Set(rows.map((r) => String(r["name"])));
    guards.push({
      name: "REQUIRED_PARTIAL_UNIQUE_INDEXES",
      status: required.every((n) => present.has(n)) ? "ok" : "violated",
      findings: required
        .filter((n) => !present.has(n))
        .map((n) => ({ problem: "missing_partial_unique_index", subject: n })),
    });
  } catch (error) {
    // 握りつぶさない。SQLite 以外では確認できなかったと明示して残す
    guards.push({
      name: "REQUIRED_PARTIAL_UNIQUE_INDEXES",
      status: "not_checked",
      reason: `index catalog is not readable: ${(error as Error).message}`,
      findings: [],
    });
  }

  try {
    const missing: Finding[] = [];
    for (const want of REQUIRED_UNIQUE_CONSTRAINTS) {
      const indexes = await reader.all(`PRAGMA index_list('${want.table}')`);
      let satisfied = false;
      for (const idx of indexes) {
        if (Number(idx["unique"]) !== 1 || Number(idx["partial"]) === 1) continue;
        const info = await reader.all(`PRAGMA index_info('${String(idx["name"])}')`);
        const columns = info.map((c) => String(c["name"])).sort();
        if (columns.join(",") === [...want.columns].sort().join(",")) {
          satisfied = true;
          break;
        }
      }
      if (!satisfied) {
        missing.push({
          problem: "missing_unique_constraint",
          subject: `${want.table}(${want.columns.join(", ")})`,
          detail: { guards: want.guards },
        });
      }
    }
    guards.push({ name: "REQUIRED_UNIQUE_CONSTRAINTS", ...statusOf(missing) });
  } catch (error) {
    guards.push({
      name: "REQUIRED_UNIQUE_CONSTRAINTS",
      status: "not_checked",
      reason: `index metadata is not readable: ${(error as Error).message}`,
      findings: [],
    });
  }

  // document_version の不変性を規約ではなく制約で守っているかを確かめる。
  // トリガが落ちると「UPDATE 文を書かない」という規約だけが残り、検証手段が消える
  try {
    const rows = await reader.all(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_document_version_immutable'",
    );
    guards.push({
      name: "DOCUMENT_VERSION_IMMUTABLE_TRIGGER",
      ...statusOf(
        rows.length > 0
          ? []
          : [
              {
                problem: "missing_immutability_trigger",
                subject: "trg_document_version_immutable",
                detail: { guards: "AGENTS.md 6節「DocumentVersion への UPDATE 禁止」" },
              },
            ],
      ),
    });
  } catch (error) {
    guards.push({
      name: "DOCUMENT_VERSION_IMMUTABLE_TRIGGER",
      status: "not_checked",
      reason: `trigger catalog is not readable: ${(error as Error).message}`,
      findings: [],
    });
  }

  guards.push(await checkObservationTotalOrder(reader));

  // 同一 derivationKey で leased な run は同時に1件（#12）。
  // 対応する不変条件が14項目に無いため、ここで構造的前提として見る
  guards.push({
    name: "ONE_LEASED_RUN_PER_KEY",
    ...statusOf(
      await findingsFrom(
        reader,
        `SELECT derivation_key AS subject, COUNT(*) AS leased_count
           FROM processing_run WHERE status = 'leased'
          GROUP BY derivation_key HAVING COUNT(*) > 1`,
        "multiple_leased_runs_for_key",
      ),
    ),
  });

  return guards;
}

function statusOf(findings: Finding[]): { status: InvariantStatus; findings: Finding[] } {
  return { status: findings.length === 0 ? "ok" : "violated", findings };
}

// ----------------------------------------------------------------------------
// 各不変条件
// ----------------------------------------------------------------------------

/** 全 Artifact から原本に到達できる。途中の documentId の食い違いも見る */
async function checkLineageComplete(reader: SnapshotReader): Promise<InvariantResult> {
  const findings = [
    ...(await findingsFrom(
      reader,
      `SELECT a.artifact_id AS subject, a.root_version_id
         FROM artifact a LEFT JOIN document_version v ON v.version_id = a.root_version_id
        WHERE v.version_id IS NULL`,
      "artifact_root_version_missing",
    )),
    ...(await findingsFrom(
      reader,
      `SELECT a.artifact_id AS subject, a.document_id
         FROM artifact a LEFT JOIN document d ON d.document_id = a.document_id
        WHERE d.document_id IS NULL`,
      "artifact_document_missing",
    )),
    // 版が別の文書に属しているなら、系譜は繋がっていても嘘の系譜になる
    ...(await findingsFrom(
      reader,
      `SELECT a.artifact_id AS subject, a.document_id, v.document_id AS version_document_id
         FROM artifact a JOIN document_version v ON v.version_id = a.root_version_id
        WHERE v.document_id <> a.document_id`,
      "artifact_document_disagrees_with_version",
    )),
    ...(await findingsFrom(
      reader,
      `SELECT a.artifact_id AS subject, a.derivation_key
         FROM artifact a JOIN derivation d ON d.derivation_key = a.derivation_key
        WHERE d.document_id <> a.document_id OR d.root_version_id <> a.root_version_id`,
      "artifact_disagrees_with_derivation",
    )),
    ...(await findingsFrom(
      reader,
      `SELECT d.derivation_key AS subject, d.root_version_id
         FROM derivation d LEFT JOIN document_version v ON v.version_id = d.root_version_id
        WHERE v.version_id IS NULL`,
      "derivation_root_version_missing",
    )),
    ...(await findingsFrom(
      reader,
      `SELECT v.version_id AS subject, v.document_id
         FROM document_version v LEFT JOIN document d ON d.document_id = v.document_id
        WHERE d.document_id IS NULL`,
      "version_document_missing",
    )),
    // #30: blob に到達できないと分かった文書は quarantined になっていること
    // （KNOWN_LIMITATIONS.md 4節。修復はしないが放置もしない）
    ...(await findingsFrom(
      reader,
      `SELECT o.document_id AS subject, d.state
         FROM observation o JOIN document d ON d.document_id = o.document_id
        WHERE o.kind = 'blob_reference_broken' AND d.state <> 'quarantined'`,
      "broken_blob_reference_not_quarantined",
    )),
  ];
  findings.push(...await normalizationFindings(reader));
  return resolve("LINEAGE_COMPLETE", findings);
}

/** ⑥の入力辺と値の対応を独立に読む。生成関数・ストアを借りて検算を恒真にしない。 */
async function normalizationFindings(reader: SnapshotReader): Promise<Finding[]> {
  const findings: Finding[] = [];
  // S6-01: 対象の識別子だけを保持する。本文は一件ずつ読み、総本文量をヒープへ載せない。
  const candidates = await reader.all(`SELECT d.derivation_key,a.artifact_id
    FROM derivation d LEFT JOIN artifact a USING(derivation_key)
    WHERE d.processor_name='office-normalize' OR a.type='normalized_document'`);
  const literal = (value: unknown) => `'${String(value).replaceAll("'", "''")}'`;
  const obj = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("object");
    return v as Record<string, unknown>;
  };
  const arr = (v: unknown): unknown[] => { if (!Array.isArray(v)) throw new Error("array"); return v; };
  // N-01: 同じ不正値を両側に置けば対応比較は通るため、入力契約を独立に検査する。
  const text = (v: unknown): void => { if (typeof v !== "string") throw new Error("parent text"); };
  const integer = (v: unknown): void => {
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new Error("parent integer");
  };
  // N-1: JSONオブジェクトの順序だけを無視し、キーの欠落・追加と配列順は検査する。
  const same = (a: unknown, b: unknown): void => {
    if (a === b) return;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) throw new Error("correspondence");
      a.forEach((value, index) => same(value, b[index]));
      return;
    }
    if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
      const left = obj(a), right = obj(b), keys = Object.keys(left).sort();
      same(keys, Object.keys(right).sort());
      for (const key of keys) same(left[key], right[key]);
      return;
    }
    throw new Error("correspondence");
  };
  const fold = (v: unknown) => {
    if (v !== null && typeof v !== "string") throw new Error("text");
    return String(v ?? "").normalize("NFKC").replace(/[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/g, " ").trim().toLowerCase();
  };
  for (const candidate of candidates) {
    const [row] = await reader.all(`SELECT d.*,a.artifact_id,a.type,a.inline_content,a.ordinal,a.blob_key
      FROM derivation d LEFT JOIN artifact a USING(derivation_key)
      WHERE d.derivation_key=${literal(candidate.derivation_key)} AND ${candidate.artifact_id === null ? "a.artifact_id IS NULL" : `a.artifact_id=${literal(candidate.artifact_id)}`}`);
    // 読取失敗・スナップショット不整合で対象を飛ばして合格にしない。
    if (!row) throw new Error("normalization audit candidate disappeared");
    const subject = String(row.artifact_id ?? row.derivation_key);
    try {
      if (row.processor_name !== "office-normalize" || row.type !== "normalized_document" || row.ordinal !== 0 || row.artifact_count !== 1 || row.blob_key !== null) throw new Error("shape");
      // 凍結した⑥ v1の設定ベクタ。本番の設定導出には依存しない。
      if (row.config_hash !== "ed2ad18f2abb020721c4090870381bdc8e13c3badff5b617a7cf7baf70db0945") throw new Error("normalizer config");
      const input = arr(JSON.parse(String(row.input_ids)));
      if (input.length !== 1 || typeof input[0] !== "string") throw new Error("input");
      // SnapshotReaderには束縛引数がないため、文字列リテラルの引用符を二重化する。
      const parentLiteral = literal(input[0]);
      const parents = await reader.all(`SELECT a.*,d.processor_name,d.processor_version,d.config_hash,d.input_ids,d.artifact_count,d.outputs_hash,
        d.root_version_id AS parent_root,d.document_id AS parent_document,
        (SELECT count(*) FROM artifact x WHERE x.derivation_key=a.derivation_key) AS output_count,
        (SELECT count(*) FROM processing_run r WHERE r.derivation_key=a.derivation_key AND r.status='succeeded'
          AND r.root_version_id=a.root_version_id AND r.document_id=a.document_id) AS successes
        FROM artifact a JOIN derivation d USING(derivation_key) WHERE a.artifact_id=${parentLiteral}`);
      const p = parents[0];
      if (!p || p.type !== "parsed_document" || p.processor_name !== "office-xml" || p.ordinal !== 0 || p.artifact_count !== 1 || p.output_count !== 1 || Number(p.successes) < 1 ||
          p.root_version_id !== row.root_version_id || p.document_id !== row.document_id || p.parent_root !== p.root_version_id || p.parent_document !== p.document_id || p.blob_key !== null) throw new Error("parent");
      same(JSON.parse(String(p.input_ids)), [p.root_version_id]);
      const content = String(p.inline_content);
      if (Buffer.byteLength(content) > 8 * 1024 * 1024 || Buffer.byteLength(String(row.inline_content)) > 16 * 1024 * 1024) throw new Error("limit");
      const hash = createHash("sha256").update(content).digest("hex");
      if (p.content_hash !== hash || p.size_bytes !== Buffer.byteLength(content) || p.outputs_hash !== recomputeOutputsHash([{ artifactId: String(p.artifact_id), contentHash: hash }])) throw new Error("parent evidence");
      const parsed = obj(JSON.parse(content)), normalized = obj(JSON.parse(String(row.inline_content)));
      if (parsed.schemaVersion !== 1 || (parsed.format !== "docx" && parsed.format !== "xlsx")) throw new Error("parent schema or format");
      arr(parsed.warnings).forEach(text);
      if (parsed.format === "xlsx" && parsed.dateSystem !== "1900" && parsed.dateSystem !== "1904") throw new Error("parent date system");
      same(normalized.schemaVersion, 1); same(normalized.format, parsed.format); same(normalized.warnings, parsed.warnings);
      same(normalized.dateSystem, parsed.format === "xlsx" ? parsed.dateSystem : null);
      const groups = arr(normalized.groups), sources = arr(parsed.format === "xlsx" ? parsed.sheets : parsed.blocks);
      const locations = new Set<string>(), parts = new Set<string>(), names = new Set<string>();
      const uniquePosition = (seen: Set<string>, value: unknown) => {
        if (typeof value !== "string" || !value || seen.has(value)) throw new Error("duplicate or empty position");
        seen.add(value);
      };
      same(groups.length, sources.length);
      for (let g = 0; g < sources.length; g++) {
        const source = obj(sources[g]), group = obj(groups[g]), units = arr(group.units);
        const kind = parsed.format === "xlsx" ? "sheet" : source.kind;
        if (parsed.format === "docx" && kind !== "paragraph" && kind !== "table") throw new Error("parent block kind");
        same(group.kind, kind);
        let expected: Array<{ row: unknown; cells: unknown[] }>;
        if (kind === "sheet") {
          uniquePosition(parts, source.part); uniquePosition(names, source.name);
          text(source.state); arr(source.merges).forEach(text);
          for (const k of ["name", "state", "part", "merges"]) same(group[k], source[k]);
          const byRow = new Map<number, unknown[]>();
          const addresses = new Set<string>();
          for (const entry of arr(source.cells).map(obj).sort((a, b) => Number(a.row) - Number(b.row) || Number(a.column) - Number(b.column))) {
            text(entry.address); integer(entry.row); integer(entry.column);
            for (const key of ["valueType", "formulaKind", "numberFormat"]) text(entry[key]);
            if (entry.value !== null) text(entry.value);
            if (entry.formula !== null) text(entry.formula);
            if (typeof entry.hiddenRow !== "boolean" ||
                (entry.hiddenColumn !== undefined && entry.hiddenColumn !== null && typeof entry.hiddenColumn !== "boolean")) throw new Error("parent visibility");
            const address = String(entry.address), r = Number(entry.row), c = Number(entry.column);
            let col = c, letters = "";
            if (!Number.isSafeInteger(r) || r < 1 || r > 1048576 || !Number.isSafeInteger(c) || c < 1 || c > 16384) throw new Error("coordinates");
            while (col > 0) { col--; letters = String.fromCharCode(65 + col % 26) + letters; col = Math.floor(col / 26); }
            if (address !== `${letters}${r}` || addresses.has(address)) throw new Error("position");
            addresses.add(address);
            const cells = byRow.get(r) ?? []; cells.push({ ...entry, hiddenColumn: entry.hiddenColumn ?? null }); byRow.set(r, cells);
          }
          expected = [...byRow].map(([row, cells]) => ({ row, cells }));
        } else {
          uniquePosition(locations, source.location);
          same(group.location, source.location);
          expected = kind === "paragraph" ? [{ row: null, cells: [source] }] : arr(source.rows).map((r, i) => ({ row: i + 1, cells: arr(r) }));
        }
        same(units.length, expected.length);
        for (let u = 0; u < units.length; u++) {
          const unit = obj(units[u]), e = expected[u]!, members = arr(unit.members);
          same(unit.row, e.row); same(members.length, e.cells.length);
          for (let m = 0; m < members.length; m++) {
            const member = obj(members[m]), original = obj(e.cells[m]);
            if (kind !== "sheet") {
              text(original.text);
              if (kind === "paragraph") text(original.style);
              else { integer(original.columnSpan); text(original.verticalMerge); }
            }
            if (kind === "table") uniquePosition(locations, original.location);
            same(member.kind, kind === "sheet" ? "sheet_cell" : kind === "paragraph" ? "word_paragraph" : "word_cell");
            same(member.source, original);
            same(member.searchText, fold(kind === "sheet" ? original.value : original.text));
            if (kind === "sheet") same(member.searchFormula, fold(original.formula));
          }
        }
      }
    } catch (error) {
      findings.push({ problem: "normalized_input_or_correspondence_invalid", subject, detail: { reason: error instanceof Error ? error.message : String(error) } });
    }
  }
  return findings;
}

/**
 * 親のない Artifact が0件。
 *
 * artifactCount と実際の行数の不一致もここで見る。
 * #9（Derivation だけ書いてクラッシュ）の署名がこれで、
 * 「Derivation 行があるから処理済み」と読ませないための数値だから。
 */
async function checkNoOrphanArtifact(reader: SnapshotReader): Promise<InvariantResult> {
  const findings = [
    ...(await findingsFrom(
      reader,
      `SELECT a.artifact_id AS subject, a.derivation_key
         FROM artifact a LEFT JOIN derivation d ON d.derivation_key = a.derivation_key
        WHERE d.derivation_key IS NULL`,
      "artifact_without_derivation",
    )),
    ...(await findingsFrom(
      reader,
      `SELECT d.derivation_key AS subject, d.artifact_count AS declared,
              (SELECT COUNT(*) FROM artifact a WHERE a.derivation_key = d.derivation_key) AS actual
         FROM derivation d
        WHERE d.artifact_count <>
              (SELECT COUNT(*) FROM artifact a WHERE a.derivation_key = d.derivation_key)`,
      "artifact_count_mismatch",
    )),
  ];
  return resolve("NO_ORPHAN_ARTIFACT", findings);
}

/** 複数 active な document が0件。ポインタの指し先と鍵の衝突を見る */
async function checkSingleActiveVersion(
  reader: SnapshotReader,
  knownSourceIds?: ReadonlyArray<SourceId>,
): Promise<InvariantResult> {
  const findings: Finding[] = [
    ...(await findingsFrom(
      reader,
      `SELECT d.document_id AS subject, d.active_version_id
         FROM document d LEFT JOIN document_version v ON v.version_id = d.active_version_id
        WHERE d.active_version_id IS NOT NULL AND v.version_id IS NULL`,
      "active_version_missing",
    )),
    // 別文書の版を指していると、1文書に見えて実体は2文書ぶんになる
    ...(await findingsFrom(
      reader,
      `SELECT d.document_id AS subject, d.active_version_id, v.document_id AS owner
         FROM document d JOIN document_version v ON v.version_id = d.active_version_id
        WHERE v.document_id <> d.document_id`,
      "active_version_belongs_to_other_document",
    )),
  ];

  // #23: 同一 source 内で正規化後に衝突する stableKey が2つある＝
  // documentId の導出がポリシーを適用していない
  const docs = await reader.all(
    `SELECT d.document_id, d.source_id, d.stable_key,
            s.key_unicode_form, s.key_case_fold, s.key_path_separator, s.key_trim_slashes
       FROM document d JOIN source s ON s.source_id = d.source_id
      ORDER BY d.source_id, d.stable_key`,
  );
  const seen = new Map<string, string>();
  for (const row of docs) {
    const policy: StoredKeyPolicy = {
      unicodeForm: String(row["key_unicode_form"]) as StoredKeyPolicy["unicodeForm"],
      caseFold: Number(row["key_case_fold"]) === 1,
      pathSeparator: String(row["key_path_separator"]) as StoredKeyPolicy["pathSeparator"],
      trimSlashes: Number(row["key_trim_slashes"]) === 1,
    };
    const documentId = String(row["document_id"]);
    const bucket = `${String(row["source_id"])}\x00${normalizeStableKey(String(row["stable_key"]), policy)}`;
    const first = seen.get(bucket);
    if (first !== undefined && first !== documentId) {
      findings.push({
        problem: "stable_key_collides_after_normalization",
        subject: documentId,
        detail: { collidesWith: first, stableKey: row["stable_key"] },
      });
    } else {
      seen.set(bucket, documentId);
    }
  }

  // #24: 走査対象から外れた sourceId の active 文書（検出のみ）
  if (knownSourceIds !== undefined) {
    const list = knownSourceIds.map((id) => `'${String(id).replace(/'/g, "''")}'`).join(", ");
    const clause = list.length === 0 ? "" : ` AND source_id NOT IN (${list})`;
    findings.push(
      ...(await findingsFrom(
        reader,
        `SELECT document_id AS subject, source_id FROM document
          WHERE state = 'active'${clause}`,
        "active_document_in_orphaned_source",
      )),
    );
  }

  return resolve("SINGLE_ACTIVE_VERSION", findings);
}

/** 弁作動中の tombstone が0件 */
async function checkSafetyAbortWritesNothing(reader: SnapshotReader): Promise<InvariantResult> {
  const findings = [
    ...(await findingsFrom(
      reader,
      `SELECT o.document_id AS subject, o.scan_id, s.abort_reason
         FROM observation o JOIN scan_run s ON s.scan_id = o.scan_id
        WHERE o.kind = 'document_tombstoned' AND s.status = 'aborted_safety'`,
      "tombstone_written_by_aborted_scan",
    )),
    // 弁が発火したのに記録が残っていなければ、後から事故を追えない
    ...(await findingsFrom(
      reader,
      `SELECT s.scan_id AS subject, s.source_id FROM scan_run s
        WHERE s.status = 'aborted_safety'
          AND NOT EXISTS (SELECT 1 FROM observation o
                           WHERE o.scan_id = s.scan_id AND o.kind = 'scan_aborted_safety')`,
      "aborted_scan_without_observation",
    )),
  ];
  return resolve("SAFETY_ABORT_WRITES_NOTHING", findings);
}

/** tombstone は promote された走査からのみ */
async function checkDeletionOnlyFromCompletedScan(
  reader: SnapshotReader,
): Promise<InvariantResult> {
  const findings = [
    ...(await findingsFrom(
      reader,
      `SELECT o.document_id AS subject, o.scan_id, s.status, s.write_failure_count
         FROM observation o JOIN scan_run s ON s.scan_id = o.scan_id
        WHERE o.kind = 'document_tombstoned'
          AND (s.status <> 'completed' OR s.write_failure_count <> 0)`,
      "tombstone_from_non_promoted_scan",
    )),
    ...(await findingsFrom(
      reader,
      `SELECT o.document_id AS subject FROM observation o
        WHERE o.kind = 'document_tombstoned' AND o.scan_id IS NULL`,
      "tombstone_without_scan",
    )),
    // #1, #2: tombstone を書いた時点で既に後発の走査が完了していた＝
    // その走査はもう「最新完了」ではなかった
    ...(await findingsFrom(
      reader,
      `SELECT o.document_id AS subject, o.scan_id, o.occurred_at
         FROM observation o JOIN scan_run s ON s.scan_id = o.scan_id
        WHERE o.kind = 'document_tombstoned'
          AND EXISTS (SELECT 1 FROM scan_run s2
                       WHERE s2.source_id = s.source_id
                         AND s2.scan_id <> s.scan_id
                         AND s2.status = 'completed'
                         AND s2.completion_seq > s.completion_seq
                         AND s2.finished_at < o.occurred_at)`,
      "tombstone_from_superseded_scan",
    )),
    // 状態だけ tombstoned になっていて出所が辿れない行
    ...(await findingsFrom(
      reader,
      `SELECT d.document_id AS subject FROM document d
        WHERE d.state = 'tombstoned'
          AND NOT EXISTS (SELECT 1 FROM observation o
                           WHERE o.document_id = d.document_id
                             AND o.kind = 'document_tombstoned')`,
      "tombstoned_without_observation",
    )),
  ];
  // 完了順と観測順は別の系列。同じミリ秒を勝手に全順序へ伸ばさない。
  const ambiguous = await findingsFrom(reader,
    `SELECT o.document_id AS subject, o.scan_id FROM observation o
       JOIN scan_run s ON s.scan_id=o.scan_id
      WHERE o.kind='document_tombstoned' AND EXISTS (
        SELECT 1 FROM scan_run s2 WHERE s2.source_id=s.source_id
          AND s2.status='completed' AND s2.completion_seq>s.completion_seq
          AND s2.finished_at=o.occurred_at)`, "completion_tombstone_order_unknown");
  if (findings.length === 0 && ambiguous.length > 0) return {
    name: "DELETION_ONLY_FROM_COMPLETED_SCAN", status: "not_checked",
    reason: "completion and tombstone share a timestamp; no shared sequence proves their order",
    findings: ambiguous,
  };
  return resolve("DELETION_ONLY_FROM_COMPLETED_SCAN", findings);
}

/** 未検証 blob を参照する version が0件 */
async function checkNoVersionWithoutVerifiedBlob(
  reader: SnapshotReader,
): Promise<InvariantResult> {
  const findings = [
    ...(await findingsFrom(
      reader,
      `SELECT version_id AS subject, blob_verified_at FROM document_version
        WHERE blob_verified_at IS NULL OR blob_verified_at <= 0`,
      "blob_verified_at_missing",
    )),
    ...(await findingsFrom(
      reader,
      `SELECT version_id AS subject FROM document_version
        WHERE blob_key IS NULL OR blob_key = ''`,
      "blob_key_missing",
    )),
    // 検証時刻が取り込み時刻より前なら、検証したのは別の何かだったことになる
    ...(await findingsFrom(
      reader,
      `SELECT version_id AS subject, blob_verified_at, ingested_at FROM document_version
        WHERE blob_verified_at > ingested_at`,
      "blob_verified_after_ingest",
    )),
  ];
  return resolve("NO_VERSION_WITHOUT_VERIFIED_BLOB", findings);
}

/** 再実行で outputsHash が変わらない。宣言値を独立に再計算して突き合わせる */
async function checkDerivationOutputStable(reader: SnapshotReader): Promise<InvariantResult> {
  const findings: Finding[] = [
    // #10: 1回目の残骸が ordinal の穴や飛びとして残る
    ...(await findingsFrom(
      reader,
      `SELECT d.derivation_key AS subject, MIN(a.ordinal) AS min_ordinal,
              MAX(a.ordinal) AS max_ordinal, COUNT(*) AS actual
         FROM derivation d JOIN artifact a ON a.derivation_key = d.derivation_key
        GROUP BY d.derivation_key
       HAVING MIN(a.ordinal) <> 0 OR MAX(a.ordinal) <> COUNT(*) - 1`,
      "artifact_ordinals_not_contiguous",
    )),
    // 発散が観測されていたら、それ自体が違反（無言でスキップさせない）
    ...(await findingsFrom(
      reader,
      `SELECT COALESCE(document_id, observation_id) AS subject, kind, occurred_at
         FROM observation WHERE kind = 'derivation_output_divergence'`,
      "divergence_observed",
    )),
  ];

  const derivations = await reader.all(
    "SELECT derivation_key, outputs_hash FROM derivation ORDER BY derivation_key",
  );
  if (derivations.length > 0) {
    const artifacts = await reader.all(
      "SELECT derivation_key, artifact_id, content_hash FROM artifact ORDER BY derivation_key, ordinal",
    );
    const byKey = new Map<string, { artifactId: string; contentHash: string }[]>();
    for (const a of artifacts) {
      const key = String(a["derivation_key"]);
      const list = byKey.get(key) ?? [];
      list.push({ artifactId: String(a["artifact_id"]), contentHash: String(a["content_hash"]) });
      byKey.set(key, list);
    }
    for (const d of derivations) {
      const key = String(d["derivation_key"]);
      const expected = recomputeOutputsHash(byKey.get(key) ?? []);
      if (expected !== String(d["outputs_hash"])) {
        findings.push({
          problem: "outputs_hash_does_not_match_artifacts",
          subject: key,
          detail: { stored: d["outputs_hash"], recomputed: expected },
        });
      }
    }
  }

  return resolve("DERIVATION_OUTPUT_STABLE", findings);
}

/** active ポインタが最新観測と一致（#2, #15） */
async function checkPointerMatchesObservation(reader: SnapshotReader): Promise<InvariantResult> {
  const findings = [
    // 時刻の同値・逆行があっても追記順は observation_seq で一意に決まる。
    ...(await findingsFrom(
      reader,
      `SELECT d.document_id AS subject, d.active_version_id
         FROM document d
        WHERE EXISTS (SELECT 1 FROM observation o
                       WHERE o.document_id = d.document_id
                         AND o.kind IN ('version_created', 'version_reverted')
                         AND o.version_id IS NOT NULL)
          AND NOT EXISTS (
                SELECT 1 FROM observation o
                 WHERE o.document_id = d.document_id
                   AND o.kind IN ('version_created', 'version_reverted')
                   AND o.version_id = d.active_version_id
                   AND o.observation_seq = (SELECT MAX(o2.observation_seq) FROM observation o2
                                         WHERE o2.document_id = d.document_id
                                           AND o2.kind IN ('version_created', 'version_reverted')
                                           AND o2.version_id IS NOT NULL))`,
      "active_pointer_does_not_match_latest_observation",
    )),
    // #15: 版は入ったがポインタが動かなかった
    ...(await findingsFrom(
      reader,
      `SELECT d.document_id AS subject FROM document d
        WHERE d.active_version_id IS NULL AND d.state = 'active'
          AND EXISTS (SELECT 1 FROM document_version v WHERE v.document_id = d.document_id)`,
      "versions_exist_but_no_active_pointer",
    )),
  ];
  return resolve("POINTER_MATCHES_OBSERVATION", findings);
}

/**
 * ACL 変更が version を作っていない。
 *
 * 同一 document に同一 contentHash の版が2つあれば、内容が変わっていないのに
 * 版が増えたということ。ACL 起因の版はこの形で現れる（AGENTS.md 3.4）。
 */
async function checkAclDoesNotVersion(reader: SnapshotReader): Promise<InvariantResult> {
  const findings = [
    ...(await findingsFrom(
      reader,
      `SELECT document_id AS subject, content_hash, COUNT(*) AS versions
         FROM document_version GROUP BY document_id, content_hash HAVING COUNT(*) > 1`,
      "duplicate_content_hash_for_document",
    )),
    // 取得失敗が principals=[] の "synced" として焼き付いていないか（#29）
    ...(await findingsFrom(
      reader,
      `SELECT document_id AS subject, tenant_id FROM access_control
        WHERE state = 'synced' AND principals = '[]' AND last_error IS NOT NULL`,
      "failed_acl_fetch_recorded_as_synced",
    )),
  ];
  return resolve("ACL_DOES_NOT_VERSION", findings);
}

/** 同一 source の running 走査が同時に1件以下 */
async function checkOneRunningScanPerSource(reader: SnapshotReader): Promise<InvariantResult> {
  const findings = await findingsFrom(
    reader,
    `SELECT source_id AS subject, COUNT(*) AS running_count FROM scan_run
      WHERE status = 'running' GROUP BY source_id HAVING COUNT(*) > 1`,
    "multiple_running_scans_for_source",
  );
  return resolve("ONE_RUNNING_SCAN_PER_SOURCE", findings);
}

/**
 * **inline 本文の独立した検算。`BlobVerifier` を要りません。**
 *
 * 本文は行の中にあるので、実体は既に手元にあります。保存された `content_hash` と
 * `size_bytes` が本文から決まる値かを、**ストアの導出関数を import せずに**
 * 計算して突き合わせます（`src/domain/ids.ts` を使うと、同じ誤解が2回起きた
 * ときに緑になります。この節の他の検査と同じ理由）。
 *
 * 既に保存された行にも効くのが要点です。**確定時の検査は新しい不整合を止める
 * だけで、既に入った行は直しません。** 2026-09-10 以前に書かれた
 * 「本文と hash が食い違う artifact」は、この検算でしか見つかりません。
 */
async function inlineArtifactFindings(reader: SnapshotReader, cap: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const candidates = await reader.all(
    `SELECT artifact_id FROM artifact
      WHERE inline_content IS NOT NULL ORDER BY artifact_id${cap}`,
  );

  for (const candidate of candidates) {
    const literal = `'${String(candidate.artifact_id).replaceAll("'", "''")}'`;
    const [a] = await reader.all(`SELECT artifact_id, inline_content, content_hash, size_bytes
      FROM artifact WHERE artifact_id=${literal} AND inline_content IS NOT NULL`);
    if (!a) throw new Error("inline audit candidate disappeared");
    const bytes = Buffer.from(String(a["inline_content"]), "utf8");
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== String(a["content_hash"])) {
      findings.push({
        problem: "artifact_inline_hash_mismatch",
        subject: String(a["artifact_id"]),
        detail: { storedContentHash: a["content_hash"], actual },
      });
    }
    if (Number(a["size_bytes"]) !== bytes.byteLength) {
      findings.push({
        problem: "artifact_inline_size_mismatch",
        subject: String(a["artifact_id"]),
        detail: { storedSizeBytes: a["size_bytes"], actual: bytes.byteLength },
      });
    }
  }
  return findings;
}

/**
 * hash と実バイト列の不一致が0件。**2つの置き場所を1つの主張で見ます。**
 *
 *   - `blob_key` の行 … blob を実際に読み直す（`BlobVerifier` が要る）
 *   - `inline_content` の行 … 行の中の本文から計算する（何も要らない）
 *
 * **`BlobVerifier` が無いときは `ok` を返しません。** blob の枝を1バイトも
 * 見ていないのに「不一致0件」と報告すると、検査しなかったことが
 * 「違反が無かった」になります（AGENTS.md 3.7）。
 * ただし inline 側で**実際に見つけた不一致は報告します**——
 * 見つけた違反を「検査していない」に畳むのは、逆向きの同じ誤りです。
 */
async function checkHashMatchesBlob(
  reader: SnapshotReader,
  blobs: BlobVerifier,
  limit?: number,
): Promise<InvariantResult> {
  const findings: Finding[] = [];
  const unreadable: Finding[] = [];
  const verify = async (subject: string, key: unknown, hash: unknown): Promise<boolean | undefined> => {
    try {
      return await blobs.verify(String(key) as BlobKey, String(hash) as ContentHash);
    } catch (error) {
      // 一件が読めなくても他の参照を検査する。読めないことを不一致と断定しない。
      unreadable.push({ problem: "blob_verification_failed", subject,
        detail: { error: error instanceof Error ? error.message : String(error) } });
      return undefined;
    }
  };
  const cap = limit === undefined ? "" : ` LIMIT ${Math.max(0, Math.trunc(limit))}`;
  findings.push(...(await inlineArtifactFindings(reader, cap)));

  const versions = await reader.all(
    `SELECT version_id, blob_key, content_hash FROM document_version ORDER BY version_id${cap}`,
  );
  for (const v of versions) {
    const ok = await verify(String(v["version_id"]), v["blob_key"], v["content_hash"]);
    if (ok === false) {
      findings.push({
        problem: "version_blob_hash_mismatch",
        subject: String(v["version_id"]),
        detail: { blobKey: v["blob_key"], contentHash: v["content_hash"] },
      });
    }
  }

  const artifacts = await reader.all(
    `SELECT artifact_id, blob_key, content_hash FROM artifact
      WHERE blob_key IS NOT NULL ORDER BY artifact_id${cap}`,
  );
  for (const a of artifacts) {
    const ok = await verify(String(a["artifact_id"]), a["blob_key"], a["content_hash"]);
    if (ok === false) {
      findings.push({
        problem: "artifact_blob_hash_mismatch",
        subject: String(a["artifact_id"]),
        detail: { blobKey: a["blob_key"], contentHash: a["content_hash"] },
      });
    }
  }

  if (unreadable.length > 0) return {
    name: "HASH_MATCHES_BLOB", status: findings.length > 0 ? "violated" : "not_checked",
    reason: `${unreadable.length} blob references could not be verified`,
    findings: [...findings, ...unreadable],
  };
  return resolve("HASH_MATCHES_BLOB", findings);
}

/**
 * `BlobVerifier` が無いときの `HASH_MATCHES_BLOB`。
 *
 * inline の不一致が見つかれば **violated**、見つからなければ **not_checked** です。
 * `ok` は返しません——blob の枝を1バイトも見ていないからです。
 */
async function inlineOnlyHashCheck(
  reader: SnapshotReader,
  limit?: number,
): Promise<InvariantResult> {
  const cap = limit === undefined ? "" : ` LIMIT ${Math.max(0, Math.trunc(limit))}`;
  const findings = await inlineArtifactFindings(reader, cap);
  return findings.length > 0
    ? { name: "HASH_MATCHES_BLOB", status: "violated", findings }
    : skipped(
        "HASH_MATCHES_BLOB",
        "no BlobVerifier was supplied (pass ctx.blobs); inline artifacts were checked and matched",
      );
}

/**
 * 保存されている `derivationKey` が、保存されている材料から再導出できる。
 *
 * **簡略式で作った鍵が DB に入っていても、他の14項目は全部緑のままでした。**
 * 鍵は `derivation` 表の主キーで、`artifact` はそれを FK で指すだけなので、
 * 値が何であっても構造は整合します。
 *
 * 並び順も見ます。`input_ids` は「鍵に入ったソート済みの順序をそのまま保つ」
 * 契約なので、保存された順序が UTF-8 バイト昇順でなければ、
 * 鍵と保存内容のどちらかが嘘です。
 */
async function checkDerivationKeyMatchesMaterials(reader: SnapshotReader): Promise<InvariantResult> {
  const rows = await reader.all(
    `SELECT derivation_key, processor_name, processor_version, config_hash, input_ids
       FROM derivation ORDER BY derivation_key`,
  );
  const findings: Finding[] = [];

  for (const row of rows) {
    const key = String(row["derivation_key"]);
    let inputIds: unknown;
    try {
      inputIds = JSON.parse(String(row["input_ids"]));
    } catch {
      findings.push({ problem: "input_ids_not_json", subject: key });
      continue;
    }
    if (!Array.isArray(inputIds) || inputIds.some((v) => typeof v !== "string")) {
      findings.push({ problem: "input_ids_not_a_string_array", subject: key });
      continue;
    }

    const stored = inputIds as string[];
    const sorted = [...stored].sort(compareUtf8);
    if (sorted.some((v, i) => v !== stored[i])) {
      findings.push({
        problem: "input_ids_not_stored_in_key_order",
        subject: key,
        detail: { stored, sorted },
      });
    }

    const expected = recomputeDerivationKey({
      processorName: String(row["processor_name"]),
      processorVersion: String(row["processor_version"]),
      configHash: String(row["config_hash"]),
      sortedInputIds: sorted,
    });
    if (expected !== key) {
      findings.push({
        problem: "derivation_key_does_not_match_materials",
        subject: key,
        detail: { expected },
      });
    }
  }

  return resolve("DERIVATION_KEY_MATCHES_MATERIALS", findings);
}

/**
 * 再実行後の状態が一致する。比較規則は state-snapshot が持つ。
 *
 * **一致していても、比べた同一性が作り物なら何も言えません。**
 * 2回の走行が同じ簡略式で同じ鍵を作れば、状態は必ず一致します
 * ——実導出経路を一度も通らずに。だから、材料から再導出できない鍵が
 * 1つでもあれば、この項目は緑になりません。
 * `DERIVATION_KEY_MATCHES_MATERIALS` を同時に見れば同じことが分かりますが、
 * フィクスチャは主張する項目を選べるので、**この項目単独でも
 * 恒真式化しない形**にしてあります。
 */
async function checkIdempotentReplay(
  reader: SnapshotReader,
  replay: NonNullable<CheckContext["replay"]>,
): Promise<InvariantResult> {
  const findings: Finding[] = [];

  const attribution = await checkDerivationKeyMatchesMaterials(reader);
  for (const finding of attribution.findings) {
    findings.push({
      problem: "replay_compared_unattributable_key",
      subject: finding.subject,
      detail: { cause: finding.problem },
    });
  }

  const diff = diffSnapshots(replay.before, replay.after);
  if (!isEmptyDiff(diff)) {
    findings.push({
      problem: "replay_state_diff_not_empty",
      subject: "state",
      detail: { diff: formatDiff(diff) },
    });
  }
  return resolve("IDEMPOTENT_REPLAY", findings);
}

/**
 * 無変更時の書き込みが0件。
 *
 * 内容を持つ3表（document_version / derivation / artifact）に行が増えていなければ
 * 「仕事をしていない」とみなす。呼び出し側が「入力が無変更である」ことを
 * 保証する責任を持つ（このチェックはそれを確かめられない）。
 */
function checkNoWorkWithoutChange(replay: NonNullable<CheckContext["replay"]>): InvariantResult {
  const diff = diffSnapshots(replay.before, replay.after);
  const contentTables = new Set(["document_version", "derivation", "artifact"]);
  const findings = diff.rows
    .filter((r) => contentTables.has(r.table) && r.kind === "added")
    .map((r) => ({
      problem: "row_written_during_unchanged_rerun",
      subject: `${r.table}[${r.key.split("\x00").join(" / ")}]`,
    }));
  return resolve("NO_WORK_WITHOUT_CHANGE", findings);
}

/** 固定値テストベクタが全環境で一致 */
function checkCanonicalKeyStability(
  vectors: NonNullable<CheckContext["configHashVectors"]>,
): InvariantResult {
  const findings = vectors
    .filter((v) => v.actual !== v.expected)
    .map((v) => ({
      problem: "config_hash_vector_mismatch",
      subject: v.label,
      detail: { expected: v.expected, actual: v.actual },
    }));
  return resolve("CANONICAL_KEY_STABILITY", findings);
}

// ----------------------------------------------------------------------------
// 一括実行
// ----------------------------------------------------------------------------

export async function checkInvariants(ctx: CheckContext): Promise<InvariantReport> {
  const { reader } = ctx;

  // 検査の失敗も結果にする。正本の各名前を一度ずつ実行し、例外で報告全体を失わない。
  const checks: Record<InvariantName, () => InvariantResult | Promise<InvariantResult>> = {
    LINEAGE_COMPLETE: () => checkLineageComplete(reader),
    NO_ORPHAN_ARTIFACT: () => checkNoOrphanArtifact(reader),
    SINGLE_ACTIVE_VERSION: () => checkSingleActiveVersion(reader, ctx.knownSourceIds),
    SAFETY_ABORT_WRITES_NOTHING: () => checkSafetyAbortWritesNothing(reader),
    DELETION_ONLY_FROM_COMPLETED_SCAN: () => checkDeletionOnlyFromCompletedScan(reader),
    NO_VERSION_WITHOUT_VERIFIED_BLOB: () => checkNoVersionWithoutVerifiedBlob(reader),
    DERIVATION_OUTPUT_STABLE: () => checkDerivationOutputStable(reader),
    POINTER_MATCHES_OBSERVATION: () => checkPointerMatchesObservation(reader),
    ACL_DOES_NOT_VERSION: () => checkAclDoesNotVersion(reader),
    ONE_RUNNING_SCAN_PER_SOURCE: () => checkOneRunningScanPerSource(reader),
    DERIVATION_KEY_MATCHES_MATERIALS: () => checkDerivationKeyMatchesMaterials(reader),
    HASH_MATCHES_BLOB: () => ctx.blobs
      ? checkHashMatchesBlob(reader, ctx.blobs, ctx.blobSampleLimit)
      : inlineOnlyHashCheck(reader, ctx.blobSampleLimit),
    IDEMPOTENT_REPLAY: () => ctx.replay ? checkIdempotentReplay(reader, ctx.replay)
      : skipped("IDEMPOTENT_REPLAY", "no before/after snapshots were supplied (pass ctx.replay)"),
    NO_WORK_WITHOUT_CHANGE: () => ctx.replay ? checkNoWorkWithoutChange(ctx.replay)
      : skipped("NO_WORK_WITHOUT_CHANGE", "no before/after snapshots were supplied (pass ctx.replay)"),
    CANONICAL_KEY_STABILITY: () => ctx.configHashVectors ? checkCanonicalKeyStability(ctx.configHashVectors)
      : skipped("CANONICAL_KEY_STABILITY", "no test vectors were supplied (pass ctx.configHashVectors)"),
  };
  const results: InvariantResult[] = [];
  for (const name of Object.keys(checks) as InvariantName[]) {
    try { results.push(await checks[name]()); }
    catch (error) {
      results.push(skipped(name, 'check failed: ' + (error instanceof Error ? error.message : String(error))));
    }
  }

  // 15項目すべてを1回ずつ報告していることを、報告そのもので確かめる
  const covered = new Set(results.map((r) => r.name));
  const missing = (Object.keys(INVARIANTS) as InvariantName[]).filter((n) => !covered.has(n));
  if (missing.length > 0 || covered.size !== results.length) {
    throw new Error(
      `invariant-checker does not report every invariant exactly once ` +
        `(missing: ${missing.join(", ") || "none"}, reported: ${results.length})`,
    );
  }

  // 構造ガードも同じ規律で数える。宣言リストと報告が食い違えば落とす。
  // ガードは INVARIANTS のような正本を持たないので、この検査が唯一の歯止め
  let schemaGuards: SchemaGuardResult[];
  try { schemaGuards = await checkSchemaGuards(reader); }
  catch (error) {
    schemaGuards = SCHEMA_GUARDS.map((name) => ({ name, status: "not_checked",
      reason: 'schema check failed: ' + (error instanceof Error ? error.message : String(error)), findings: [] }));
  }
  const guardNames = new Set(schemaGuards.map((g) => g.name));
  const missingGuards = SCHEMA_GUARDS.filter((n) => !guardNames.has(n));
  const unexpectedGuards = [...guardNames].filter(
    (n) => !(SCHEMA_GUARDS as ReadonlyArray<string>).includes(n),
  );
  if (
    missingGuards.length > 0 ||
    unexpectedGuards.length > 0 ||
    guardNames.size !== schemaGuards.length
  ) {
    throw new Error(
      `invariant-checker does not report every schema guard exactly once ` +
        `(missing: ${missingGuards.join(", ") || "none"}, ` +
        `undeclared: ${unexpectedGuards.join(", ") || "none"}, reported: ${schemaGuards.length})`,
    );
  }

  return { results, schemaGuards };
}

// ----------------------------------------------------------------------------
// アサーション
// ----------------------------------------------------------------------------

export function formatReport(report: InvariantReport): string {
  const lines: string[] = [];
  for (const entry of [...report.results, ...report.schemaGuards]) {
    if (entry.status === "ok") continue;
    const head =
      entry.status === "not_checked"
        ? `? ${entry.name}: NOT CHECKED — ${entry.reason ?? "no reason given"}`
        : `x ${entry.name}: ${INVARIANTS[entry.name as InvariantName] ?? "structural guard"}`;
    lines.push(head);
    for (const f of entry.findings) {
      const detail = f.detail === undefined ? "" : ` ${JSON.stringify(f.detail)}`;
      lines.push(`    ${f.problem}: ${f.subject}${detail}`);
    }
  }
  return lines.join("\n");
}

/** 実行後に成立していないことが正しい違反の指定（`Fixture.expectedViolations`） */
export interface AllowedViolation {
  readonly invariant: string;
  /** `Finding.problem` と完全一致すること。部分一致にしない */
  readonly problem: string;
}

/**
 * 違反があれば落とす。
 *
 * @param required フィクスチャが宣言した `assertions`。
 *   ここに挙がった項目が `not_checked` なら、それも失敗として扱う。
 *   検証しなかったものを緑と数えないため（AGENTS.md 3.7）。
 *
 * @param allowed 攻撃が成功することが正しいシナリオで、
 *   起きてよい違反を (不変条件, problem) で名指ししたもの。
 *   **名指しされていない違反は今まで通り落とします。**
 *   1つでも余分な findings があれば、その項目全体を違反として扱います。
 *   「宣言した違反が実際に起きたか」はここでは見ません（ランナーの責務）。
 */
export function assertInvariants(
  report: InvariantReport,
  required: ReadonlyArray<InvariantName> = [],
  allowed: ReadonlyArray<AllowedViolation> = [],
): void {
  const isAllowed = (name: string, problem: string): boolean =>
    allowed.some((a) => a.invariant === name && a.problem === problem);

  const violated = [...report.results, ...report.schemaGuards].filter(
    (r) => r.status === "violated" && !r.findings.every((f) => isAllowed(r.name, f.problem)),
  );
  const unchecked = report.results.filter(
    (r) => r.status === "not_checked" && required.includes(r.name),
  );

  if (violated.length === 0 && unchecked.length === 0) return;

  const summary = [
    violated.length > 0 ? `${violated.length} violated` : "",
    unchecked.length > 0 ? `${unchecked.length} asserted but not checked` : "",
  ]
    .filter(Boolean)
    .join(", ");

  throw new Error(`INVARIANTS failed (${summary}):\n${formatReport(report)}`);
}
