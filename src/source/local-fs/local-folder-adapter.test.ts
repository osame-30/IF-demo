/**
 * `LocalFolderSourceAdapter` の検査。
 *
 * ここで守っているのは、2026-09-07 の敵対レビュー
 * （`docs/attacks/2026-09-07-step3-local-fs.md`）で実測された経路です。
 * **「symlink を辿らない」だけでは足りない**ことが、そのまま検査の形になっています。
 *
 * 実ファイルシステムを使います。junction も hardlink も、置き換えたら
 * 確かめたいことが確かめられなくなるためです。
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  stat,
  writeFile,
  appendFile,
  symlink,
  link,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import {
  LocalFolderSourceAdapter,
  fingerprintOf,
  nameRejection,
  skipKindForLstatFailure,
} from "./local-folder-adapter.ts";
import { isStoreError } from "../../domain/errors.ts";
import type {
  EnumeratedItem,
  SkippedEntry,
  SourceAdapter,
  SourceDescriptor,
  SourceEntry,
  SourceId,
} from "../../domain/types.ts";

const DESCRIPTOR: SourceDescriptor = {
  sourceId: "local-1" as SourceId,
  kind: "local-fs",
  configHash: "cfg",
  displayName: "local folder",
  keyNormalization: {
    unicodeForm: "NFC",
    caseFold: false,
    pathSeparator: "posix",
    trimSlashes: true,
  },
};

let root: string;
/** root の外。ここへ出られたら負け */
let outside: string;
let skipped: SkippedEntry[];

function adapterAt(at: string = root): LocalFolderSourceAdapter {
  return new LocalFolderSourceAdapter({ root: at, descriptor: DESCRIPTOR });
}

/**
 * 見えた1件だけを返し、落とした1件は `skipped` に振り分ける。
 *
 * **振り分けは検査ではありません。** 以前は落とした側がコールバックで
 * 別口に出ていたので、ここは1本の流れを受けるだけでした。いまは同じ流れに
 * 載っているので、ここで分けます。分け方を間違えると全検査が落ちます。
 */
async function collect(adapter: LocalFolderSourceAdapter): Promise<SourceEntry[]> {
  const out: SourceEntry[] = [];
  for await (const item of adapter.enumerate()) {
    if (item.kind === "entry") out.push(item.entry);
    else skipped.push(item);
  }
  return out.sort((a, b) => (a.stableKey < b.stableKey ? -1 : 1));
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    parts.push(chunk.value);
  }
  return Buffer.concat(parts).toString("utf8");
}

beforeEach(async () => {
  const base = await mkdtemp(join(tmpdir(), "local-fs-"));
  root = join(base, "root");
  outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "secret.txt"), "OUTSIDE-BYTES");
  skipped = [];
});

afterEach(async () => {
  // junction を先に外す。中身ごと消すと root 外の実体まで消える
  await rm(join(root, "j"), { recursive: false, force: true }).catch(() => undefined);
  await rm(join(root, ".."), { recursive: true, force: true }).catch(() => undefined);
});

