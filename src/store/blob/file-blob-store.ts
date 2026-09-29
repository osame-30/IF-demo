/**
 * 内容アドレス方式の実体置き場（ローカルファイルシステム）。STEP 2b。
 *
 * 契約は `src/domain/types.ts` の `BlobStore` にあります。ここはその実装で、
 * **契約が書けなくしている4点をそのまま守ります**（鍵を受け取る put ／
 * 検証を忘れた get ／ 黙って通る上書き ／ 系譜より先の削除）。
 *
 * ## 一度書いて、読み直して確かめる
 *
 * `put` は書いたバイト列を**読み直して**ハッシュを計算します。
 * 書きながら同時にハッシュを取る形にすると、ディスクに落ちた内容ではなく
 * 「渡されたバイト列」を検証することになります。#8 は「hash 名を持つ
 * 切断されたファイル」なので、確かめたいのは常にディスクの側です。
 *
 * 読み直しは重複 put でも起きます。サイズや mtime で済ませるのは
 * `exists()` を名前を変えて復活させることで、0バイトのファイルも
 * 切断されたファイルもそこを通ります（#8, #20）。
 *
 * ## 途中生成物は内容アドレス名を持ちません
 *
 * 一時ファイルの名前は乱数です（#21）。名前が内容を主張しないので、
 * 書き込み途中で落ちても「その鍵の実体がある」ようには見えません。
 * 置き場所を `<root>/tmp/` にするのは、rename が同じファイルシステム内で
 * ないと原子的にならないためです。
 *
 * ## 実行環境の能力は測って確かめます
 *
 * 親ディレクトリの fsync は、POSIX ではディレクトリを O_RDONLY でしか
 * 開けず、Windows では逆に "r" が EPERM になります（実測）。
 * `process.platform` で分岐しません。`test/support/fs-scenario.ts` が
 * 「推測しない。実際に書いて読み返して確かめる」と書いているのと同じ方針です。
 */

import { randomBytes } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";

import type { Clock } from "../../domain/clock.ts";
import {
  BlobDivergenceError,
  InvalidArgumentError,
  SizeMismatchError,
} from "../../domain/errors.ts";
import { attestFullRead, attestPersisted } from "../../domain/evidence.ts";
import { blobKeyOf } from "../../domain/ids.ts";
import type {
  BlobDeletionGrant,
  BlobDeletionJudge,
  BlobDeletionOutcome,
  BlobKey,
  BlobStore,
  ContentHash,
  PutResult,
  VerifiedContentHash,
  VerifiedRead,
} from "../../domain/types.ts";
import { blobPath } from "./blob-path.ts";

export interface FileBlobStoreOptions {
  /** blob 置き場の根。絶対パスを渡すこと */
  readonly root: string;
  /** `verifiedAt` に入る時刻の供給源。`Date.now()` は呼ばない（AGENTS.md 3.8） */
  readonly clock: Clock;
}

/** errno を取り出す。`catch {}` を書かないために、失敗の種類を見る */
function errnoOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** ディレクトリを開けなかったのが「そのモードでは開けない」だけかどうか */
const DIRECTORY_MODE_REFUSALS: ReadonlySet<string> = new Set([
  "EISDIR",
  "EPERM",
  "EACCES",
  "EINVAL",
]);

/**
 * 親ディレクトリを fsync する（put の手順6）。
 *
 * ここを省くと、rename 後・fsync 前の電源断でディレクトリエントリが
 * 復活しません。「置いたはずのものが無い」は #8 の鏡像です。
 */
async function fsyncDirectory(dir: string): Promise<void> {
  const refusals: string[] = [];
  for (const mode of ["r", "r+"]) {
    let handle;
    try {
      handle = await open(dir, mode);
    } catch (error) {
      const code = errnoOf(error);
      if (code !== undefined && DIRECTORY_MODE_REFUSALS.has(code)) {
        refusals.push(`${mode}: ${code}`);
        continue;
      }
      throw error;
    }
    try {
      await handle.sync();
      return;
    } catch (error) {
      const code = errnoOf(error);
      if (code === undefined || !DIRECTORY_MODE_REFUSALS.has(code)) throw error;
      refusals.push(`${mode}: ${code}`);
    } finally {
      await handle.close();
    }
  }
  // 握りつぶしません。永続を主張できない環境だと分かった方が良い
  throw new Error(`cannot fsync directory ${dir} (tried ${refusals.join(", ")})`);
}

export class FileBlobStore implements BlobStore {
  readonly #root: string;
  readonly #clock: Clock;

