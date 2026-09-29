/**
 * crash-injecting-store の自己検証。
 *
 * 注入器そのものが壊れていると、それを使うテストは
 * 「落ちなかった」ではなく「落とせなかった」で緑になります。
 * `fired` / `reached` を公開しているのはそのためで、
 * ここではその2つが実際に数えられていることを確かめます。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { openStore, type StoreConnection } from "../../src/store/sqlite/connection.ts";
import { TestClock } from "./clock.ts";
import { CrashInjector, injectCrash, isInjectedCrash } from "./crash-injecting-store.ts";
import type { CrashPoint } from "./crash-injecting-store.ts";

let conn: StoreConnection;

const count = (table: string): number =>
  (conn.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

function addSource(id: string): void {
  conn.db
    .prepare(
      `INSERT INTO source (source_id, kind, config_hash, display_name,
         key_unicode_form, key_case_fold, key_path_separator, key_trim_slashes)
       VALUES (?, 'local-fs', 'cfg', ?, 'NFC', 0, 'posix', 1)`,
    )
    .run(id, id);
}

beforeEach(() => {
  conn = openStore({ clock: new TestClock(1000) });
});

afterEach(() => conn.close());

describe("CrashInjector: 注入点を名前で指定する", () => {
  it("before_commit は COMMIT の直前で落とす。書き込みは1行も残らない", () => {
    const crash = injectCrash(conn, { at: "before_commit" });
    assert.throws(
      () =>
        conn.transaction(() => {
          addSource("s1");
          // ここまでは成功している。COMMIT だけが失敗する
          assert.equal(count("source"), 1, "トランザクション内では見えている");
        }),
      isInjectedCrash,
    );
    crash.restore();
    assert.equal(count("source"), 0, "ROLLBACK されている");
    assert.equal(crash.fired, 1);
  });

  it("after_begin は BEGIN の直後で落とす", () => {
    const crash = injectCrash(conn, { at: "after_begin" });
    assert.throws(() => conn.transaction(() => addSource("s1")), isInjectedCrash);
    crash.restore();
    assert.equal(count("source"), 0, "本体は一度も実行されていない");
  });

  it("after_commit は COMMIT 成功後に落とす。状態は確定している", () => {
    const crash = injectCrash(conn, { at: "after_commit" });
    // COMMIT 済みなので接続層の ROLLBACK も失敗し、AggregateError になる。
    // 「確定したのに呼び出し側はそれを知らない」を型の上でも区別できる
    assert.throws(() => conn.transaction(() => addSource("s1")), AggregateError);
    crash.restore();
    assert.equal(count("source"), 1, "COMMIT は成功していた");
  });

  it("statement 系は SQL の部分文字列で選ぶ", () => {
    const crash = injectCrash(conn, { at: "before_statement", matching: "INSERT INTO source" });
    assert.throws(() => conn.transaction(() => addSource("s1")), isInjectedCrash);
    crash.restore();
    assert.equal(count("source"), 0);
  });

  it("after_statement は文の実行後に落とす。before_statement との違いはそこだけ", () => {
    // 注入をトランザクションの中で握って先へ進めると、その文の効果が既にあるか
    // どうかが見えます。握らずに外へ出すと、どちらもロールバックで 0 行になり、
    // **どちらの位置で落ちたのかは残りません**
    const rowsSeenAfterSwallowing = (at: CrashPoint): number => {
      const crash = injectCrash(conn, { at, matching: "INSERT INTO source" });
      let seen = -1;
      conn.transaction(() => {
        try {
          addSource("s1");
        } catch (error) {
          if (!isInjectedCrash(error)) throw error;
        }
        seen = count("source");
      });
      assert.equal(crash.fired, 1, `${at} に一度も到達していない`);
      crash.restore();
      conn.db.exec("DELETE FROM source");
      return seen;
    };

    assert.equal(rowsSeenAfterSwallowing("before_statement"), 0, "文はまだ実行されていない");
    assert.equal(rowsSeenAfterSwallowing("after_statement"), 1, "文は実行済み");
  });

  it("一致しない文では落ちない", () => {
    const crash = injectCrash(conn, { at: "before_statement", matching: "INSERT INTO document" });
    conn.transaction(() => addSource("s1"));
    crash.restore();
    assert.equal(count("source"), 1);
    assert.equal(crash.fired, 0);
    assert.equal(crash.reached, 0, "到達すらしていない");
  });

  it("statement 系に matching が無ければ arm を拒む", () => {
    // 全文で落ちる注入は、どの文で落ちたのかがテストから読めない
    assert.throws(() => injectCrash(conn, { at: "after_statement" }), TypeError);
    assert.throws(
      () => injectCrash(conn, { at: "before_statement", matching: "" }),
      TypeError,
    );
  });

  it("SQL 文字列そのものを注入点にはできない（名前だけ）", () => {
    // 落ちるのはコンパイル時です。SQL 文字列を注入点にできると、
    // 接続層が COMMIT を END に変えた瞬間、テストは落ちなくなるのに緑のままになります
    // @ts-expect-error CrashPoint に SQL 文字列は無い
    const notAPoint: CrashPoint = "COMMIT";
    assert.equal(notAPoint, "COMMIT");
  });
});

/**
 * ロールバック経路の2点。
 *
 * この2つは他の注入点と性質が違います。**接続層から見ると、注入された例外は
 * 「ROLLBACK が失敗した」と区別がつきません。** `connection.ts` の `transaction` は
 * `db.exec("ROLLBACK")` の失敗を捕まえて `AggregateError` にまとめるので、
 * 呼び出し側に届くのは `InjectedCrash` ではなく `AggregateError` で、
 * 注入はその `errors[1]` に入って運ばれます。
 *
 * **例外の形が同じなのに、接続の生死は逆になります。**
 *
 *   - `before_rollback` … 実 ROLLBACK が発行されない。**トランザクションは開いたまま**
 *   - `after_rollback`  … 実 ROLLBACK は成功済み。状態は巻き戻り、接続は使える
 *
 * `after_rollback` は KNOWN_LIMITATIONS 9節が名指ししている窓の位置でもあります。
 * `commitDerivation` は分岐と失効ワーカーの観測を**ロールバック後の別トランザクション**で
 * 書き直すので、ここで落ちると「状態は正しいが記録は残らない」が成立します。
 */