describe("LocalFolderSourceAdapter.enumerate: 鍵は root 相対の posix パス", () => {
  it("入れ子でも区切りは / になる", async () => {
    await mkdir(join(root, "sub", "deep"), { recursive: true });
    await writeFile(join(root, "top.txt"), "a");
    await writeFile(join(root, "sub", "mid.txt"), "bb");
    await writeFile(join(root, "sub", "deep", "leaf.txt"), "ccc");

    const keys = (await collect(adapterAt())).map((e) => e.stableKey);
    assert.deepEqual(keys, ["sub/deep/leaf.txt", "sub/mid.txt", "top.txt"]);
    // 先頭に / を付けない。付けると normalizeStableKey の trimSlashes が
    // 落とすので同じ鍵になるが、保存される生値が環境ごとに変わる
    assert.ok(keys.every((k) => !k.startsWith("/")));
  });

  it("サイズと更新時刻を報告する", async () => {
    await writeFile(join(root, "a.txt"), "hello");
    await utimes(join(root, "a.txt"), new Date(1_700_000_000_000), new Date(1_700_000_000_000));

    const [entry] = await collect(adapterAt());
    assert.equal(entry!.sizeBytes, 5);
    assert.equal(entry!.modifiedAt, 1_700_000_000_000);
  });

  it("quickFingerprint は切り捨てた ms で組む（#18 の検出が死なないように）", async () => {
    // 生の mtimeMs は小数（実測 …971.4138）。そのまま使うと cp -p の後に
    // 必ず値が変わり、完全一致で見ている衝突検出が原理的に発火しなくなる
    await writeFile(join(root, "a.txt"), "hello");
    const [entry] = await collect(adapterAt());
    assert.match(entry!.quickFingerprint!, /^[0-9]+:5$/);
    assert.ok(!entry!.quickFingerprint!.includes("."), "小数が混ざっている");
  });
});

describe("LocalFolderSourceAdapter.enumerate: 通常ファイル以外は黙って飛ばさない", () => {
  it("symlink / junction は列挙しない。報告に残る", async () => {
    await writeFile(join(root, "real.txt"), "kept");
    // Windows では junction が管理者権限なしで張れる（実測）。
    // POSIX ではこの指定は無視され、通常の symlink になる
    await symlink(outside, join(root, "j"), "junction");

    const keys = (await collect(adapterAt())).map((e) => e.stableKey);
    assert.deepEqual(keys, ["real.txt"], "junction の先が列挙に混ざっている");
    assert.deepEqual(skipped, [
      { kind: "not_a_regular_file", stableKey: "j", entryKind: "symlink" },
    ]);
  });

  it("hardlink は列挙しない。実体が root の外かは中から分からない", async () => {
    await writeFile(join(root, "real.txt"), "kept");
    await link(join(outside, "secret.txt"), join(root, "hard.txt"));

    const keys = (await collect(adapterAt())).map((e) => e.stableKey);
    assert.deepEqual(keys, ["real.txt"]);
    assert.deepEqual(skipped, [{ kind: "hard_linked", stableKey: "hard.txt", linkCount: 2 }]);
  });

  it("名前を UTF-8 に写せないものは取り込まない（KNOWN_LIMITATIONS 14節）", async () => {
    // 本物の孤立サロゲート名は Node からは作れません（作れたら U+FFFD に
    // 潰れる問題自体が起きない）。ここでは同じ枝を、正規の U+FFFD を含む
    // 名前で通します。**過剰拒否になる形をそのまま固定します**
    await writeFile(join(root, "ok.txt"), "kept");
    await writeFile(join(root, "bad�name.txt"), "x");

    const keys = (await collect(adapterAt())).map((e) => e.stableKey);
    assert.deepEqual(keys, ["ok.txt"]);
    assert.deepEqual(skipped, [
      {
        kind: "unusable_name",
        stableKey: "bad�name.txt",
        reason: "replacement_character",
      },
    ]);
  });

  it("一覧できないディレクトリは報告して降りない", async () => {
    // 黙って飛ばすと、この下の文書が閾値以下の欠損として tombstone になる
    const missing = join(root, "gone");
    const entries = await collect(adapterAt(missing));
    assert.deepEqual(entries, []);
    assert.deepEqual(skipped, [
      { kind: "unlistable_subtree", subtreeKey: ".", errorKind: "ENOENT" },
    ]);
  });

  it("報告が空振りしていない（何も飛ばさなければ空のまま）", async () => {
    // 上の4件は「onSkipped を常に呼ぶ」でも緑になります
    await writeFile(join(root, "a.txt"), "x");
    assert.equal((await collect(adapterAt())).length, 1);
    assert.deepEqual(skipped, []);
  });
});