  constructor(options: FileBlobStoreOptions) {
    this.#root = options.root;
    this.#clock = options.clock;
  }

  async put(content: ReadableStream<Uint8Array>, expectedSizeBytes: number): Promise<PutResult> {
    return this.#write(content, expectedSizeBytes, null);
  }

  async restoreFromVerifiedBytes(
    key: BlobKey,
    content: ReadableStream<Uint8Array>,
    expectedSizeBytes: number,
  ): Promise<PutResult> {
    return this.#write(content, expectedSizeBytes, key);
  }

  async verify(key: BlobKey, expectedHash: ContentHash): Promise<boolean> {
    const stored = await this.#digestOf(blobPath(this.#root, key));
    // 無い実体は false。例外にしないのは、これが監査の入口だからです。
    // 列挙した参照を潰していく用途で、1件の不在で走査が止まると困ります
    return stored !== null && String(stored.hash) === String(expectedHash);
  }

  /**
   * 検証つきの読み取り。**証拠は消費者が読み切ったときにだけ出ます。**
   *
   * ハッシュ側のストリームは、消費者が引いた分だけ進みます。`tee` を使うと
   * ハッシュ側が独立に先へ進めるので、**1バイトも読まなかった消費者にも
   * 証拠が出てしまいます。** それでは早期離脱と読了の区別が消え、
   * `VerifiedRead` を導入した理由が無くなります。
   */
  async get(key: BlobKey, expectedHash: ContentHash): Promise<VerifiedRead> {
    const handle = await open(blobPath(this.#root, key), "r");
    const reader = (
      Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>
    ).getReader();

    let feed: ReadableStreamDefaultController<Uint8Array> | undefined;
    const digestSide = new ReadableStream<Uint8Array>({
      start(controller) {
        feed = controller;
      },
    });
    const completed: Promise<VerifiedContentHash> = attestFullRead(digestSide, expectedHash).then(
      (result) => result.hash,
    );
    // completed を待たない呼び出し側がいてもプロセスを落とさない。
    // 握りつぶしではありません。待つ側にはそのまま reject が届きます
    completed.catch(() => undefined);

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            reader.releaseLock();
            feed?.close();
            await completed;
            controller.close();
            return;
          }
          feed?.enqueue(chunk.value);
          controller.enqueue(chunk.value);
        } catch (error) {
          // 実読込の拒否も検算側へ伝える。片側だけを閉じると completed が決着しない。
          feed?.error(error);
          reader.releaseLock();
          controller.error(error);
        }
      },
      async cancel(reason) {
        feed?.error(new Error("verified read was cancelled before the end"));
        try { await reader.cancel(reason); }
        finally { reader.releaseLock(); }
      },
    });

    return { stream, completed };
  }

  async getUnverifiedForRepair(key: BlobKey): Promise<ReadableStream<Uint8Array>> {
    const handle = await open(blobPath(this.#root, key), "r");
    return Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>;
  }

  /**
   * 実体を消す。**v0.1 では実装しません**（`types.ts` の `BlobStore.delete`）。
   *
   * 到達不能です。`BlobDeletionGrant` の発行元が `LineageStore` に無いので
   * （AC-BLB-04）、授権を正規の経路で入手できません。
   * ここが実装されていないことが「削除は v0.1 では実装しない」の実体です。
   *
   * `StoreError` にしないのは、`StoreErrorCode` が「呼び出しが誤っている」か
   * 「競合した」を表す枠だからです。未実装はどちらでもありません。
   */
  async delete(
    _key: BlobKey,
    _grant: BlobDeletionGrant,
    _judge: BlobDeletionJudge,
  ): Promise<BlobDeletionOutcome> {
    throw new Error(
      "BlobStore.delete is not implemented in v0.1. " +
        "The contract is in place but no BlobDeletionGrant issuer exists (AC-BLB-04).",
    );
  }

  // --------------------------------------------------------------------------
  // 内部
  // --------------------------------------------------------------------------

  /** 実体を読み直してハッシュとサイズを出す。無ければ null */
  async #digestOf(path: string): Promise<{ hash: VerifiedContentHash; sizeBytes: number } | null> {
    let handle;
    try {
      handle = await open(path, "r");
    } catch (error) {
      if (errnoOf(error) === "ENOENT") return null;
      throw error;
    }
    const stream = Readable.toWeb(handle.createReadStream()) as ReadableStream<Uint8Array>;
    return attestFullRead(stream);
  }

  /**
   * put と restoreFromVerifiedBytes の共通の7手順。
   *
   * @param replacing 修復なら置き換える鍵。新規 put なら null。
   *        **この2つの違いは「上書きしてよいか」だけです。** 修復側で
   *        上書きが許されるのは、供給されたバイト列のハッシュが鍵に
   *        対応しなければ拒否するので、書ける内容が一意に決まるためです。
   */
  async #write(
    content: ReadableStream<Uint8Array>,
    expectedSizeBytes: number,
    replacing: BlobKey | null,
  ): Promise<PutResult> {
    // mkdir/open が失敗しても入力は既に受け取っている。所有した reader を必ず返す。
    const reader = content.getReader();
    let consumed = false;
    let failed = false;
    let failure: unknown;
    const temporary = join(this.#root, "tmp", randomBytes(16).toString("hex"));

    // 後片付けは書き込みの失敗も覆います。ここを手順3以降だけに掛けると、
    // ストリームが途中で error したとき（#21）に一時ファイルが残ります
    try {
      await mkdir(dirname(temporary), { recursive: true });
      // 手順1-2: 一時ファイルへ書いて fsync。名前は内容を主張しない（#21）
      //
      // 一塊ずつ await して書きます。`createWriteStream` を挟むと fsync の
      // ために `autoClose: false` が要り、`pipeline` が閉じないストリームの
      // 'close' を待って戻らなくなります（実測）。ここは配管を持ちません
      const sink = await open(temporary, "wx");
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) { consumed = true; break; }
          await sink.write(chunk.value);
        }
        await sink.sync();
      } finally {
        await sink.close();
      }

      // 手順3-4: 書いた「ディスクの側」を読み直して確かめる
      const written = await this.#digestOf(temporary);
      if (written === null) throw new Error(`temporary blob vanished: ${temporary}`);
      if (written.sizeBytes !== expectedSizeBytes) {
        // 列挙時の申告と食い違う。書き込み途中のファイルを
        // 「存在しなかった状態」として永続化しない（#7）。0 は正当な値（#20）
        //
        // **専用の型で投げます。** 駆動部はこれを `IngestOutcome.size_mismatch`
        // に写しますが、その枝は両方の数を**数値で**要求します。
        // `invalid_argument` のままだと、駆動部はメッセージから数字を
        // 取り出すしかありません
        throw new SizeMismatchError(expectedSizeBytes, written.sizeBytes);
      }

      const key = blobKeyOf(written.hash);
      if (replacing !== null && String(key) !== String(replacing)) {
        throw new InvalidArgumentError(
          `restoreFromVerifiedBytes: content hashes to ${String(key)}, not ${String(replacing)}`,
        );
      }

      const final = blobPath(this.#root, key);
      // 修復は上書きが許される。新規 put は既存を読み直して突き合わせる
      const stored = replacing === null ? await this.#digestOf(final) : null;
      if (stored !== null) {
        if (String(stored.hash) !== String(key)) {
          // 鍵があるから中身も正しい、とは扱わない（AGENTS.md 3.7、#8, #21）
          throw new BlobDivergenceError(
            `blob ${String(key)} already exists with different content ` +
              `(stored ${String(stored.hash)})`,
            { blobKey: key },
          );
        }
        // 前回の rename は成功し、親の同期だけ失敗したかもしれない。
        // 内容を読み直せることはディレクトリエントリの永続化の証拠ではない。
        await fsyncDirectory(dirname(final));
        return this.#result(key, stored.hash, stored.sizeBytes, false);
      }

      // 手順5-6: 最終名へ rename して親ディレクトリを fsync
      await mkdir(dirname(final), { recursive: true });
      await rename(temporary, final);
      await fsyncDirectory(dirname(final));

      // 手順7
      return this.#result(key, written.hash, written.sizeBytes, true);
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      const cleanupErrors: unknown[] = [];
      if (!consumed) {
        try { await reader.cancel(failure); }
        catch (error) { if (error !== failure) cleanupErrors.push(error); }
      }
      reader.releaseLock();
      // rename が成功していれば一時ファイルはもう無い。無くても失敗にしない
      await unlink(temporary).catch((error: unknown) => {
        if (errnoOf(error) !== "ENOENT") cleanupErrors.push(error);
      });
      if (cleanupErrors.length > 0) {
        throw new AggregateError([...(failed ? [failure] : []), ...cleanupErrors], "blob write cleanup failed");
      }
    }
  }

  #result(
    key: BlobKey,
    hash: VerifiedContentHash,
    sizeBytes: number,
    created: boolean,
  ): PutResult {
    return {
      blobKey: key,
      contentHash: hash,
      sizeBytes,
      created,
      verifiedAt: attestPersisted(this.#clock.now(), hash),
    };
  }
}
