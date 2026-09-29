/**
 * 決定的なクラッシュ注入。
 *
 * FIXTURES.md は「`LineageStore` をラップする `CrashInjectingStore`」と書いていますが、
 * **ラップするのは接続層です。** 理由は2つあります。
 *
 *   1. 「部分成立が無い」（#9）はトランザクションの性質であって、
 *      メソッドの性質ではありません。`LineageStore` の外側で例外を投げても、
 *      BEGIN と COMMIT の間には一度も入れません。COMMIT 直前で落とすには
 *      COMMIT を発行する層に手が届いている必要があります。
 *   2. 実装本体に注入フックを持たせると、本番のコードに
 *      「テストのためだけの分岐」が残ります。それは AGENTS.md 6節が
 *      禁じている「将来必要になりそうだから」の抽象化と同じ形です。
 *
 * **プロセスは落としません。** 落とす必要もありません。SQLite の原子性は
 * 「COMMIT が完了したか」だけで決まるので、COMMIT を失敗させれば
 * 電源断と同じ状態になります。プロセスを実際に落とすと、
 * 何が起きたかをテストが観測できなくなるだけです。
 *
 * **タイミングやスリープに依存しません。** 注入点は名前で指定し、
 * 到達回数で数えます。同じテストは何度走らせても同じ場所で落ちます。
 *
 * **注入フックはすべて同期です。** `LineageStore` の
 * 「トランザクションの内側で await しない」規約を壊さないためです。
 * ここで await を挟むと、BEGIN IMMEDIATE と COMMIT の間で
 * イベントループへ制御が戻り、注入していない別の事故を作ります。
 */

import type { StoreConnection } from "../../src/store/sqlite/connection.ts";

// ----------------------------------------------------------------------------
// 注入点
// ----------------------------------------------------------------------------

/**
 * 注入点の名前。**SQL 文字列そのものは指定しません。**
 *
 * `"COMMIT" という文字列が来たら落とす` という書き方だと、接続層が
 * `COMMIT TRANSACTION` や `END` に変わった瞬間、テストは落ちなくなるのに
 * 緑のままになります。「落ちなかった」と「落とせなかった」が区別できません。
 */
export type CrashPoint =
  /** BEGIN が成功した直後。トランザクションは開いている */
  | "after_begin"
  /** COMMIT を発行する直前。書き込みはすべて済んでいて未確定 */
  | "before_commit"
  /** COMMIT が成功した直後。状態は確定しているが呼び出し側はそれを知らない */
  | "after_commit"
  /** ROLLBACK を発行する直前 */
  | "before_rollback"
  /** ROLLBACK が成功した直後。KNOWN_LIMITATIONS 9節の窓がここ */
  | "after_rollback"
  /** `matching` に一致する文の実行直前 */
  | "before_statement"
  /** `matching` に一致する文の実行直後 */
  | "after_statement";

export interface CrashSpec {
  readonly at: CrashPoint;
  /**
   * 文の選択条件。SQL に含まれる部分文字列で選びます。
   * `before_statement` / `after_statement` では**必須**です。
   *
   * 省略を許すと「全文で落ちる」注入が事故で生まれ、
   * どの文で落ちたのかがテストから読めなくなります。
   */
  readonly matching?: string;
  /**
   * 何回目の到達で落とすか。1 起点。既定は 1。
   *
   * 「1回だけ失敗」は occurrence:1、「N回目に失敗」は occurrence:N です。
   * 到達回数は `matching` で絞り込んだ後に数えます。
   */
  readonly occurrence?: number;
  /** occurrence 回目以降ずっと落とし続けるか。既定 false（1回だけ） */
  readonly repeat?: boolean;
}

/**
 * 注入された例外。
 *
 * 本物の失敗と区別できる型にしてあります。区別できないと、
 * 「注入した通りに落ちた」と「注入とは無関係に落ちた」が同じに見え、
 * テストが理由を取り違えたまま緑になります。
 */
export class InjectedCrash extends Error {
  readonly point: CrashPoint;
  readonly sql: string;
  readonly occurrence: number;

  constructor(point: CrashPoint, sql: string, occurrence: number) {
    super(`crash injected at ${point} (occurrence ${occurrence}): ${sql}`);
    this.name = "InjectedCrash";
    this.point = point;
    this.sql = sql;
    this.occurrence = occurrence;
  }
}

export function isInjectedCrash(error: unknown): error is InjectedCrash {
  return error instanceof InjectedCrash;
}

// ----------------------------------------------------------------------------
// 注入器
// ----------------------------------------------------------------------------

type ExecFn = (sql: string) => void;
type PrepareFn = (sql: string) => unknown;
type Kind = "begin" | "commit" | "rollback" | "other";

/** 文の種類を判定する。接続層が発行する制御文だけを名前で識別する */
function classify(sql: string): Kind {
  const head = sql.trim().toUpperCase();
  if (head.startsWith("BEGIN")) return "begin";
  if (head.startsWith("COMMIT") || head === "END") return "commit";
  if (head.startsWith("ROLLBACK")) return "rollback";
  return "other";
}

const STATEMENT_POINTS: ReadonlySet<CrashPoint> = new Set([
  "before_statement",
  "after_statement",
]);