/**
 * 変異検査で生き残った枝を埋めるための検査です。
 *
 * 実装を直したのに、**直したことを固定する検査を書いていませんでした。**
 * 掃き出し（19件）で lstat 失敗の継続・リンク検出・予約文字の列挙側検査の
 * 3つが生き残り、どれも「戻しても全部緑」でした。
 */
describe("LocalFolderSourceAdapter: 直した挙動を固定する", () => {
  it("SourceAdapter として受け取っても、落としたものが見える", async () => {
    // **これが型を移した理由です。** 以前の報告先は構築時のコールバックで、
    // `SourceAdapter` の型には現れませんでした。駆動部はこの型で受けるので、
    // 落としたものに触れる手段がなく、`recordUnlistableSubtree` を呼べません。
    // 呼ばなければ安全弁は閉じず、見えなかった部分木がそのまま
    // 欠損として tombstone になります。
    //
    // 具体型ではなく `SourceAdapter` に代入してから回します。
    await writeFile(join(root, "a.txt"), "x");

    const seen: SourceAdapter = adapterAt();
    const items: EnumeratedItem[] = [];
    for await (const item of seen.enumerate()) items.push(item);
    assert.equal(items.length, 1);
    const only = items[0]!;
    assert.equal(only.kind, "entry", "見えた1件が entry の枝で流れていない");
    assert.equal(only.kind === "entry" ? only.entry.stableKey : null, "a.txt");

    // 落とした側も同じ口から出る。root ごと無い場合が弁を閉じる本命
    const blind: SourceAdapter = adapterAt(join(root, "does-not-exist"));
    const fromBlind: EnumeratedItem[] = [];
    for await (const item of blind.enumerate()) fromBlind.push(item);
    assert.deepEqual(fromBlind, [
      { kind: "unlistable_subtree", subtreeKey: ".", errorKind: "ENOENT" },
    ]);
  });

  it("列挙中に1件消えても、残り全件は列挙される（F-1）", async () => {
    // 以前は生の ENOENT が出て走査全体が止まり、無関係な兄弟まで失われた
    await mkdir(join(root, "sub"), { recursive: true });
    for (const n of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(root, "sub", n), "x");
    await writeFile(join(root, "z.txt"), "Z");

    const adapter = adapterAt();
    const got: string[] = [];
    let removed = false;
    for await (const item of adapter.enumerate()) {
      if (item.kind !== "entry") {
        skipped.push(item);
        continue;
      }
      const entry = item.entry;
      got.push(entry.stableKey);
      // **sub の中の1件を受け取った時点で**、まだ lstat していない兄弟を消す。
      // sub を開く前に消すと readdir に載らないので、この枝に入らない。
      //
      // **消す相手は「まだ受け取っていない方」を実行時に選びます。**
      // 特定の名前を決め打ちすると、その名前が最初に読まれる環境で
      // 「消す前に yield 済み」になり、検査が別のことを見ます（同じファイルが
      // 「走査順は契約に入っていない」と書いているので、順に依存させない）
      if (!removed) {
        const victim = ["a.txt", "b.txt", "c.txt"].find(
          (n) => !got.includes(`sub/${n}`) && entry.stableKey.startsWith("sub/"),
        );
        if (victim !== undefined) {
          removed = true;
          await rm(join(root, "sub", victim), { force: true });
        }
      }
    }

    assert.ok(got.includes("z.txt"), `無関係な兄弟まで失われている: ${JSON.stringify(got)}`);
    assert.equal(got.length, 3, `列挙: ${JSON.stringify(got.sort())}`);
    assert.deepEqual(
      skipped.map((s) => s.kind),
      ["vanished_during_scan"],
      "消えた1件が報告されていない",
    );
  });

  it("部分木が lstat の前に消えたら unlistable_subtree（弁を閉じる側）（R-1）", async () => {
    // 同じディレクトリが opendir で失敗すれば弁は閉じるのに、lstat の前に
    // 消えると「1件消えた」に丸められて閉じなかった。**失敗した時点が
    // 違うだけで扱いが変わっていた。** 種別は Dirent が知っている
    await writeFile(join(root, "aaa.txt"), "x");
    await mkdir(join(root, "zzz_dir"), { recursive: true });
    for (const n of ["c1.txt", "c2.txt"]) await writeFile(join(root, "zzz_dir", n), "x");

    const adapter = adapterAt();
    let removed = false;
    for await (const item of adapter.enumerate()) {
      if (item.kind !== "entry") {
        skipped.push(item);
        continue;
      }
      const entry = item.entry;
      if (!removed && entry.stableKey === "aaa.txt") {
        removed = true;
        await rm(join(root, "zzz_dir"), { recursive: true, force: true });
      }
    }
    assert.ok(removed, "前提: aaa.txt を先に受け取れていない");
    assert.deepEqual(skipped, [
      { kind: "unlistable_subtree", subtreeKey: "zzz_dir", errorKind: "ENOENT" },
    ]);
  });

  it("入れ子のディレクトリが開けないと subtreeKey にその鍵が入る（R-4）", async () => {
    // 以前は root 自体が無い場合（subtreeKey === "."）しか検査しておらず、
    // 三項式を "." に固定する変異が生き残っていた
    await mkdir(join(root, "outer", "inner"), { recursive: true });
    await writeFile(join(root, "outer", "keep.txt"), "x");

    const adapter = adapterAt();
    const got: string[] = [];
    let removed = false;
    for await (const item of adapter.enumerate()) {
      if (item.kind !== "entry") {
        skipped.push(item);
        continue;
      }
      const entry = item.entry;
      got.push(entry.stableKey);
      // inner は既に lstat 済みで pending に積まれている。opendir の前に消す
      if (!removed && entry.stableKey === "outer/keep.txt") {
        removed = true;
        await rm(join(root, "outer", "inner"), { recursive: true, force: true });
      }
    }
    assert.deepEqual(got, ["outer/keep.txt"]);
    assert.deepEqual(skipped, [
      { kind: "unlistable_subtree", subtreeKey: "outer/inner", errorKind: "ENOENT" },
    ]);
  });

  it("大小や短縮名の違いは、リンクとは別の文言で拒む（R-3）", async () => {
    // node:fs/promises の realpath は大小を実体に正規化する（実測）ので、
    // A.TXT は一致検査で落ちる。**落ちること自体は正しいが、
    // 「リンク経由」と報告するのは嘘**
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "b.txt"), "B-BYTES");
    const adapter = adapterAt();
    assert.equal(await drain(await adapter.fetch("sub/b.txt")), "B-BYTES");

    // **大小を区別する FS（Linux の ext4 など）では、これらの鍵は実体に届きません。**
    // そのとき正しい答えは「名前が食い違う」ではなく「無い」です。
    // どちらの FS かは推測せず、**この root で測ります**（`fs-scenario.ts` と同じ規約）。
    const caseInsensitive = await stat(join(root, "SUB", "b.txt")).then(
      () => true,
      () => false,
    );

    for (const key of ["SUB/b.txt", "sub/B.TXT", "SUB/B.TXT"]) {
      await assert.rejects(
        () => adapter.fetch(key),
        (error: unknown) => {
          // **リンクと報告しないことは、どちらの FS でも成り立ちます。**
          // R-3 の主張そのものなので、分岐の外に置きます
          assert.doesNotMatch((error as Error).message, /through a link/, "リンクと報告している");
          // 一致検査に届くのは、実体に辿り着けた場合だけです
          if (caseInsensitive) {
            assert.ok(isStoreError(error, "invalid_argument"), `想定外: ${String(error)}`);
            assert.match((error as Error).message, /does not match the on-disk name/);
          }
          return true;
        },
        `通ってしまった: ${key}`,
      );
    }
  });

  it("root 内を指すリンクの下を fetch が読まない（F-3）", async () => {
    // realpath の結果を素直に使うと、解決後の実体は決してリンクにならないので、
    // classify の symlink 分岐には届かない。解決前後の一致で見る
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "b.txt"), "B-BYTES");
    await symlink(join(root, "sub"), join(root, "j2"), "junction");

    const adapter = adapterAt();
    // 列挙は j2 を落とす。落としたのに fetch が読めるのが以前の穴だった
    assert.deepEqual((await collect(adapter)).map((e) => e.stableKey), ["sub/b.txt"]);
    await assert.rejects(
      () => adapter.fetch("j2/b.txt"),
      (error: unknown) => {
        assert.ok(isStoreError(error, "invalid_argument"), `想定外: ${String(error)}`);
        return true;
      },
      "root 内のリンク越しに読めている",
    );
    // 同じ実体を正規の鍵で読むのは通る。門が広すぎないことの確認
    assert.equal(await drain(await adapter.fetch("sub/b.txt")), "B-BYTES");
    await rm(join(root, "j2"), { recursive: false, force: true });
  });

  it("lstat 失敗時にどちらへ倒すか（R-1）", () => {
    // 種別が取れない環境（Dirent が UNKNOWN）は実ファイルシステム経由では
    // 作れないので、判定そのものを直接押さえる。**閉じる側に倒すのが正**
    assert.equal(skipKindForLstatFailure("directory"), "unlistable_subtree");
    assert.equal(skipKindForLstatFailure("unknown"), "unlistable_subtree");
    for (const k of ["file", "symlink", "fifo", "socket", "character_device", "block_device"]) {
      assert.equal(skipKindForLstatFailure(k), "vanished_during_scan", k);
    }
  });

  it("鍵として運べない名前の判定（F-4 / R-2）", () => {
    // これらの文字を含む名前は NTFS では作れないので、実ファイルシステム
    // 経由では検査できません（変異検査で実測）。判定そのものを直接押さえます。
    // **両方のパス構文を検査します。** 片方からもう片方を見られるように
    // 引数にしてあるので、Windows から POSIX の判定も固定できます
    const bs = String.fromCharCode(92);
    const nul = String.fromCharCode(0);
    const unitSep = String.fromCharCode(31);
    const lf = String.fromCharCode(10);
    const fffd = String.fromCharCode(0xfffd);

    for (const windowsPaths of [true, false]) {
      const where = windowsPaths ? "windows" : "posix";
      // どちらでも通る
      assert.equal(nameRejection("ok.txt", windowsPaths), null, where);
      assert.equal(nameRejection("日本語 と 空白.txt", windowsPaths), null, where);
      // どちらでも落ちる
      assert.equal(nameRejection("bad" + fffd + "name.txt", windowsPaths), "replacement_character", where);
      assert.equal(nameRejection("a" + bs + "b.txt", windowsPaths), "separator_or_nul", where);
      assert.equal(nameRejection("a" + nul + "b.txt", windowsPaths), "separator_or_nul", where);
    }

    // **ここが分かれる。** Windows では : と制御文字が構造的な意味を持つが、
    // POSIX ではただの文字で、ISO-8601 入りの命名はありふれている
    for (const name of ["a:b.txt", "log_2024-01-01T12:00:00.txt", "a" + unitSep + "b.txt", "a" + lf + "b.txt"]) {
      assert.equal(nameRejection(name, true), "reserved_character", "windows: " + JSON.stringify(name));
      assert.equal(nameRejection(name, false), null, "posix: " + JSON.stringify(name));
    }
  });

  it("root 自体がリンクでも動く（root 側の realpath が要る）", async () => {
    // root を junction 経由で渡すと、realpath を取らない実装では
    // naive と target が食い違い、全件が「リンク経由」として拒まれる
    await writeFile(join(root, "a.txt"), "A-BYTES");
    const alias = join(root, "..", "root-alias");
    await symlink(root, alias, "junction");
    try {
      const viaAlias = adapterAt(alias);
      assert.deepEqual((await collect(viaAlias)).map((e) => e.stableKey), ["a.txt"]);
      assert.equal(await drain(await viaAlias.fetch("a.txt")), "A-BYTES");
    } finally {
      await rm(alias, { recursive: false, force: true });
    }
  });

  it("fingerprintOf は mtime を切り捨てる（round ではない）", () => {
    // 以前は /^[0-9]+:5$/ しか見ておらず、**round でも緑だった**（変異検査）。
    //
    // **実 FS を使いません。**この区別を実 FS で作るには小数部が 0.5 以上の
    // mtime を引く必要があり、`utimes` は ms 整数に丸めるので使えません。
    // 書き直して引き当てるしかありませんが、**Windows の時計は約 15.6ms 刻み**で、
    // 100回の書き込みは1刻みに収まります。刻みの小数部が 0.5 未満だと
    // 100回とも同じ値を引いて落ちます（実測: 約20回に2回赤くなっていました）。
    //
    // **0.5 の両側を置きます。**片側だけだと round との差が出ません
    assert.deepEqual(fingerprintOf(1_699.7, 5), { modifiedAt: 1_699, quickFingerprint: "1699:5" });
    assert.deepEqual(fingerprintOf(1_699.2, 5), { modifiedAt: 1_699, quickFingerprint: "1699:5" });
  });

  it("列挙は fingerprintOf が組んだ値を返す（経路が繋がっている）", async () => {
    // 切り捨ての主張は上の純関数で固定済みです。**ここで見るのは経路**で、
    // 実 mtime の小数部がどちらに転んでも落ちません
    await writeFile(join(root, "a.txt"), "hello");
    const mtimeMs = (await stat(join(root, "a.txt"))).mtimeMs;

    const [entry] = await collect(adapterAt());
    assert.equal(entry!.modifiedAt, Math.trunc(mtimeMs));
    assert.equal(entry!.quickFingerprint, `${String(Math.trunc(mtimeMs))}:5`);
  });

  it("quickFingerprint は mtime であって atime ではない", async () => {
    // atime と mtime を別の整数に置く。同じだとどちらを読んでも同じになる
    await writeFile(join(root, "a.txt"), "hello");
    await utimes(join(root, "a.txt"), new Date(1_600_000_000_000), new Date(1_700_000_000_000));

    const [entry] = await collect(adapterAt());
    assert.equal(entry!.quickFingerprint, "1700000000000:5");
    assert.equal(entry!.modifiedAt, 1_700_000_000_000);
  });});

