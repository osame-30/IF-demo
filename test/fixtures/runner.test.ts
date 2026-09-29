/**
 * 敵対フィクスチャのランナー。
 *
 * 各フィクスチャは真新しいメモリ DB と固定時計で走ります。
 * 実行順に依存しません。1本だけ走らせても、全部走らせても同じ結果になります。
 *
 * ## FIXTURES.md との突き合わせ
 *
 * ファイルが存在することを網羅の証拠にしません。**FIXTURES.md の表を読み、
 * 行とファイルが1対1であること、宣言された不変条件が一致することを検査します。**
 * 「フィクスチャを書き忘れた」と「書いたが不変条件を1つ落とした」は、
 * どちらもファイルを数えるだけでは見えません。
 *
 * 対象群を定数で持ちます。**そこに無い群を FIXTURES.md が宣言していたら落ちます。**
 * 以前は黙って読み飛ばしていたので、`keys/` の3行が表にあるのに1本も存在しない、
 * という食い違いが**どのテストにも現れませんでした**（実測。2026-09-09 に発覚）。
 * 読み飛ばした群を控えて、下で突き合わせます。
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { assertInvariants, checkInvariants } from "../support/invariant-checker.ts";
import { createFixtureContext, type Fixture } from "./context.ts";
import { INVARIANTS } from "../../src/domain/types.ts";
import type { InvariantName } from "../../src/domain/types.ts";

/** 回す群。FIXTURES.md が宣言する群はすべてここに無ければならない */
const GROUPS = ["keys", "scan", "observe", "lease", "commit", "blob"] as const;

/** GROUPS に無いのに FIXTURES.md が宣言していた群。**空でなければ落とす** */
const unknownGroups = new Set<string>();

const HERE = fileURLToPath(new URL(".", import.meta.url));
const FIXTURES_MD = fileURLToPath(new URL("../../FIXTURES.md", import.meta.url));

interface DeclaredRow {
  readonly scenario: number;
  readonly path: string;
  readonly group: string;
  readonly assertions: ReadonlyArray<InvariantName>;
  readonly deferred: boolean;
}

