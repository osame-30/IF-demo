/**
 * 一時ディレクトリにファイル構成を作る。
 *
 * このヘルパーの中心は `detectFsCapabilities` です。
 * #17（chmod 000）と #23（NFD/NFC・大文字小文字）は、実行環境の
 * ファイルシステムがその操作を本当に尊重するかどうかで結果が変わります。
 *
 * `process.platform` から推測しません。実際に書いて読み返して確かめます。
 * 「root で走る CI では chmod が無効になることを見落としやすい」
 * （FIXTURES.md #17）を、見落としようのない形にするためです。
 *
 * 能力が無い環境では、フィクスチャは fs ではなく SourceAdapter を
 * ラップする経路へ切り替えます。黙って緑にしないための情報源がここです。
 */

import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, stat, utimes, chmod, rename, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, sep, posix } from "node:path";

import type { EpochMs } from "../../src/domain/types.ts";

// ----------------------------------------------------------------------------
// ファイル構成の宣言
// ----------------------------------------------------------------------------

export interface FileSpec {
  /** 空文字列は正当な内容。undefined と区別する（#20） */
  readonly content: string | Uint8Array;
  readonly mtime?: EpochMs;
  readonly mode?: number;
}

export type TreeSpec = Readonly<Record<string, string | Uint8Array | FileSpec>>;

function toSpec(value: string | Uint8Array | FileSpec): FileSpec {
  return typeof value === "string" || value instanceof Uint8Array ? { content: value } : value;
}

export interface EntryStat {
  readonly sizeBytes: number;
  readonly modifiedAt: EpochMs;
}

// ----------------------------------------------------------------------------
// 実行環境の能力
// ----------------------------------------------------------------------------

export interface FsCapabilities {
  /** 大文字小文字を区別するか。false なら #23 の大文字小文字攻撃は fs では再現できない */
  readonly caseSensitive: boolean;
  /** NFC と NFD の名前が同じファイルを指すか（macOS の既定FSで true） */
  readonly unicodeFormsCollide: boolean;
  /** 書いた正規化形のまま readdir に出るか */
  readonly preservesUnicodeForm: boolean;
  /** chmod 000 が読み取りを本当に拒むか。root や Windows では false（#17） */
  readonly enforcesPermissions: boolean;
  /** mtime を過去に戻せるか（#19） */
  readonly supportsMtimeInPast: boolean;
}

let cached: Promise<FsCapabilities> | undefined;

/** 一度だけ実測してキャッシュする。同一プロセス内で変わる値ではない */
export function detectFsCapabilities(): Promise<FsCapabilities> {
  cached ??= probe();
  return cached;
}