/**
 * Office が編集中に作る所有者ファイル（`~$`）。2026-09-15 の実操作動画で取り込まれ、
 * 解析で「破損」と出て、閉じると削除確認が出た。判定の置き場所で壊れる形は
 * 攻撃レビュー DF-6（`docs/attacks/2026-09-15-deletion-flow-attack-opus.md`）で実測した。
 */
describe("LocalFolderSourceAdapter.enumerate: Office の一時ファイル（~$）は取り込まず報告する", () => {
  it("ファイル名が ~$ で始まる通常ファイルは、深い階層でも大文字の拡張子でも entry にしない", async () => {
    await mkdir(join(root, "sub", "深い"), { recursive: true });
    await writeFile(join(root, "~$a.docx"), Buffer.alloc(162));
    await writeFile(join(root, "sub", "深い", "~$x.DOCX"), Buffer.alloc(165));
    await writeFile(join(root, "real.docx"), "kept");

    const keys = (await collect(adapterAt())).map((e) => e.stableKey);
    assert.deepEqual(keys, ["real.docx"]);
    // 鍵（相対パス）の先頭で判定すると、サブフォルダの ~$ を取り込み続ける（DF-6 i）
    assert.deepEqual(
      [...skipped].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
      [
        { kind: "office_temporary_file", stableKey: "sub/深い/~$x.DOCX", sizeBytes: 165 },
        { kind: "office_temporary_file", stableKey: "~$a.docx", sizeBytes: 162 },
      ],
    );
  });

  it("全角の「～＄」で始まる名前と、~$ で始まるフォルダの中身は取り込む", async () => {
    // Office は全角を作らない。NFKC で比べると本物の資料を除外する（DF-6 iii）。
    // フォルダに当てると中身が黙って欠損候補になる（DF-6 iv）
    await mkdir(join(root, "~$dir"));
    await writeFile(join(root, "~$dir", "real.docx"), "in dir");
    await writeFile(join(root, "～＄メモ.docx"), "fullwidth");

    const keys = (await collect(adapterAt())).map((e) => e.stableKey);
    assert.deepEqual(keys, ["~$dir/real.docx", "～＄メモ.docx"]);
    assert.deepEqual(skipped, []);
  });
});

