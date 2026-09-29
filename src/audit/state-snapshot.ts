/**
 * 再実行前後の状態比較。
 *
 * 比較規則は AGENTS.md 5節 `INVARIANTS.IDEMPOTENT_REPLAY` の定義に厳密に従う。
 *
 *   比較に含める  : document / document_version / derivation / artifact / access_control
 *   比較に含めない: observation の行数と observationId
 *   比較に含める  : observation の (kind, documentId) の**集合**
 *
 * Observation は追記専用なので行数は増えて当然。
 * ただし「どの種類の事実が起きたか」の集合は一致しなければならない（#26）。
 *
 * 定義に列挙されていない表（scan_run / processing_run / rename_candidate / source）は
 * 比較しない。走査そのものは再実行のたびに別の試行であり、
 * 「状態が一致する」という主張の対象ではないため。
 */

// ----------------------------------------------------------------------------
// 読み取り口
// ----------------------------------------------------------------------------

/**
 * スナップショットが必要とする最小限の読み取り口。
 *
 * 具体的なドライバに縛られないのは、テストが SQLite 実装の完成を
 * 待たずに比較規則を凍結できるようにするため。
 */
export interface SnapshotReader {
  all(sql: string): Promise<ReadonlyArray<Record<string, unknown>>>;
}
/**
 * **`as never` を足さないでください。** `node:sqlite` の `StatementSync.all()` は
 * `Record<string, SQLOutputValue>[]` を返し、これは上の型にそのまま代入できます
 * （@types/node ^22.10.2 で実測）。
 *
 * 呼び出し側6箇所に `as never` が付いていましたが、**1件も必要ありませんでした。**
 * `.all()` が `unknown[]` だった頃の名残です。ブランド型を洗う `as` と
 * 見分けがつかないので、必要のない型表明は残さないでください。
 */

// ----------------------------------------------------------------------------
// 比較対象の定義
// ----------------------------------------------------------------------------

/**
 * 全行を比較する表と、その主キー列。
 *
 * 列は `SELECT *` で取る。スキーマに列が増えたとき、
 * 黙って比較対象から漏れる方向ではなく、黙って比較対象に入る方向に倒す。
 * 見落として通過するより、増えて落ちるほうが安全なため。
 */
const COMPARED_TABLES = {
  document: ["document_id"],
  document_version: ["version_id"],
  derivation: ["derivation_key"],
  artifact: ["artifact_id"],
  access_control: ["document_id", "tenant_id"],
} as const satisfies Record<string, ReadonlyArray<string>>;

export type ComparedTable = keyof typeof COMPARED_TABLES;

/**
 * 既定で比較から外す列。
 *
 * document のこの3列は「いつ・どの走査で最後に見かけたか」という
 * 走査の生存記録であって、文書の状態ではない。
 * 再実行は定義上ちがう走査なので、ここは必ず変わる。
 *
 * lastSeen が更新されない不具合は findMissingSince 側の
 * DELETION_ONLY_FROM_COMPLETED_SCAN で捕まえる。冪等性の担当範囲ではない。
 *
 * この既定を変えたい場合は snapshotState に ignoreColumns を渡す。
 */
export const DEFAULT_IGNORED_COLUMNS: Readonly<Record<string, ReadonlyArray<string>>> = {
  document: ["last_seen_at", "last_seen_scan_id", "last_fingerprint_at"],
};

// ----------------------------------------------------------------------------
// スナップショット
// ----------------------------------------------------------------------------

export type Row = Readonly<Record<string, string | number | null>>;

export interface StateSnapshot {
  /** 表ごとの「主キー → 行」。キーは主キー列を \x00 で連結したもの */
  readonly tables: Readonly<Record<ComparedTable, ReadonlyMap<string, Row>>>;
  /**
   * observation の (kind, documentId) の集合。
   * 行数も observationId も含まない。
   */
  readonly observationKinds: ReadonlySet<string>;
}

export interface SnapshotOptions {
  /** 表ごとに比較から外す列。既定は DEFAULT_IGNORED_COLUMNS */
  readonly ignoreColumns?: Readonly<Record<string, ReadonlyArray<string>>>;
}

export async function snapshotState(
  reader: SnapshotReader,
  options: SnapshotOptions = {},
): Promise<StateSnapshot> {
  const ignore = options.ignoreColumns ?? DEFAULT_IGNORED_COLUMNS;
  const tables = {} as Record<ComparedTable, ReadonlyMap<string, Row>>;

  for (const [table, keyColumns] of Object.entries(COMPARED_TABLES)) {
    const name = table as ComparedTable;
    const dropped = new Set(ignore[name] ?? []);
    const rows = await reader.all(`SELECT * FROM ${name} ORDER BY ${keyColumns.join(", ")}`);

    const byKey = new Map<string, Row>();
    for (const raw of rows) {
      const key = keyColumns.map((c) => String(raw[c])).join("\x00");
      if (byKey.has(key)) {
        // 主キーが重複するのは ID 導出かスキーマが壊れた証拠。黙って上書きしない
        throw new Error(`duplicate primary key in ${name}: ${JSON.stringify(key)}`);
      }
      byKey.set(key, projectRow(name, raw, dropped));
    }
    tables[name] = byKey;
  }

  // 行数も observationId も読まない。読めば比較に混ぜてしまう余地が残るため
  const observations = await reader.all(
    "SELECT DISTINCT kind, document_id FROM observation ORDER BY kind, document_id",
  );
  const observationKinds = new Set(
    observations.map((o) => observationTag(String(o["kind"]), o["document_id"])),
  );

  return { tables, observationKinds };
}

