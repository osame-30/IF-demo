/**
 * SQLite 接続とトランザクション。
 *
 * PRAGMA は schema.sql ではなくここに置きます。DDL ではなく接続の設定であり、
 * SQLite では接続ごとに効くためです。とくに `foreign_keys` は**既定が OFF** で、
 * 設定を忘れた接続では複合 FK の防御が丸ごと消えます。
 *
 * 書き込みは必ず `transaction()` を通します。SQLite の暗黙トランザクションは
 * 文ごとにコミットするので、「Derivation + 全 Artifact + run 完了が
 * 同一トランザクション」（#9）が成立しません。
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Clock } from "../../domain/clock.ts";

const SCHEMA_PATH = fileURLToPath(new URL("../../../schema.sql", import.meta.url));

export interface OpenOptions {
  /** ファイルパス、または ":memory:"。既定は ":memory:" */
  readonly location?: string;
  /** ストアの時計。BlobStore と**同一インスタンス**を渡すこと（#14） */
  readonly clock: Clock;
  /**
   * ロック競合を待つミリ秒。既定 5000。
   *
   * **0 にしてよいのは #12 の競合再現テストだけです。** 本番接続で 0 にすると
   * 「競合している」が「既にリースされている」と区別できなくなります。
   */
  readonly busyTimeoutMs?: number;
  /** 既存 DB を開く場合は false。既定 true */
  readonly applySchema?: boolean;
}

export interface StoreConnection {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  /** 事象 ID の採番。scanId / runId / observationId はここからしか出ない */
  newEventId(): string;
  /** BEGIN IMMEDIATE で書き込みトランザクションを張る */
  transaction<T>(fn: () => T): T;
  /**
   * BEGIN DEFERRED で読み取りトランザクションを張る。
   *
   * 複数の SELECT が同じスナップショットを見る必要がある場面用です。
   * 書き込みロックを取らないので、読み手が書き手を止めません。
   */
  read<T>(fn: () => T): T;
  /** 現在トランザクションの内側か。入れ子呼び出しの判断に使う */
  inTransaction(): boolean;
  close(): void;
}

export function openStore(options: OpenOptions): StoreConnection {
  const location = options.location ?? ":memory:";
  const db = new DatabaseSync(location);

  // 既定 OFF。ここを忘れると FK による防御が静かに消える
  db.exec("PRAGMA foreign_keys = ON");
  // クラッシュ注入テストの前提を成立させる
  db.exec("PRAGMA synchronous = FULL");
  db.exec(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? 5000)}`);
  // WAL はファイル DB でのみ意味を持つ。メモリ DB では設定できない
  if (location !== ":memory:") db.exec("PRAGMA journal_mode = WAL");

  if (options.applySchema ?? true) db.exec(readFileSync(SCHEMA_PATH, "utf8"));

  let depth = 0;

  return {
    db,
    clock: options.clock,

    /**
     * UUIDv4 を使います。v7 でもよいはずですが、v7 は時刻が埋まっているため
     * 「事象 ID を整列に使う」誘惑が生まれます。事象 ID に順序は無く、
     * 順序が要るときは started_at / finished_at / completion_seq を見ます。
     * 構造的に整列できない v4 のほうが規約を守らせやすい。
     */
    newEventId: () => randomUUID(),

    inTransaction: () => depth > 0,

    read<T>(fn: () => T): T {
      // 既にトランザクションの内側なら、そのスナップショットに乗る
      if (depth > 0) return fn();
      db.exec("BEGIN DEFERRED");
      depth += 1;
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "read transaction failed and rollback also failed",
          );
        }
        throw error;
      } finally {
        depth -= 1;
      }
    },

    transaction<T>(fn: () => T): T {
      if (depth > 0) {
        // SQLite にネストしたトランザクションは無い。SAVEPOINT で代用すると
        // 「途中まで成立」が生まれ #9 の前提が崩れるので、呼び出し側の誤りとして落とす
        throw new Error(
          "nested transaction: compose the work into a single transaction instead",
        );
      }
      db.exec("BEGIN IMMEDIATE");
      depth += 1;
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch (rollbackError) {
          // 握りつぶさない。元の例外もロールバック失敗も両方残す
          throw new AggregateError(
            [error, rollbackError],
            "transaction failed and rollback also failed",
          );
        }
        throw error;
      } finally {
        depth -= 1;
      }
    },

    close() {
      db.close();
    },
  };
}
