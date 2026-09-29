/**
 * ストアが投げるエラーの分類。
 *
 * **メッセージ文字列で判定しないための `code` です。**
 * 受け入れ条件は「実行後に SQL または等値比較で真偽が決まる」形である必要があり、
 * 正規表現でメッセージを見る検査は文言を変えた瞬間に嘘になります。
 *
 * 安全弁の発火（aborted_safety）はエラーではありません。
 * あれは正常な結果であって、状態として返します。ここにあるのは
 * 「呼び出しが誤っている」か「競合した」場合だけです。
 */

import type { BlobKey } from "./types.ts";

export type StoreErrorCode =
  /** 同一 source に running な走査が既にある（#1） */
  | "concurrent_scan"
  /** running でない走査に対する操作 */
  | "scan_not_running"
  /** 件数の内部矛盾。1行も書かずに投げる */
  | "invalid_counts"
  /** 最新完了走査でなくなった走査から削除判定に進もうとした（#1, #2） */
  | "stale_scan"
  /** リースを持たない、または失効したワーカーの操作（#13） */
  | "stale_worker"
  /** 同一 derivationKey で outputsHash / artifactCount が食い違う（#10, #11） */
  | "derivation_divergence"
  /** 同一 blobKey に別内容の put が来た（#8, #21 の blob 版） */
  | "blob_divergence"
  /** 読み取ったバイト数が接続元の申告と食い違った（#7, #20） */
  | "size_mismatch"
  /** 引数そのものが内部矛盾している（導出 ID と実値が合わない等） */
  | "invalid_argument";

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  /**
   * 監査記録の書き込みに失敗した場合の二次的な失敗。
   *
   * **これが入っても `code` は変わりません。** 呼び出し側の再試行判断は
   * 例外の型に依存しているので、監査の失敗で型が化けると
   * 「分岐が起きた」が「一時的な書き込みエラー」に見えます。
   * 記録が消えうることは受け入れた制約ですが（KNOWN_LIMITATIONS 9節）、
   * 記録が消えたうえに例外まで化けるのは別の話です。
   *
   * `cause` を使わないのは、`cause` が「この失敗の原因」を表す枠だからです。
   * ここに入るのは原因ではなく、失敗の**後に**起きた別の失敗です。
   */
  observationWriteError?: unknown;

  constructor(code: StoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}

export class ConcurrentScanError extends StoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("concurrent_scan", message, options);
  }
}

export class ScanNotRunningError extends StoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("scan_not_running", message, options);
  }
}

export class InvalidCountsError extends StoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("invalid_counts", message, options);
  }
}

export class StaleScanError extends StoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("stale_scan", message, options);
  }
}

export class StaleWorkerError extends StoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("stale_worker", message, options);
  }
}

/**
 * 同じ `derivationKey` に、既存と違う内容が到着した（#10, #11）。
 *
 * ## これは復旧経路専用です。到達不能コードではありません
 *
 * 単一プロセスの正規の API 操作では**到達しません**。成功した派生の鍵は
 * `#blockingRun` が恒久的に塞ぐので、二度と claim できないからです。
 * 到達するのは `processing_run` と `derivation` が食い違っている場合だけ:
 *
 *   - 別の台が同じ系譜 DB を共有していて、その台の run 記録がここに無い
 *   - 運用で古い run 記録を刈った
 *   - バックアップから `derivation` だけ新しい状態に復元した
 *
 * **「呼ばれていないから消す」をしないでください。** 消すと、上の3つの状況で
 * 先着が黙って正になります。それが #11 の元の穴そのものです。
 *
 * 到達可能性そのものを主張する試験が `derivation.test.ts` にあります。
 * その試験が raw SQL で状態を作るのは、上の状況を再現するのが目的だからです。
 */
export class DerivationDivergenceError extends StoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("derivation_divergence", message, options);
  }
}

/**
 * 同一 `blobKey` に、保存済みと異なる内容の `put` が来た。
 *
 * `DerivationDivergenceError` と同じ族です。**上書きも無言のスキップもしません。**
 * 内容アドレスなので通常は起こりません。起きるのは実体が壊れたか、
 * ハッシュが衝突したかのどちらかで、**どちらも黙って通してはいけない事象**です。
 *
 * 「鍵があるから中身も正しい」と扱った瞬間、それは削除した `exists()` と
 * 同じ判断になります（AGENTS.md 3.7）。
 *
 * 送出元は `src/store/blob/file-blob-store.ts` の `put` です。鍵の位置に
 * 別内容の実体があったときに投げます。**修復の口（`restoreFromVerifiedBytes`）は
 * 投げません。** あちらは供給されたバイト列が鍵に対応しなければ拒むので、
 * 書ける内容が一意に決まり、「どちらが正か言えない」が起きないためです。
 */
export class BlobDivergenceError extends StoreError {
  /** 修復先をメッセージから推測させない。送出元が検証した内容の鍵。 */
  readonly blobKey?: BlobKey;
  constructor(message: string, options?: ErrorOptions & { blobKey?: BlobKey }) {
    super("blob_divergence", message, options);
    if (options?.blobKey !== undefined) this.blobKey = options.blobKey;
  }
}

/**
 * 読み取ったバイト数が、接続元の申告と食い違った（#7, #20）。
 *
 * **`InvalidArgumentError` から分けました。** 駆動部はこれを受けて
 * `IngestOutcome.size_mismatch` を組み立てます。その枝は
 * `declaredSizeBytes` と `actualSizeBytes` を**数値で**要求するので、
 * 分けないとメッセージ文字列から数字を取り出すしかありません。
 * このファイルの先頭に書いてある「メッセージ文字列で判定しない」の逆です。
 *
 * **メッセージは2つの数から組み立てます。** 呼び出し側に書かせると、
 * 文面と欄の値が食い違う余地が残ります。
 *
 * `restoreFromVerifiedBytes` の鍵不一致は `invalid_argument` のままです。
 * あちらは「呼び出しが誤っている」、こちらは「読んだら違った」です。
 */
export class SizeMismatchError extends StoreError {
  readonly declaredSizeBytes: number;
  readonly actualSizeBytes: number;

  constructor(declaredSizeBytes: number, actualSizeBytes: number, options?: ErrorOptions) {
    super(
      "size_mismatch",
      `expected ${String(declaredSizeBytes)} bytes but read ${String(actualSizeBytes)}`,
      options,
    );
    this.declaredSizeBytes = declaredSizeBytes;
    this.actualSizeBytes = actualSizeBytes;
  }
}

export class InvalidArgumentError extends StoreError {
  constructor(message: string, options?: ErrorOptions) {
    super("invalid_argument", message, options);
  }
}

/** テストと呼び出し側の分岐はこれで行う。メッセージを読まない */
export function isStoreError(error: unknown, code?: StoreErrorCode): error is StoreError {
  return error instanceof StoreError && (code === undefined || error.code === code);
}