/**
 * `StoreConnection` の `db` に注入フックを差し込む。
 *
 * `StoreConnection` 自体は差し替えません。`SqliteLineageStore` は
 * `conn.db.prepare(...)` と、接続層が発行する `exec` の両方を通るので、
 * その2つを覆えば BEGIN と COMMIT の間に立てます。
 *
 * 1つの接続に同時に armed できる仕様は1つだけです。複数の注入点を
 * 同時に仕掛けたくなったら、それは1つのテストが2つのことを見ている合図です。
 */
export class CrashInjector {
  readonly #db: { exec: ExecFn; prepare: PrepareFn };
  readonly #realExec: ExecFn;
  readonly #realPrepare: PrepareFn;

  #spec: CrashSpec | null = null;
  #seen = 0;
  #fired = 0;
  #installed = true;

  constructor(connection: StoreConnection) {
    this.#db = connection.db as unknown as { exec: ExecFn; prepare: PrepareFn };
    this.#realExec = this.#db.exec.bind(connection.db);
    this.#realPrepare = this.#db.prepare.bind(connection.db);

    this.#db.exec = (sql: string): void => this.#exec(sql);
    this.#db.prepare = (sql: string): unknown => this.#prepare(sql);
  }

  /** 何回落としたか。0 のまま終わったテストは、注入点に一度も到達していない */
  get fired(): number {
    return this.#fired;
  }

  /** 注入点への到達回数（`matching` で絞り込んだ後） */
  get reached(): number {
    return this.#seen;
  }

  /**
   * 注入を仕掛ける。カウンタは毎回 0 から数え直します。
   *
   * @returns 自分自身。`arm` してすぐ使えるように
   */
  arm(spec: CrashSpec): this {
    if (STATEMENT_POINTS.has(spec.at) && (spec.matching ?? "") === "") {
      // 全文で落ちる注入は、どの文で落ちたのかがテストから読めない
      throw new TypeError(`${spec.at} requires a non-empty "matching"`);
    }
    const occurrence = spec.occurrence ?? 1;
    if (!Number.isSafeInteger(occurrence) || occurrence < 1) {
      throw new TypeError(`occurrence must be a positive integer, got ${occurrence}`);
    }
    this.#spec = spec;
    this.#seen = 0;
    this.#fired = 0;
    return this;
  }

  /** 注入を解除する。ラップは残るので、また arm できる */
  disarm(): void {
    this.#spec = null;
  }

  /**
   * 元のメソッドに戻す。
   *
   * `afterEach` で必ず呼んでください。戻し忘れると、この接続を使う
   * 後続のテストが「なぜか落ちる」形で汚染されます。
   */
  restore(): void {
    if (!this.#installed) return;
    this.#db.exec = this.#realExec;
    this.#db.prepare = this.#realPrepare;
    this.#installed = false;
    this.#spec = null;
  }

  [Symbol.dispose](): void {
    this.restore();
  }

  // --------------------------------------------------------------------------
  // 内部
  // --------------------------------------------------------------------------

  #exec(sql: string): void {
    const kind = classify(sql);

    if (kind === "commit") this.#maybe("before_commit", sql);
    else if (kind === "rollback") this.#maybe("before_rollback", sql);
    else if (kind === "other") this.#maybe("before_statement", sql);

    this.#realExec(sql);

    if (kind === "begin") this.#maybe("after_begin", sql);
    else if (kind === "commit") this.#maybe("after_commit", sql);
    else if (kind === "rollback") this.#maybe("after_rollback", sql);
    else this.#maybe("after_statement", sql);
  }

  /**
   * 文を包む。`run` / `get` / `all` / `iterate` の前後だけを覗きます。
   *
   * Proxy を使うのは、`node:sqlite` の StatementSync が今後メソッドを増やしても
   * ここを直さずに済ませるためです。列挙し忘れたメソッドが黙って消えると、
   * 「テストのラッパー経由だと動かない」という本題と無関係の不具合になります。
   */
  #prepare(sql: string): unknown {
    const statement = this.#realPrepare(sql) as object;
    const self = this;

    return new Proxy(statement, {
      get(target, property, _receiver) {
        // receiver に target を渡す。ネイティブクラスの内部スロットは Proxy 越しに読めない
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;

        const fn = value as (...args: unknown[]) => unknown;
        if (property !== "run" && property !== "get" && property !== "all" && property !== "iterate") {
          return fn.bind(target);
        }
        return (...args: unknown[]): unknown => {
          self.#maybe("before_statement", sql);
          const result = fn.apply(target, args);
          self.#maybe("after_statement", sql);
          return result;
        };
      },
    });
  }

  /** 注入点に到達した。数えて、条件が揃っていれば落とす */
  #maybe(point: CrashPoint, sql: string): void {
    const spec = this.#spec;
    if (spec === null || spec.at !== point) return;
    if (spec.matching !== undefined && !sql.includes(spec.matching)) return;

    this.#seen += 1;
    const occurrence = spec.occurrence ?? 1;
    const hit = spec.repeat === true ? this.#seen >= occurrence : this.#seen === occurrence;
    if (!hit) return;

    this.#fired += 1;
    throw new InjectedCrash(point, sql, this.#seen);
  }
}

/**
 * 注入器を作って仕掛ける。
 *
 * ```ts
 * using crash = injectCrash(conn, { at: "before_commit" });
 * await assert.rejects(() => store.commitDerivation(...), isInjectedCrash);
 * ```
 */
export function injectCrash(connection: StoreConnection, spec: CrashSpec): CrashInjector {
  return new CrashInjector(connection).arm(spec);
}