async function probe(): Promise<FsCapabilities> {
  const root = await mkdtemp(join(tmpdir(), "ingestion-frame-probe-"));
  try {
    // 大文字小文字
    await writeFile(join(root, "probe-case.txt"), "x");
    const caseSensitive = !(await exists(join(root, "PROBE-CASE.TXT")));

    // Unicode 正規化。café の NFD（e + U+0301）を書いて挙動を見る
    const nfd = "café.txt";
    const nfc = "café.txt";
    await writeFile(join(root, nfd), "x");
    const namesAfterNfd = await readdir(root);
    const preservesUnicodeForm = namesAfterNfd.includes(nfd);
    const unicodeFormsCollide = await exists(join(root, nfc));

    // 権限。chmod 000 が実際に読み取りを拒むか
    const guarded = join(root, "probe-perm.txt");
    await writeFile(guarded, "x");
    let enforcesPermissions = false;
    try {
      await chmod(guarded, 0o000);
      await readFile(guarded);
    } catch {
      // 読めなかった＝権限が尊重されている。例外の型ではなく事実で判定する
      enforcesPermissions = true;
    }
    await chmod(guarded, 0o600);

    // mtime を過去へ
    const past = new Date(1_000_000_000_000);
    await utimes(guarded, past, past);
    const back = await stat(guarded);
    const supportsMtimeInPast = Math.abs(back.mtimeMs - past.getTime()) < 2000;

    return {
      caseSensitive,
      unicodeFormsCollide,
      preservesUnicodeForm,
      enforcesPermissions,
      supportsMtimeInPast,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------------------
// シナリオ
// ----------------------------------------------------------------------------

export class FsScenario {
  readonly root: string;
  /** chmod で塞いだ場所。cleanup で戻さないとディレクトリごと消せなくなる */
  readonly #restricted = new Set<string>();

  private constructor(root: string) {
    this.root = root;
  }

  static async create(tree: TreeSpec = {}): Promise<FsScenario> {
    const scenario = new FsScenario(await mkdtemp(join(tmpdir(), "ingestion-frame-")));
    await scenario.writeAll(tree);
    return scenario;
  }

  /**
   * 相対パスを絶対パスにする。
   * `..` での脱出を拒むのは、フィクスチャのバグが一時ディレクトリの
   * 外側を壊さないようにするため。
   */
  path(relative: string): string {
    const normalized = posix.normalize(relative.split(sep).join("/"));
    if (normalized === ".." || normalized.startsWith("../") || posix.isAbsolute(normalized)) {
      throw new Error(`path escapes the scenario root: ${relative}`);
    }
    return join(this.root, ...normalized.split("/"));
  }

  async writeAll(tree: TreeSpec): Promise<void> {
    for (const [relative, value] of Object.entries(tree)) {
      await this.write(relative, value);
    }
  }

  async write(relative: string, value: string | Uint8Array | FileSpec): Promise<void> {
    const spec = toSpec(value);
    const target = this.path(relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, spec.content);
    // mtime は書き込みで更新されるので、指定があれば書いた後に当てる
    if (spec.mtime !== undefined) await this.setMtime(relative, spec.mtime);
    if (spec.mode !== undefined) await this.chmod(relative, spec.mode);
  }

  read(relative: string): Promise<Buffer> {
    return readFile(this.path(relative));
  }

  async statOf(relative: string): Promise<EntryStat> {
    const s = await stat(this.path(relative));
    // EpochMs は整数。mtimeMs は小数を持つことがある（AGENTS.md 3.8）
    return { sizeBytes: s.size, modifiedAt: Math.trunc(s.mtimeMs) as EpochMs };
  }

  async remove(relative: string): Promise<void> {
    await rm(this.path(relative), { recursive: true, force: true });
  }

  async rename(from: string, to: string): Promise<void> {
    const target = this.path(to);
    await mkdir(dirname(target), { recursive: true });
    await rename(this.path(from), target);
  }

  /** mtime を任意の時刻に当てる。過去に戻すのは #19 の再現 */
  async setMtime(relative: string, at: EpochMs): Promise<void> {
    const when = new Date(at);
    await utimes(this.path(relative), when, when);
  }

  async chmod(relative: string, mode: number): Promise<void> {
    await chmod(this.path(relative), mode);
    if (mode === 0) this.#restricted.add(this.path(relative));
  }

  /**
   * 読み取りを塞ぐ。**実際に塞げたかどうかを返す。**
   *
   * false が返る環境（root で走る CI、Windows）では、フィクスチャは
   * SourceAdapter をラップして EACCES を投げる経路に切り替えます（#17）。
   * 「chmod を呼んだから塞がっているはず」と仮定させないための戻り値です。
   */
  async denyRead(relative: string): Promise<boolean> {
    await this.chmod(relative, 0o000);
    try {
      await readFile(this.path(relative));
      return false;
    } catch {
      return true;
    }
  }

  /** 一時ディレクトリ内の全ファイルを posix 形式の相対パスで返す。順序は安定 */
  async list(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
        else out.push(rel);
      }
    };
    await walk(this.root, "");
    return out.sort();
  }

  async cleanup(): Promise<void> {
    // 塞いだ場所を戻してから消す。ディレクトリを 000 のままにすると rm が失敗する。
    //
    // **浅いものから戻します。** 000 のディレクトリの中には入れないので、
    // 先に子を chmod しようとすると EACCES で落ちます。挿入順のままだと
    // 「ファイルを塞ぐ → その親を塞ぐ」の順で呼ばれたときに再現します
    // （実測: ubuntu / macOS。Windows は chmod がほぼ効かないので出ませんでした）。
    const shallowestFirst = [...this.#restricted].sort(
      (a, b) => a.split(sep).length - b.split(sep).length,
    );
    for (const path of shallowestFirst) {
      try {
        await chmod(path, 0o700);
      } catch (error) {
        // 消えている場合がある。次の rm がまとめて面倒を見るので続行する
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.#restricted.clear();
    await rm(this.root, { recursive: true, force: true });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.cleanup();
  }
}
