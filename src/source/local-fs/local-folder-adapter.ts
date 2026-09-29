/**
 * ローカルフォルダの SourceAdapter。STEP 3。v0.1 唯一の接続元です。
 *
 * 契約は `src/domain/types.ts` の `SourceAdapter`（`descriptor` / `enumerate` /
 * `fetch` / 任意の `fetchAcl`）。**`fetchAcl` は実装しません**
 * （KNOWN_LIMITATIONS 5節。フィクスチャ #29 が deferred なのはこれが理由）。
 *
 * ## 黙って飛ばさない
 *
 * 走査から落ちたものは、それだけで「無くなった」に近づきます。安全弁は
 * 「見えた件数」と「前回見た件数」の比しか見ないので、**列挙が静かに減ると
 * 弁は減った側を正常として通します。** だから飛ばしたものも `enumerate` が
 * 流します。**別口のコールバックではありません。** 別口だと、報告先が
 * `SourceAdapter` の型に現れないので渡し忘れても型検査を通りますし、
 * 同期のコールバックには `recordUnlistableSubtree` の失敗を返す先がありません。
 *
 * **1件の失敗で残り全件を落としません。** 列挙中に `lstat` が失敗する
 * （`readdir` が名前を返した後にファイルが消える）ことは正常に起こります。
 * 以前はそこで生の例外が出て走査全体が止まり、無関係な兄弟も未到達の部分木も
 * まとめて失われていました（レビュー F-1、実測）。いまは報告して次へ進みます。
 *
 * ## 列挙は再帰しません
 *
 * `yield*` で降りると段数分の同期スタックが積まれ、深い階層で
 * `RangeError: Maximum call stack size exceeded` になります（実測: 2000段で発生。
 * Windows は `\\?\` 経由で 12000 段作れる）。しかもその経路では各段の
 * `opendir` ハンドルが閉じません。明示スタックで降ります。
 *
 * ## root の外に出る経路を、どこで塞ぐか
 *
 * 2026-09-07 の敵対レビュー（`docs/attacks/2026-09-07-step3-local-fs.md`）と
 * その後のコードレビューで実測された経路に対応します。
 *
 *   - junction / reparse point … `lstat().isSymbolicLink()` が true になるので
 *     列挙では弾けます。**しかし `fetch` は別の話です。** 列挙の後に親を
 *     差し替えられる形（S-1）に加えて、**root 内を指すリンクの下を
 *     `fetch` が普通に読めていました**（F-3、実測）。`realpath` の結果を
 *     素直に使うと、解決後の実体は決してリンクではないためです
 *   - hardlink … symlink の印を持ちません（実測: `f=true, l=false, nlink=2`）。
 *     判別できるのは `nlink > 1` だけなので、それで弾きます。**root 内で
 *     完結した hardlink も巻き添えで落ちます**（KNOWN_LIMITATIONS 15節）
 *   - 鍵の別名 … `A.TXT` / `./a.txt` / `sub//b.txt` / 末尾 `/` が
 *     すべて通っていました（F-5、実測）。列挙が出さない形の鍵を
 *     受け取らないよう、**正準形を要求します**
 *
 * ## 読み取りは必ず EOF まで
 *
 * 列挙時サイズで打ち切ると、追記中のファイルの先頭だけが正本になります。
 * **しかも読み取りバイト数が申告サイズと一致するので `size_mismatch` が
 * 鳴りません**（S-6 は #7 の再発）。`createReadStream` に `end` を渡しません。
 */

import { open, opendir, lstat, realpath } from "node:fs/promises";
import { join, relative, sep, isAbsolute } from "node:path";
import { Readable } from "node:stream";

import { asEpochMs } from "../../domain/clock.ts";
import { InvalidArgumentError } from "../../domain/errors.ts";
import type {
  EnumeratedItem,
  SourceAdapter,
  SourceDescriptor,
} from "../../domain/types.ts";

export interface LocalFolderOptions {
  /** 走査の根。絶対パスを渡すこと */
  readonly root: string;
  readonly descriptor: SourceDescriptor;
}