describe("CrashInjector: ロールバック経路の注入点", () => {
  /** 本体で失敗させる。ROLLBACK 経路に入らないと、この2点には到達しない */
  const failingBody = (): void => {
    addSource("s1");
    throw new Error("boom");
  };

  /** 元の例外とロールバック失敗の両方が残っていること */
  const carriesBoth = (error: unknown): boolean => {
    assert.ok(error instanceof AggregateError, `AggregateError ではない: ${String(error)}`);
    assert.equal(error.errors.length, 2);
    const [original, secondary] = error.errors;
    assert.ok(original instanceof Error);
    assert.equal(original.message, "boom", "元の例外が握り潰されていない");
    assert.ok(isInjectedCrash(secondary), "注入が errors[1] に運ばれている");
    return true;
  };

  it("before_rollback は ROLLBACK の発行前に落とす。トランザクションは開いたまま残る", () => {
    const crash = injectCrash(conn, { at: "before_rollback" });
    assert.throws(() => conn.transaction(failingBody), carriesBoth);
    assert.equal(crash.fired, 1);
    crash.restore();

    // 実 ROLLBACK が一度も発行されていないので、書いた行は同じ接続から見えたままです。
    // コミットはされていません（別接続からは見えない）が、この接続からは区別できません
    assert.equal(count("source"), 1, "巻き戻っていない");

    // **接続がここで使えなくなります。しかも止めているのは接続層ではなく SQLite です。**
    // `transaction` の深さカウンタは finally で 0 に戻っているので、
    // ネスト検査はこの呼び出しを通します。カウンタと実体がずれている
    assert.throws(
      () => conn.transaction(() => addSource("s2")),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /nested transaction/, "深さ検査で止まっている");
        assert.match(error.message, /within a transaction/);
        return true;
      },
    );
    // 開いたままの接続は afterEach の close() が畳みます
  });

  it("after_rollback は ROLLBACK 成功後に落とす。状態は巻き戻り、接続は使える", () => {
    const crash = injectCrash(conn, { at: "after_rollback" });
    assert.throws(() => conn.transaction(failingBody), carriesBoth);
    assert.equal(crash.fired, 1);
    crash.restore();

    assert.equal(count("source"), 0, "ROLLBACK は成功していた");

    // before_rollback との違いはここだけです。同じ形の AggregateError が届くのに、
    // 片方は接続が死に、片方は生きています。**例外の形では区別できません**
    conn.transaction(() => addSource("s2"));
    assert.equal(count("source"), 1, "接続は続けて使える");
  });
});