/** FIXTURES.md の表から v0.1 / deferred の行を読む */
function readDeclaredRows(): DeclaredRow[] {
  const text = readFileSync(FIXTURES_MD, "utf8");
  const out: DeclaredRow[] = [];

  for (const line of text.split("\n")) {
    const m = /^\|\s*(\d+)\s*\|\s*`([^`]+)`\s*\|([^|]*)\|([^|]*)\|/.exec(line);
    if (m === null) continue;

    const path = m[2]!.trim();
    const group = path.split("/")[0] ?? "";
    if (!(GROUPS as ReadonlyArray<string>).includes(group)) {
      unknownGroups.add(group);
      continue;
    }

    const scope = m[4]!.trim();
    const names = m[3]!
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    // 表に書かれた名前が INVARIANTS に無ければ、表かコードのどちらかが古い
    for (const name of names) {
      assert.ok(name in INVARIANTS, `FIXTURES.md names an unknown invariant: ${name} (${path})`);
    }

    out.push({
      scenario: Number(m[1]),
      path,
      group,
      assertions: names as InvariantName[],
      deferred: scope.startsWith("deferred"),
    });
  }
  return out;
}

const declared = readDeclaredRows();

/**
 * 宣言した「起きるはずの違反」が**実際に起きた**ことを確かめる。
 *
 * `assertInvariants` の側は「名指しされた違反は落とさない」しか見ません。
 * それだけだと、攻撃が何らかの理由で不発に終わったフィクスチャが
 * 「違反が無かった」ことを理由に緑になります。空振りが最も危険なので、
 * ここで逆向きにも検査します。
 */
function assertExpectedViolationsOccurred(
  report: Awaited<ReturnType<typeof checkInvariants>>,
  fixture: Fixture,
  path: string,
): void {
  for (const expected of fixture.expectedViolations ?? []) {
    assert.ok(
      fixture.assertions.includes(expected.invariant),
      `${path}: expectedViolations names ${expected.invariant}, which is not in assertions`,
    );
    // 理由を書けないなら、それはストアの欠陥を黙らせようとしている
    assert.ok(
      expected.reason.trim().length > 0,
      `${path}: expectedViolations entries must state why the broken invariant is a claim ` +
        "about the world rather than about the store",
    );
    const result = report.results.find((r) => r.name === expected.invariant);
    assert.ok(
      result?.findings.some((f) => f.problem === expected.problem),
      `${path}: expected ${expected.invariant}/${expected.problem} to be violated, but it was not. ` +
        "The attack did not land; a fixture that no longer reproduces its scenario must fail.",
    );
  }
}

/**
 * `expectedViolations` を持つフィクスチャの上限。
 *
 * この仕組みは「不変条件が破れたまま緑にする」ものなので、増えれば消音ボタンに
 * なります。**歯止めを散文の規約に置くと守られません。**この設計が規約を型と
 * 検査に落としてきた理由が、そのままここにも当てはまります。
 *
 * 2件目を入れたい場合、この数を上げる前にオーナーに上げること。数を上げる
 * コミットは差分に必ず現れるので、黙って増えることがありません。
 */
const MAX_FIXTURES_WITH_EXPECTED_VIOLATIONS = 1;

describe("FIXTURES.md との突き合わせ", () => {
  it("表に v0.1 の行が読めている（正規表現が空振りしていない）", () => {
    // 0本でも「全部一致」になってしまう。前提そのものを検査する
    assert.ok(declared.length >= 20, `only ${declared.length} rows parsed from FIXTURES.md`);
  });

  for (const group of GROUPS) {
    it(`${group}/ の行とファイルが1対1で対応する`, () => {
      const dir = join(HERE, group);
      assert.ok(existsSync(dir), `missing fixture directory: ${group}/`);

      const onDisk = readdirSync(dir)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => `${group}/${f}`)
        .sort();
      const inDoc = declared
        .filter((r) => r.group === group)
        .map((r) => r.path)
        .sort();

      assert.deepEqual(onDisk, inDoc);
    });
  }

  /**
   * skip は**報告行ではなく主張**にする。
   *
   * `deferred` なフィクスチャは中身が空のスタブです。**主張を1つも持たないので、
   * skip されなくなった瞬間に「何もせず緑」に変わります。** 落ちません。
   * 「1 skip」を実行結果として眺めているだけだと、この変化は
   * 数字が 1 から 0 に減るだけで、報告を読む人の注意力に頼ることになります。
   *
   * ここで3つを突き合わせます — 下のリスト / FIXTURES.md の表 / 各モジュールの export。
   * 増えても減っても落ちます。
   */
  const DEFERRED: ReadonlyArray<string> = ["observe/acl-fetch-timeout.ts"];

  it("FIXTURES.md が宣言する群はすべて GROUPS に入っている", () => {
    // **これが無い間、表と実装の食い違いは黙って読み飛ばされていました。**
    // `keys/` の3行は v0.1 と宣言されているのに1本も存在せず、
    // しかも `CANONICAL_KEY_STABILITY` は誰も供給しないので not_checked のまま。
    // 「最優先で書くこと」と表自身が書いている群が、丸ごと国勢調査の外にありました。
    assert.deepEqual(
      [...unknownGroups].sort(),
      [],
      "FIXTURES.md が GROUPS に無い群を宣言している。表かランナーのどちらかが古い",
    );
  });

  it("skip されるフィクスチャは宣言と完全一致する（増えても減っても落ちる）", async () => {
    const fromDoc = declared.filter((r) => r.deferred).map((r) => r.path);
    assert.deepEqual([...fromDoc].sort(), [...DEFERRED].sort(), "FIXTURES.md の表と食い違う");

    const fromModules: string[] = [];
    for (const row of declared) {
      const fixture = (await import(`./${row.path}`)) as unknown as Fixture;
      if (typeof fixture.deferred === "string" && fixture.deferred.length > 0) {
        fromModules.push(row.path);
      }
    }
    assert.deepEqual(
      [...fromModules].sort(),
      [...DEFERRED].sort(),
      "モジュールの export と食い違う。表だけ直して中身を直していない可能性",
    );
  });

  it(`expectedViolations を持つフィクスチャが ${MAX_FIXTURES_WITH_EXPECTED_VIOLATIONS} 本を超えない`, async () => {
    const using: string[] = [];
    for (const row of declared) {
      const fixture = (await import(`./${row.path}`)) as unknown as Fixture;
      if ((fixture.expectedViolations ?? []).length > 0) using.push(row.path);
    }
    assert.ok(
      using.length <= MAX_FIXTURES_WITH_EXPECTED_VIOLATIONS,
      `expectedViolations is used by ${using.length} fixtures (${using.join(", ")}), ` +
        `but the cap is ${MAX_FIXTURES_WITH_EXPECTED_VIOLATIONS}. This mechanism lets an ` +
        "invariant stay broken and still report green; a second use must be reviewed by the " +
        "owner before the cap is raised.",
    );
  });
});

// ----------------------------------------------------------------------------
// 実行
// ----------------------------------------------------------------------------

for (const group of GROUPS) {
  const inGroup = declared.filter((r) => r.group === group);

  describe(`fixtures: ${group}/`, () => {
    for (const row of inGroup) {
      const load = async (): Promise<Fixture> =>
        (await import(`./${row.path}`)) as unknown as Fixture;

      it(`#${row.scenario} ${row.path}`, async (t) => {
        const fixture = await load();

        // 表の不変条件とフィクスチャの宣言が食い違ったら、片方が古い
        assert.deepEqual(
          [...fixture.assertions].sort(),
          [...row.assertions].sort(),
          `assertions disagree with FIXTURES.md for ${row.path}`,
        );

        if (row.deferred) {
          assert.ok(
            typeof fixture.deferred === "string" && fixture.deferred.length > 0,
            `${row.path} is deferred in FIXTURES.md but exports no reason`,
          );
          t.skip(fixture.deferred);
          return;
        }
        assert.equal(
          fixture.deferred,
          undefined,
          `${row.path} is v0.1 in FIXTURES.md but exports a deferred reason`,
        );

        const ctx = createFixtureContext();
        try {
          await fixture.setup(ctx);
          await fixture.execute(ctx);

          const report = await checkInvariants({
            reader: ctx.reader,
            // 実物の BlobStore を渡す。渡さないと HASH_MATCHES_BLOB は
            // not_checked のままで、宣言しないフィクスチャでは静かに素通りする
            blobs: ctx.blobs,
            // 同じ理由で凍結ベクタも常に渡す。CANONICAL_KEY_STABILITY は
            // フィクスチャの状態に依存しないので、宣言制にする理由が無い
            configHashVectors: ctx.configHashVectors,
            ...(ctx.replay === undefined ? {} : { replay: ctx.replay }),
            ...(ctx.knownSourceIds === undefined ? {} : { knownSourceIds: ctx.knownSourceIds }),
          });

          // **渡し忘れは静かに起きる。** HASH_MATCHES_BLOB を宣言している
          // フィクスチャが1本も無い間、blobs を渡さなくても not_checked に
          // なるだけで誰も落ちません。走査の生存をここで直接確かめます
          assert.notEqual(
            report.results.find((r) => r.name === "HASH_MATCHES_BLOB")?.status,
            "not_checked",
            "HASH_MATCHES_BLOB が検査されていない。checkInvariants に blobs を渡し忘れている",
          );
          assert.notEqual(
            report.results.find((r) => r.name === "CANONICAL_KEY_STABILITY")?.status,
            "not_checked",
            "CANONICAL_KEY_STABILITY が検査されていない。configHashVectors を渡し忘れている",
          );

          // 宣言した不変条件が not_checked なら、ここで落ちる
          assertInvariants(report, fixture.assertions, fixture.expectedViolations);
          assertExpectedViolationsOccurred(report, fixture, row.path);
        } finally {
          ctx.close();
        }
      });
    }
  });
}