/** Node が名前を UTF-8 に写せなかった印。この名前では open もできない */
const REPLACEMENT_CHARACTER = "\uFFFD";

/**
 * **どのプラットフォームでも**鍵に載せられない文字。
 *
 * バックスラッシュ … `normalizeStableKey` が posix ポリシー下でこれを `/` に
 *   畳みます。POSIX で合法な `a\b.txt` が、ディレクトリ `a` の中の `b.txt` と
 *   **同じ documentId に潰れます**（S-11）。取り込めない方を選びます
 * NUL … パスに入れられません（Node 自身が拒みます）
 */
const NEVER_IN_KEY = new RegExp("[" + String.fromCharCode(0, 92, 92) + "]");

/**
 * **このパス実装で構造的な意味を持つ**文字。
 *
 * `:` は Windows では代替データストリームとドライブ相対パスの入口です（S-4）。
 * **POSIX ではただの文字**で、`log_2024-01-01T12:00:00.txt` のような
 * ISO-8601 入りの命名はありふれています。制御文字も同じです。
 *
 * ここを一律に落とすと、**汎用の取り込みとして正当なファイルが恒久に
 * 取り込めなくなります。** 落とす理由はファイルシステムの能力ではなく
 * パスとしての意味なので、見るべきはパス実装の方です。
 */
const STRUCTURAL_ON_WINDOWS = new RegExp("[" + String.fromCharCode(1) + "-" + String.fromCharCode(31) + ":]");

/**
 * このプロセスのパス実装が Windows 構文か。
 *
 * `process.platform` ではなく**パーサそのもの**を見ます。
 * `fs-scenario.ts` が「推測しない」と言っているのは chmod や大小区別のような
 * 環境ごとに変わる能力の話で、パス構文はパーサが答えを持っています。
 *
 * **置き場所に probe ファイルを書いて測ることはできません。**
 * `SourceAdapter` は読むだけの契約です（KNOWN_LIMITATIONS 6節）。
 */
const WINDOWS_PATHS = sep === String.fromCharCode(92);

/** DF-6: 拡張子やUnicode正規化では対象を広げない。呼出側で通常ファイルに限定する。 */
export function isOfficeTemporaryName(name: string): boolean { return name.startsWith("~$"); }

/**
 * 名前を鍵として運べるか。運べないなら理由を返す。
 *
 * **純関数として切り出しています。** これらの文字を含む名前は NTFS では
 * 作れないので、実ファイルシステム経由では検査できません（変異検査で実測:
 * 列挙側の検査を外しても Windows のテストは全部緑でした）。
 *
 * @param windowsPaths パスが Windows 構文か。既定は実行中のパス実装。
 *        **引数にしているのは、片方のプラットフォームからもう片方の判定を
 *        検査できるようにするためです。**
 */
export function nameRejection(
  name: string,
  windowsPaths: boolean = WINDOWS_PATHS,
): "replacement_character" | "separator_or_nul" | "reserved_character" | null {
  if (name.includes(REPLACEMENT_CHARACTER)) return "replacement_character";
  if (NEVER_IN_KEY.test(name)) return "separator_or_nul";
  if (windowsPaths && STRUCTURAL_ON_WINDOWS.test(name)) return "reserved_character";
  return null;
}

/**
 * `lstat` が失敗したとき、どちらとして報告するか。
 *
 * **弁を閉じるかどうかがここで決まります。** ディレクトリなら配下に何件
 * あったか分からないので `unlistable_subtree`（弁を閉じる）、
 * ファイルなら `vanished_during_scan`（閉じない）です。
 *
 * **種別が取れない環境では閉じる側に倒します。** 「1件消えただけ」と
 * 読み違えると、見えなかった部分木が黙って tombstone になります。
 * この枝は実ファイルシステム経由では作れない（Dirent は Windows でも
 * Linux でも種別を返す）ので、純関数として直接押さえます。
 */
export function skipKindForLstatFailure(
  direntKind: string,
): "unlistable_subtree" | "vanished_during_scan" {
  return direntKind === "directory" || direntKind === "unknown"
    ? "unlistable_subtree"
    : "vanished_during_scan";
}