describe("CrashInjector: 何回目で落とすか", () => {
  it("既定は最初の到達で1回だけ", () => {
    const crash = injectCrash(conn, { at: "before_statement", matching: "INSERT INTO source" });
    assert.throws(() => conn.transaction(() => addSource("s1")), isInjectedCrash);
    // 2回目は素通りする
    conn.transaction(() => addSource("s2"));
    crash.restore();
    assert.equal(crash.fired, 1);
    assert.equal(count("source"), 1);
  });

  it("occurrence で N 回目を指定できる", () => {
    const crash = injectCrash(conn, {
      at: "before_statement",
      matching: "INSERT INTO source",
      occurrence: 3,
    });
    conn.transaction(() => addSource("s1"));
    conn.transaction(() => addSource("s2"));
    assert.throws(() => conn.transaction(() => addSource("s3")), isInjectedCrash);
    conn.transaction(() => addSource("s4"));
    crash.restore();

    assert.equal(crash.fired, 1);
    assert.equal(count("source"), 3, "s3 だけが失敗した");
  });

  it("repeat で以降すべてを落とす", () => {
    const crash = injectCrash(conn, {
      at: "before_statement",
      matching: "INSERT INTO source",
      occurrence: 2,
      repeat: true,
    });
    conn.transaction(() => addSource("s1"));
    assert.throws(() => conn.transaction(() => addSource("s2")), isInjectedCrash);
    assert.throws(() => conn.transaction(() => addSource("s3")), isInjectedCrash);
    crash.restore();
    assert.equal(crash.fired, 2);
    assert.equal(count("source"), 1);
  });

  it("occurrence は 1 以上の整数だけ", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => injectCrash(conn, { at: "before_commit", occurrence: bad }), TypeError);
    }
  });

  it("同じ手順を繰り返すと必ず同じ場所で落ちる（時間に依存しない）", () => {
    const where: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      const c = openStore({ clock: new TestClock(1000) });
      const crash = injectCrash(c, {
        at: "before_statement",
        matching: "INSERT INTO source",
        occurrence: 2,
      });
      let failedAt = -1;
      for (let i = 0; i < 4; i += 1) {
        try {
          c.transaction(() =>
            c.db
              .prepare(
                `INSERT INTO source (source_id, kind, config_hash, display_name,
                   key_unicode_form, key_case_fold, key_path_separator, key_trim_slashes)
                 VALUES (?, 'local-fs', 'cfg', ?, 'NFC', 0, 'posix', 1)`,
              )
              .run(`s${i}`, `s${i}`),
          );
        } catch (error) {
          assert.ok(isInjectedCrash(error));
          failedAt = i;
        }
      }
      crash.restore();
      c.close();
      where.push(failedAt);
    }
    assert.deepEqual(where, [1, 1, 1]);
  });
});

describe("CrashInjector: 後片付け", () => {
  it("restore すると元の接続に戻る", () => {
    const crash = new CrashInjector(conn).arm({ at: "before_commit" });
    crash.restore();
    conn.transaction(() => addSource("s1"));
    assert.equal(count("source"), 1);
    assert.equal(crash.fired, 0);
  });

  it("restore は2回呼んでも壊れない", () => {
    const crash = injectCrash(conn, { at: "before_commit" });
    crash.restore();
    crash.restore();
    conn.transaction(() => addSource("s1"));
    assert.equal(count("source"), 1);
  });

  it("disarm すると注入だけ止まる。arm し直せる", () => {
    const crash = injectCrash(conn, { at: "before_commit" });
    crash.disarm();
    conn.transaction(() => addSource("s1"));

    crash.arm({ at: "before_commit" });
    assert.throws(() => conn.transaction(() => addSource("s2")), isInjectedCrash);
    crash.restore();
    assert.equal(count("source"), 1);
  });

  it("arm し直すとカウンタは 0 から数え直す", () => {
    const crash = injectCrash(conn, {
      at: "before_statement",
      matching: "INSERT INTO source",
      occurrence: 2,
    });
    conn.transaction(() => addSource("s1"));
    assert.equal(crash.reached, 1);

    crash.arm({ at: "before_statement", matching: "INSERT INTO source", occurrence: 2 });
    assert.equal(crash.reached, 0);
    conn.transaction(() => addSource("s2"));
    assert.throws(() => conn.transaction(() => addSource("s3")), isInjectedCrash);
    crash.restore();
  });

  it("包んでいる間も読み取りは素通しする", () => {
    addSource("s1");
    const crash = injectCrash(conn, { at: "before_commit" });
    // 注入点に到達しない操作は、包む前とまったく同じ結果になる
    const rows = conn.db
      .prepare("SELECT source_id FROM source ORDER BY source_id")
      .all() as { source_id: string }[];
    crash.restore();
    assert.deepEqual(
      rows.map((r) => r.source_id),
      ["s1"],
    );
  });
});