/** (kind, documentId) の集合要素。documentId なしは "-" で表す */
function observationTag(kind: string, documentId: unknown): string {
  return `${kind}\x00${documentId == null ? "-" : String(documentId)}`;
}

function projectRow(
  table: string,
  raw: Record<string, unknown>,
  dropped: ReadonlySet<string>,
): Row {
  const out: Record<string, string | number | null> = {};
  for (const column of Object.keys(raw).sort()) {
    if (dropped.has(column)) continue;
    out[column] = normalizeValue(table, column, raw[column]);
  }
  return out;
}

/**
 * ドライバ差を吸収する。
 *
 * BIGINT を BigInt で返すドライバと number で返すドライバがあり、
 * そのまま比較すると環境ごとに結果が変わる。時刻とバイト数は
 * 安全整数の範囲に収まるので number に寄せ、収まらなければ落とす。
 */
function normalizeValue(table: string, column: string, value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new RangeError(`${table}.${column} exceeds safe integer range: ${value}`);
    }
    return Number(value);
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  throw new TypeError(`${table}.${column} has un-comparable type ${typeof value}`);
}

// ----------------------------------------------------------------------------
// 差分
// ----------------------------------------------------------------------------

export interface FieldChange {
  readonly column: string;
  readonly before: string | number | null;
  readonly after: string | number | null;
}

export interface RowDiff {
  readonly table: ComparedTable;
  readonly key: string;
  readonly kind: "added" | "removed" | "changed";
  readonly changes?: ReadonlyArray<FieldChange>;
}

export interface SnapshotDiff {
  readonly rows: ReadonlyArray<RowDiff>;
  /** 再実行後にだけ現れた observation の種類 */
  readonly observationKindsAdded: ReadonlyArray<string>;
  /** 再実行後に消えた observation の種類 */
  readonly observationKindsRemoved: ReadonlyArray<string>;
}

export function diffSnapshots(before: StateSnapshot, after: StateSnapshot): SnapshotDiff {
  const rows: RowDiff[] = [];

  for (const table of Object.keys(COMPARED_TABLES) as ComparedTable[]) {
    const a = before.tables[table];
    const b = after.tables[table];

    for (const [key, rowA] of a) {
      const rowB = b.get(key);
      if (rowB === undefined) {
        rows.push({ table, key, kind: "removed" });
        continue;
      }
      const changes = compareRows(rowA, rowB);
      if (changes.length > 0) rows.push({ table, key, kind: "changed", changes });
    }
    for (const key of b.keys()) {
      if (!a.has(key)) rows.push({ table, key, kind: "added" });
    }
  }

  return {
    rows,
    observationKindsAdded: setDifference(after.observationKinds, before.observationKinds),
    observationKindsRemoved: setDifference(before.observationKinds, after.observationKinds),
  };
}

function compareRows(a: Row, b: Row): FieldChange[] {
  const columns = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changes: FieldChange[] = [];
  for (const column of [...columns].sort()) {
    const before = a[column] ?? null;
    const after = b[column] ?? null;
    if (!Object.is(before, after)) changes.push({ column, before, after });
  }
  return changes;
}

function setDifference(from: ReadonlySet<string>, minus: ReadonlySet<string>): string[] {
  return [...from].filter((v) => !minus.has(v)).sort();
}

export function isEmptyDiff(diff: SnapshotDiff): boolean {
  return (
    diff.rows.length === 0 &&
    diff.observationKindsAdded.length === 0 &&
    diff.observationKindsRemoved.length === 0
  );
}

// ----------------------------------------------------------------------------
// アサーション
// ----------------------------------------------------------------------------

export function formatDiff(diff: SnapshotDiff): string {
  const lines: string[] = [];

  for (const row of diff.rows) {
    const key = row.key.split("\x00").join(" / ");
    if (row.kind === "changed") {
      lines.push(`~ ${row.table}[${key}]`);
      for (const c of row.changes ?? []) {
        lines.push(`    ${c.column}: ${format(c.before)} -> ${format(c.after)}`);
      }
    } else {
      lines.push(`${row.kind === "added" ? "+" : "-"} ${row.table}[${key}]`);
    }
  }

  // 行数の増加は差分ではない。種類の増減だけを差分として出す
  for (const tag of diff.observationKindsAdded) {
    lines.push(`+ observation kind ${readableTag(tag)}`);
  }
  for (const tag of diff.observationKindsRemoved) {
    lines.push(`- observation kind ${readableTag(tag)}`);
  }

  return lines.join("\n");
}

function readableTag(tag: string): string {
  const [kind = "", documentId = "-"] = tag.split("\x00");
  return `${kind} (document ${documentId})`;
}

function format(value: string | number | null): string {
  return value === null ? "NULL" : JSON.stringify(value);
}

/** 状態が一致しなければ、どこがどう違うかを添えて落とす */
export function assertSameState(
  before: StateSnapshot,
  after: StateSnapshot,
  context = "replay",
): void {
  const diff = diffSnapshots(before, after);
  if (isEmptyDiff(diff)) return;
  throw new Error(`IDEMPOTENT_REPLAY violated (${context}):\n${formatDiff(diff)}`);
}