describe("LocalFolderSourceAdapter.fetch: root の外へ出さない", () => {
  it("列挙した鍵は読める", async () => {
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "a.txt"), "inside bytes");
    assert.equal(await drain(await adapterAt().fetch("sub/a.txt")), "inside bytes");
  });

  it("列挙の後に親を junction へ差し替えても root の外を読まない（S-1）", async () => {
    // 敵対レビューが実測した経路そのもの。列挙時点では普通のディレクトリで、
    // fetch の直前に差し替わる
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "secret.txt"), "INSIDE-BYTES");
    const adapter = adapterAt();
    assert.equal(await drain(await adapter.fetch("sub/secret.txt")), "INSIDE-BYTES");

    await rm(join(root, "sub"), { recursive: true, force: true });
    await symlink(outside, join(root, "sub"), "junction");

    await assert.rejects(
      () => adapter.fetch("sub/secret.txt"),
      (error: unknown) => {
        assert.ok(isStoreError(error, "invalid_argument"), `想定外: ${String(error)}`);
        return true;
      },
      "junction 越しに root の外を読んでいる",
    );
    await rm(join(root, "sub"), { recursive: false, force: true });
  });

  it("hardlink は fetch でも拒む（列挙で弾いた後の受け皿）", async () => {
    await link(join(outside, "secret.txt"), join(root, "hard.txt"));
    await assert.rejects(
      () => adapterAt().fetch("hard.txt"),
      (error: unknown) => isStoreError(error, "invalid_argument"),
    );
  });

  it("列挙が返さない形の鍵を拒む", async () => {
    await writeFile(join(root, "a.txt"), "x");
    const adapter = adapterAt();
    const rejected = [
      "",
      "..",
      "../outside/secret.txt",
      "sub/../../outside/secret.txt",
      "/etc/passwd",
      "a\\b.txt",
      // 制御文字。**以前ここは見た目が空白で実体が NUL でした**（od -c で確認）。
      // 空白入りの鍵を拒否しているように読めて、検査していたのは NUL だった
      "a\u0000.txt",
      // 正準形でない鍵。列挙はこれらを出さない（F-5）
      "./a.txt",
      "sub//b.txt",
      "sub/./b.txt",
      "a.txt/",
      "/a.txt",
    ];
    for (const key of rejected) {
      await assert.rejects(
        () => adapter.fetch(key),
        (error: unknown) => isStoreError(error, "invalid_argument"),
        `通ってしまった: ${JSON.stringify(key)}`,
      );
    }
    // 拒否の列挙が空振りしていないことを、通る鍵で確かめる
    assert.equal(await drain(await adapter.fetch("a.txt")), "x");
  });

  it("`:` を含む鍵は、パス構文が Windows のときだけ拒む（14節）", async () => {
    // `:` が構造を持つのは Windows だけです（代替データストリーム / ドライブ相対パス）。
    // POSIX では `log_2024-01-01T12:00:00.txt` のような命名がありふれているので、
    // 一律に落とすと**汎用の取り込みとして正当なファイルが恒久に取り込めなくなります。**
    //
    // `nameRejection` の両枝は上で固定済みですが、あれは純関数への引数です。
    // **ここは実際の `sep` が経路に効いていることを見ます。**
    // 片枝だけ書くと、その OS では緑のまま分岐を消せてしまいます。
    const keys = ["a.txt:hidden", "C:foo"];

    if (sep === String.fromCharCode(92)) {
      const adapter = adapterAt();
      for (const key of keys) {
        await assert.rejects(
          () => adapter.fetch(key),
          (error: unknown) => {
            assert.ok(isStoreError(error, "invalid_argument"), `想定外: ${String(error)}`);
            // **理由まで見ます。** `invalid_argument` だけだと、`:` の判定を
            // 外しても realpath の不一致で同じ型が飛んで緑になります（変異で実測）
            assert.match(
              (error as Error).message,
              /cannot appear in a key \(reserved_character\)/,
              `別の理由で拒まれている: ${String(error)}`,
            );
            return true;
          },
          `通ってしまった: ${JSON.stringify(key)}`,
        );
      }
      return;
    }

    // POSIX では正当な名前。**作って読めるところまで確かめます。**
    // 「拒まれない」だけだと、別の理由で失敗していても気づけません
    for (const key of keys) await writeFile(join(root, key), key);
    const adapter = adapterAt();
    for (const key of keys) {
      assert.equal(await drain(await adapter.fetch(key)), key, key);
    }
  });

  it("ディレクトリや symlink を fetch できない", async () => {
    await mkdir(join(root, "sub"), { recursive: true });
    await symlink(outside, join(root, "j"), "junction");
    const adapter = adapterAt();
    for (const key of ["sub", "j"]) {
      await assert.rejects(
        () => adapter.fetch(key),
        (error: unknown) => isStoreError(error, "invalid_argument"),
      );
    }
    await rm(join(root, "j"), { recursive: false, force: true });
  });
});

