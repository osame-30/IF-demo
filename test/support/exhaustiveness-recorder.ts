/**
 * AC-EXH-01/02 の**実行時**収集器。
 *
 * 網羅性を「宣言と記述の一致」で見ると、`kind: "quarantined"` と書かれた行が
 * どこかにありさえすれば緑になります。書かれていても**到達しない**行は
 * それで素通りします。ここで集めるのは記述ではなく、
 * **走行中に実際に起きたこと**です。
 *
 * 収集点は2つ。どちらも src には手を入れず、外から包みます。
 *
 *   1. `observation` テーブルへの INSERT — 観測はすべてここを通ります
 *      （`#observe` は private ですが、SQL は1本しかないので出口で捕まえられます）。
 *   2. `StoreError` の**構築** — 全サブクラスが `super(code, ...)` を通るので、
 *      各サブクラスの [[Prototype]]（＝`super` の解決先）を、構築を記録する
 *      Proxy に差し替えれば、送出のたびに必ず通ります。
 *
 * 2 で `code` の代入を prototype の setter で拾う案は**使えません（実測）**。
 * `readonly code: StoreErrorCode;` はフィールド宣言なので、`target: ES2023` の
 * define セマンティクスではインスタンスに own プロパティが先に作られ、
 * 代入は prototype の setter に届きません。
 *
 * **環境変数が無ければ何もしません。** 通常のテスト実行は素通りします。
 * 有効なのは exhaustiveness.test.ts が張った子プロセスの中だけです。
 */

import { appendFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import * as errors from "../../src/domain/errors.ts";

export const SINK_ENV = "INGESTION_EXHAUSTIVENESS_SINK";

const sink = process.env[SINK_ENV];

/** 1行1事象。プロセスを跨いで合流させるので追記のみ */
function record(line: string): void {
  if (sink === undefined) return;
  try {
    appendFileSync(sink, `${line}\n`);
  } catch {
    // 収集の失敗でテスト本体を落とさない。欠落は突き合わせ側で「未到達」として出る
  }
}

/**
 * ストア自身が観測を書く文。**この1本だけを数えます。**
 *
 * `INSERT INTO observation` を広く拾うと、テストが生 SQL で差し込んだ行まで
 * 数えてしまいます（不変条件の検査には、わざと壊れた行を入れるものがあります）。
 * それを数えると「テストが書けば到達したことになる」ので、
 * 網羅性の主張が逆立ちします。数えるのは `#observe` の出口だけです。
 *
 * 文が変わればここは一致しなくなり、収集は 0 に落ちます。
 * 黙って緑にならないよう、突き合わせ側に収集件数の下限があります。
 */
const OBSERVE_SQL =
  "INSERT INTO observation (observation_id, kind, document_id, version_id, scan_id, run_id, occurred_at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

/**
 * その文の中で `kind` が何番目のバインドかを、**SQL 自身から**読む。
 *
 * 位置を定数で持つと、列の順序が変わったときに別の列を kind として記録します。
 * 静かに嘘の網羅性が出ます。
 */
function kindIndex(sql: string): number {
  if (sql.replace(/\s+/g, " ").trim() !== OBSERVE_SQL) return -1;
  const columns = /\(([^)]*)\)/.exec(OBSERVE_SQL)?.[1] ?? "";
  return columns.split(",").findIndex((c) => c.trim() === "kind");
}

if (sink !== undefined) {
  // --- 1. 観測 ---
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function patched(this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    const index = kindIndex(sql);
    if (index < 0) return statement;

    const target = statement as unknown as { run: (...args: unknown[]) => unknown };
    const run = target.run.bind(statement);
    target.run = (...args: unknown[]) => {
      // 記録は **run が通った後**。CHECK 制約が弾いた kind まで数えると、
      // 「不正な kind を投げるテスト」が網羅性の証拠になってしまう
      const result = run(...args);
      const kind = args[index];
      if (typeof kind === "string") record(`observation\t${kind}`);
      return result;
    };
    return statement;
  } as typeof prepare;

  // --- 2. StoreError ---
  // `super(code, ...)` は派生クラスの [[Prototype]] を [[Construct]] する。
  // そこを Proxy に差し替えると、どのサブクラスの構築もここを通る。
  // instanceof も isStoreError も、プロトタイプ鎖は動かさないので影響を受けない
  const recording = new Proxy(errors.StoreError, {
    construct(base, args: unknown[], newTarget) {
      if (typeof args[0] === "string") record(`error\t${args[0]}`);
      return Reflect.construct(base, args as ConstructorParameters<typeof base>, newTarget);
    },
  });
  for (const exported of Object.values(errors)) {
    if (
      typeof exported === "function" &&
      exported !== errors.StoreError &&
      errors.StoreError.prototype.isPrototypeOf(exported.prototype ?? {})
    ) {
      Object.setPrototypeOf(exported, recording);
    }
  }
}