/**
 * `stat` の生値から、列挙が返す時刻と指紋を組む。
 *
 * **切り捨てです。四捨五入ではありません。**生の `mtimeMs` は小数で
 * （実測 …971.4138）、Node の `utimes` は ms 精度なので、四捨五入すると
 * `cp -p` の後に値が変わり得ます。すると #18 の衝突検出（完全一致）が
 * 原理的に発火しなくなります（S-15）。
 *
 * **切り出してあるのは、この区別を実 FS 抜きで固定するためです。**
 * 実 FS で確かめるには小数部が 0.5 以上の mtime を引く必要があり、
 * Windows の時計は約 15.6ms 刻みなので、引けるかどうかが運になります
 * （実測: 約20回に2回落ちる試験になっていました）。
 */
export function fingerprintOf(
  mtimeMs: number,
  sizeBytes: number,
): { readonly modifiedAt: number; readonly quickFingerprint: string } {
  const modifiedAt = Math.trunc(mtimeMs);
  return { modifiedAt, quickFingerprint: `${String(modifiedAt)}:${String(sizeBytes)}` };
}

/** errno を取り出す。`catch {}` を書かないために、失敗の種類を見る */
function errnoOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** `lstat` の結果を1語で言う。報告に何を書くかを1箇所に閉じる */
function classify(stats: {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
  isFile(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
  isCharacterDevice(): boolean;
  isBlockDevice(): boolean;
}): string {
  // symlink を先に見る。junction も reparse point もここに入る（実測）
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  if (stats.isFIFO()) return "fifo";
  if (stats.isSocket()) return "socket";
  if (stats.isCharacterDevice()) return "character_device";
  if (stats.isBlockDevice()) return "block_device";
  return "unknown";
}

export class LocalFolderSourceAdapter implements SourceAdapter {
  readonly descriptor: SourceDescriptor;
  readonly #root: string;

  constructor(options: LocalFolderOptions) {
    this.#root = options.root;
    this.descriptor = options.descriptor;
  }

  /**
   * root 配下の通常ファイルを列挙する。
   *
   * `opendir` で流します。`readdir` は配列を返すので、数百万件の平坦な
   * ディレクトリで全件がメモリに載ります（AGENTS.md 6節）。
   *
   * 明示スタックで降ります。再帰だと深い階層でスタックが尽き、
   * その経路では各段のハンドルも閉じません。
   *
   * **走査順は契約に入っていません。** スタックを LIFO から FIFO に変えても
   * 検査は全部緑のままです（変異検査で実測）。順に依存する検査を書くと、
   * ファイルシステムごとの `readdir` 順の違いで壊れます。
   */
  async *enumerate(): AsyncIterable<EnumeratedItem> {
    const pending: string[] = [""];

    while (pending.length > 0) {
      const relativeKey = pending.pop() as string;
      const directory = relativeKey === "" ? this.#root : join(this.#root, relativeKey);

      let handle;
      try {
        handle = await opendir(directory);
      } catch (error) {
        // 一覧できなかった。**この下に何件あったかは分からない。**
        // 黙って飛ばすと、閾値以下の欠損として正当に tombstone になる
        yield {
          kind: "unlistable_subtree",
          subtreeKey: relativeKey === "" ? "." : relativeKey,
          errorKind: errnoOf(error) ?? "unknown",
        };
        continue;
      }

      for await (const entry of handle) {
        const key = relativeKey === "" ? entry.name : `${relativeKey}/${entry.name}`;

        // 名前を鍵として運べない。U+FFFD はそもそも open できず（実測）、
        // `:` や `\` は POSIX では合法だが出しても `fetch` が受け取れない（F-4）
        const rejection = nameRejection(entry.name);
        if (rejection !== null) {
          yield { kind: "unusable_name", stableKey: key, reason: rejection };
          continue;
        }

        // Dirent の種別ではなく lstat で見ます。Dirent が UNKNOWN を返す
        // ファイルシステムがあり、そこだけ分類が変わると穴になります。
        // どのみち size / mtime / nlink が要るので、読む回数は増えません
        let stats;
        try {
          stats = await lstat(join(this.#root, key));
        } catch (error) {
          // `readdir` の後に消えた（または読めなくなった）。**走査は止めません。**
          // 止めると無関係な残り全件まで列挙されなくなります（F-1）。
          //
          // **種別は Dirent が知っています。** `lstat` が失敗しても `readdir` が
          // 返した情報は残っています。ここを見ずに一律「1件消えた」と報告すると、
          // **部分木が丸ごと消えても削除判定の弁が閉じません**（レビュー R-1、実測）。
          // 同じディレクトリが `opendir` で失敗したときは弁が閉じるので、
          // **失敗した時点が違うだけで扱いが変わっていました。**
          const errorKind = errnoOf(error) ?? "unknown";
          if (skipKindForLstatFailure(classify(entry)) === "unlistable_subtree") {
            yield { kind: "unlistable_subtree", subtreeKey: key, errorKind };
          } else {
            yield { kind: "vanished_during_scan", stableKey: key, errorKind };
          }
          continue;
        }
        const kind = classify(stats);

        if (kind === "directory") {
          pending.push(key);
          continue;
        }
        if (kind !== "file") {
          // symlink / junction / FIFO / デバイス / ソケット。
          // FIFO を open すると書き手が来るまで戻らず、走査が running のまま
          // 固まってその source 全体が塞がります（S-19）
          yield { kind: "not_a_regular_file", stableKey: key, entryKind: kind };
          continue;
        }
        // DF-5/6: 通常ファイルだけ、生の末尾名で判定する。全角名・同名フォルダは対象外。
        if (isOfficeTemporaryName(entry.name)) {
          yield { kind: "office_temporary_file", stableKey: key, sizeBytes: stats.size };
          continue;
        }
        if (stats.nlink > 1) {
          // 実体が root の外にあるかどうかは中からは分かりません。
          // root 内で完結した hardlink も巻き添えで落ちます（S-2）
          yield { kind: "hard_linked", stableKey: key, linkCount: stats.nlink };
          continue;
        }

        // 切り捨ての理由は `fingerprintOf` に書いてあります（S-15）
        const { modifiedAt, quickFingerprint } = fingerprintOf(stats.mtimeMs, stats.size);
        yield {
          kind: "entry",
          entry: {
            stableKey: key,
            sizeBytes: stats.size,
            modifiedAt: asEpochMs(modifiedAt),
            quickFingerprint,
          },
        };
      }
    }
  }

  async fetch(stableKey: string): Promise<ReadableStream<Uint8Array>> {
    const path = await this.#resolveInsideRoot(stableKey);
    const handle = await open(path, "r");
    // `end` を渡しません。列挙時サイズで打ち切ると、追記中のファイルの
    // 先頭だけが正本になり、しかも size_mismatch が鳴りません（S-6 / #7）
    return Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>;
  }

  // --------------------------------------------------------------------------
  // 内部
  // --------------------------------------------------------------------------

  /**
   * 鍵を root 配下の実パスに解決する。**ここが root 境界の門です。**
   *
   * ## 正準形を要求します
   *
   * `enumerate` が出す鍵は「root 相対・posix 区切り・空でない成分だけ」です。
   * 以前は `./a.txt` も `sub//b.txt` も `a.txt/` も通っていました（F-5、実測）。
   * **出していない形を受け取らない**ようにします。
   *
   * ## 途中にリンクがあれば拒みます
   *
   * `realpath` の結果を素直に使うと、解決後の実体は決してリンクではないので、
   * `classify` の symlink 分岐に届きません。root 内を指す junction の下が
   * そのまま読めていました（F-3、実測）。**解決前後が一致することを
   * 要求すれば、経路のどこにリンクがあっても落ちます。**
   *
   * ## 大文字小文字も同じ検査で落ちます
   *
   * **一度これを「塞げない」と書きましたが、誤りでした。**
   * `node:fs/promises` の `realpath`（このファイルが使う非同期版）は
   * 名前の大小を実体に正規化します（実測: `A.TXT` を渡すと `a.txt` が返る）。
   * 正規化しないのは `node:fs` の同期版 `realpathSync` の方で、
   * **コードが呼んでいないものを測って「実測」と書いていました。**
   *
   * したがって `A.TXT` も `SUB/b.txt` も、上の一致検査で落ちます。
   * 8.3 短縮名も同じ理由で落ちます（`realpath` が長い名前へ展開するため）。
   * **ただし理由は「リンク」ではありません。** 区別できるように、
   * 大小だけが違う場合は別の文言で返します。
   */
  async #resolveInsideRoot(stableKey: string): Promise<string> {
    if (stableKey === "") {
      throw new InvalidArgumentError("stableKey must not be empty");
    }
    // **判定は列挙側と同じ関数です。** 別々に書くと、片方だけが緩んで
    // 「列挙が出した鍵を fetch が拒む」自己矛盾が戻ります（F-4）。
    // 区切りの `/` は鍵の構造なので、判定に掛ける前に外します
    const rejection = nameRejection(stableKey.split("/").join(""));
    if (rejection !== null) {
      throw new InvalidArgumentError(
        `stableKey carries a character that cannot appear in a key (${rejection}): ` +
          `${JSON.stringify(stableKey)}`,
      );
    }
    // **この枝は現在到達不能です**（変異検査で実測: 外しても全テストが緑）。
    // 絶対パスはこの後の成分検査に必ず引っかかります（先頭の `/` が空成分に、
    // Windows のドライブ文字は `:` が上の判定に）。
    // 残しているのは、この後の検査が緩んだときに境界を保つためです
    if (isAbsolute(stableKey)) {
      throw new InvalidArgumentError(
        `stableKey must be relative to the source root, got ${JSON.stringify(stableKey)}`,
      );
    }
    // 正準形。空成分（`//` と先頭・末尾の `/`）も `.` も `..` も、
    // `enumerate` は出しません
    const segments = stableKey.split("/");
    if (segments.some((s) => s === "" || s === "." || s === "..")) {
      throw new InvalidArgumentError(
        `stableKey must have no empty, "." or ".." segments, got ${JSON.stringify(stableKey)}`,
      );
    }

    // 列挙の後に親を junction へ差し替えられていても、ここで解決し直せば
    // root の外を指していることが分かります（S-1）。**窓は残ります** —
    // この検査と open の間に差し替えられたら見えません
    const realRoot = await realpath(this.#root);
    const naive = join(realRoot, stableKey);
    const target = await realpath(naive);

    // 解決前後が食い違う。理由は「経路上のリンク」か「大小・短縮名が実体と違う」
    // のどちらかです。**どちらも列挙が出さない鍵**なので拒みますが、
    // 文言は分けます。リンクでないものを「リンク」と報告すると調査が迷います
    if (target !== naive) {
      throw new InvalidArgumentError(
        target.toLowerCase() === naive.toLowerCase()
          ? `stableKey does not match the on-disk name (case or short name): ` +
              `${JSON.stringify(stableKey)}`
          : `stableKey resolves through a link: ${JSON.stringify(stableKey)}`,
      );
    }
    // **この枝も現在到達不能です**（同上）。`..` 成分が拒まれ、かつ
    // `target === naive` を要求する以上、`naive` は字面上 root の下にしかならず、
    // 解決後もそこから動きません。**それでも残します。** これは
    // 「root の外を読まない」という主張そのものの文であって、
    // 手前の検査がどう変わっても成り立っていなければならないものです
    const inside = relative(realRoot, target);
    if (inside === "" || inside.startsWith(`..${sep}`) || inside === ".." || isAbsolute(inside)) {
      throw new InvalidArgumentError(
        `stableKey resolves outside the source root: ${JSON.stringify(stableKey)}`,
      );
    }

    const stats = await lstat(target);
    const kind = classify(stats);
    if (kind !== "file") {
      throw new InvalidArgumentError(
        `stableKey does not name a regular file (${kind}): ${JSON.stringify(stableKey)}`,
      );
    }
    if (stats.nlink > 1) {
      throw new InvalidArgumentError(
        `stableKey names a hard-linked file (nlink=${String(stats.nlink)}): ` +
          `${JSON.stringify(stableKey)}`,
      );
    }
    return target;
  }
}