describe("LocalFolderSourceAdapter.fetch: 読み取りは EOF まで", () => {
  it("列挙時サイズで打ち切らない（S-6 は #7 の再発）", async () => {
    // 打ち切ると、追記中のファイルの先頭だけが正本になる。しかも
    // 読み取りバイト数が申告サイズと一致するので size_mismatch も鳴らない
    // **同じインスタンスで列挙してから fetch します。** 別インスタンスだと、
    // 「列挙時サイズを覚えておいて打ち切る」という実装（S-6 が言う自然な
    // 最適化）を再現できず、この検査が空振りします（変異で実測）
    await writeFile(join(root, "log.txt"), "0123456789");
    const adapter = adapterAt();
    const [entry] = await collect(adapter);
    assert.equal(entry!.sizeBytes, 10, "前提: 列挙時は 10 バイト");

    await appendFile(join(root, "log.txt"), "APPENDED");
    const read = await drain(await adapter.fetch("log.txt"));

    assert.equal(read, "0123456789APPENDED");
    assert.notEqual(read.length, entry!.sizeBytes, "申告サイズで打ち切っている");
  });
});

describe("LocalFolderSourceAdapter: 契約", () => {
  it("descriptor をそのまま返す", () => {
    assert.deepEqual(adapterAt().descriptor, DESCRIPTOR);
  });

  it("fetchAcl を実装しない（KNOWN_LIMITATIONS 5節。#29 が deferred な理由）", () => {
    // 実装したらフィクスチャ #29 の deferred 理由が偽になる。
    // 消し忘れを防ぐため、無いことを固定する
    assert.equal((adapterAt() as { fetchAcl?: unknown }).fetchAcl, undefined);
  });
});
