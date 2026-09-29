/**
 * ============================================================================
 *  走査の駆動部 — STEP 4（ハッシュ + 差分検知 + 削除検知）
 * ============================================================================
 *
 * 列挙 → 取得 → ハッシュ → 記録 → 完了 → 削除判定。
 * `LineageStore` / `BlobStore` / `SourceAdapter` を繋ぐのはここだけです。
 *
 * ## 通常の走査でこの層が持つ判断
 *
 * 1. **何件見たか**（`enumeratedCount` / `distinctCount` / `writeFailureCount`）。
 *    安全弁はこの3つで発火します。数えるのが呼び出し側なのは、
 *    `recordObservedDocument` が失敗を握りつぶさず例外で返すからです。
 *    「DB が書けなかった事実を DB に書きに行く」自己矛盾を避けています（#16）。
 * 2. **落としたものをどこへ出すか。** 一覧できなかった部分木は
 *    `recordUnlistableSubtree` へ、鍵にできなかった名前は `entry_skipped` へ。
 * 3. **欠損を墓標にするか。** 進めるのは `promoteToCompleted` が
 *    `CompletedScanRun` を返したときだけです。型がその門です。
 *
 * 障害後は運用者の明示指定で復旧します。判断と上限は ScanRecoveryOptions にあり、
 * 自動的な running の回収や無条件の承認は行いません。
 *
 * ## 差分検知は「取り直さない」ではありません
 *
 * **常に hash を取ります。**`quickFingerprint` による取得スキップは
 * 実装しません（KNOWN_LIMITATIONS 4節）。`cp -p` と `rsync -t` は mtime と
 * size を保ったまま内容を変えるので、指紋の一致は内容の一致を含意しません。
 * 差分は「新しい版ができたか」で表れます（`insertVersionIfAbsent` の `created`）。
 *
 * スキップが要るのは大規模接続元だけで、v0.1 の範囲外です。型には
 * 置き場所（`Document.lastFingerprint`）だけがあり、判断には使いません。
 *
 * ## 書けなくしていること
 *
 * - **`ScanId` を裸で渡す削除。** 削除判定に渡せるのは `CompletedScanRun` だけで、
 *   その値を作れるのは `promoteToCompleted` だけです。
 * - **黙って減る列挙。** 落としたものは `enumerate` が流すので、
 *   受け取らないという選択肢が型にありません（判別ユニオンの片枝）。
 * - **読めなかったものを欠損として扱うこと。** `unreadable` も
 *   `size_mismatch` も `recordObservedDocument` を通るので、
 *   どの枝でも `last_seen` が進みます（#17）。
 */

import {
  isStoreError,
  BlobDivergenceError,
  InvalidArgumentError,
  SizeMismatchError,
} from "../domain/errors.ts";
import type {
  BlobStore,
  CompletedScanRun,
  Document,
  IngestOutcome,
  LineageStore,
  ObservedEntry,
  ObservedResult,
  PutResult,
  ScanId,
  ScanStatus,
  SkippedEntry,
  SourceAdapter,
  SourceEntry,
  SourceId,
} from "../domain/types.ts";

export interface ScanDependencies {
  readonly adapter: SourceAdapter;
  readonly store: LineageStore;
  readonly blobs: BlobStore;
  /** `DocumentVersion.pipelineVersion` に焼き込む値 */
  readonly pipelineVersion: string;
  /**
   * `mimeTypeHint` を出さない接続元のための型。**既定値を持ちません。**
   *
   * ローカルFS アダプタは中身を見ないので、この値が全 version に入ります。
   * ここに `"application/octet-stream"` を埋め込むと、拡張子から推測する
   * 実装に差し替えたときに**過去の版だけが octet-stream のまま残り**、
   * その差が「内容が変わった」に見えます。呼び出し側に言わせます
   * （`KeyNormalizationPolicy` と同じ理由）。
   */
  readonly fallbackMimeType: string;
}

export interface ScanThresholds {
  readonly countRatioThresholdBp: number;
  readonly missingRatioThresholdBp: number;
}

/** S4-11 / S4-9 / S4-3・7: 自動で門を開かず、運用者が選んだ出口だけを通す。 */
export interface ScanRecoveryOptions {
  /** 走査プロセスの停止を確認してから、findRunningScan が返した世代を指定する。 */
  readonly interruptedScan?: { readonly scanId: ScanId; readonly reason: string };
  /** 再取得した内容が壊れた鍵と一致するときだけ修復する。既定では分岐を失敗にする。 */
  readonly repairCorruptBlobs?: boolean;
  /** 列挙が終わった時点の件数を運用者へ見せる。undefined は承認しない。 */
  readonly reviewSafety?: (review: ScanSafetyReview) => Promise<
    { readonly note: string; readonly maxMissingCount: number } | undefined
  >;
}

export interface ScanSafetyReview {
  readonly scanId: ScanId;
  readonly previousDistinctCount: number;
  readonly enumeratedCount: number;
  readonly distinctCount: number;
  readonly missingCount: number;
  readonly writeFailureCount: number;
  readonly unlistableSubtreeCount: number;
}

/**
 * 走査1本の結果。**状態そのものではなく、この走査で何が起きたかの要約です。**
 *
 * 弁が閉じた走査でも返ります。例外にしないのは、弁の発火が異常ではなく
 * 正常な判定結果だからです（`finishScan` の契約と同じ扱い）。
 */
export interface ScanReport {
  readonly scanId: ScanId;
  readonly status: ScanStatus;
  readonly abortReason?: string;

  /** 列挙できた件数（重複を含む）。落としたものは入らない */
  readonly enumeratedCount: number;
  /** 観測が成立した documentId の異なり数。**安全弁はこちらを見る**（#27） */
  readonly distinctCount: number;
  /** 観測の記録に失敗した件数。1件でも 0 でなければ削除判定に進めない（#16） */
  readonly writeFailureCount: number;

  /** 一覧できなかった部分木。**1件でもあれば弁は閉じ、承認でも免除されない** */
  readonly unlistableSubtreeCount: number;
  /** 鍵として運べず落とした件数（部分木を除く） */
  readonly skippedCount: number;

  /** 新しく document 行ができた件数 */
  readonly discoveredCount: number;
  /** tombstone から戻った件数（#25） */
  readonly revivedCount: number;
  /** 新しい版ができた件数。**差分はここに出ます** */
  readonly versionsCreatedCount: number;

  /** 欠損として見えた件数。削除判定に進めなければ 0 */
  readonly missingCount: number;
  /** 実際に墓標が立った件数。`missingCount` 以下 */
  readonly tombstonedCount: number;

  /**
   * この走査の**前に**片付けた、前回の未反映の削除（C1）。
   *
   * 無ければ欄そのものがありません。あるということは、前の走査が
   * 「弁は通ったが削除の反映が終わらないまま終了した」という意味です。
   * **運用表示にはこの欄を出してください。** `completed` だけを見ていると、
   * 反映されていない削除があったことが読み取れません。
   */
  readonly resumed?: ResumedDeletion;
  /** 明示的な復旧指定で閉じた世代。現在の走査とは別の事実。 */
  readonly recoveredScanId?: ScanId;
  /** 検証付きで修復した blob の数。無言の上書きにしないために表示する。 */
  readonly repairedBlobCount: number;
}

/** `resumePendingDeletion` の結果。`ScanReport.resumed` に載る */
export interface ResumedDeletion {
  readonly scanId: ScanId;
  /**
   * 反映できたか。`false` は門（`promoteToCompleted`）が拒んだという意味で、
   * **その `pending` は残ったままです。** 黙って捨てません
   */
  readonly applied: boolean;
  readonly missingCount: number;
  readonly tombstonedCount: number;
}

/** 走査中に積む数。`ScanReport` に写して返す */
interface Tally {
  enumerated: number;
  writeFailures: number;
  unlistable: number;
  skipped: number;
  discovered: number;
  revived: number;
  versionsCreated: number;
  repairedBlobs: number;
}

/**
 * 失敗を1語で言う。**メッセージ文字列は読みません。**
 *
 * `IngestOutcome.unreadable` の `errorKind` に入り、観測の detail に残ります。
 * 運用者が「何が起きて版にならなかったのか」を種類で数えられるようにするための値で、
 * 人間向けの説明ではありません。
 */
function errorKindOf(error: unknown): string {
  if (isStoreError(error)) return error.code;
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return error instanceof Error ? error.name : "unknown";
}

/**
 * 落としたもののうち、**列挙に出ていて、鍵として渡せるもの。**
 *
 * **v0.1 で `vanished_during_scan` をここへ入れました。** 以前は
 * 「`lstat` が成功して素性まで分かっている枝だけ」で、`lstat` が失敗した枝は
 * 「本当に消えている」として観測に通していませんでした。**それが偽でした。**
 * `lstat` の失敗理由は `ENOENT` だけではありません。`x` の無いディレクトリの
 * 中のファイルは `readdir` に出るのに `lstat` が `EACCES` で落ちます
 * （実測: WSL / ext4。実在するファイル1件が墓標になりました）。
 *
 * errno で枝を分ける道もありましたが、採りませんでした。
 * **列挙に出たものは、今回は墓標にしません。** そう決めると errno の分岐が
 * 丸ごと消え、fetch 側で `ENOENT` になった場合（そちらは元から `unreadable`）
 * と扱いが揃います。同じ事象が「どの syscall が先に気づいたか」で
 * 分かれることが無くなります。
 *
 * 代償は2つあり、どちらも承知の上です。
 *   1. 走査**中**に消えたファイルは、墓標が1走査ぶん遅れます。走査と走査の
 *      間に消えたものは `readdir` に出ないので、従来どおり即座に墓標です。
 *   2. 消えた分が `distinctCount` に乗るので、次回の基準値が少し高くなります。
 *      入れ替わりの激しい source では弁が鳴りやすくなります。**fail-closed 側**
 *      なので、実在するファイルを墓標にするより優先します。
 *
 * **`office_temporary_file` は意図的に入れません。** 入れると Office を開くたびに
 * 版の無い document ができ、閉じると削除確認に回ります（2026-09-15 の実操作動画）。
 * 「列挙に出たものは今回は墓標にしない」の例外で、規則の前に文書になった `~$` は
 * 次の走査で1回だけ欠損になります（攻撃レビュー DF-5）。
 *
 * `unusable_name` も入れられません。`lstat` より前に落としているうえ、
 * **鍵として渡せません** — 鍵にできないことが落とす理由なので、`stableKey` を
 * 観測へ渡すと `normalizeStableKey` がそれを畳み、別の文書と同じ documentId に
 * 潰れます（S-11）。
 */
function listedAndKeyable(
  skipped: SkippedEntry,
): skipped is Extract<
  SkippedEntry,
  { kind: "hard_linked" | "not_a_regular_file" | "vanished_during_scan" }
> {
  return (
    // DF-5: office_temporary_file は意図的な対象除外。観測へ通すと再び文書を作ってしまう。
    skipped.kind === "hard_linked" ||
    skipped.kind === "not_a_regular_file" ||
    skipped.kind === "vanished_during_scan"
  );
}

/**
 * 観測を1件記録して、数に入れる。**失敗を握りつぶしません。**
 *
 * 呼び出し元が2つあるので1箇所にしてあります。別々に書くと、片方だけが
 * 失敗を数え忘れる形が書けます —— そして数え忘れた走査は完了し、
 * 記録されなかった1件が次の削除判定で欠損に見えます（#16）。
 *
 * @returns 記録できたら結果、ストアが書けなければ undefined
 */
async function observe(
  store: LineageStore,
  scanId: ScanId,
  entry: ObservedEntry,
  tally: Tally,
  distinct: Set<string>,
): Promise<ObservedResult | undefined> {
  let observed: ObservedResult;
  try {
    observed = await store.recordObservedDocument(scanId, entry);
  } catch (error) {
    // **自分のコードの誤りは握りつぶしません。** 数えてよいのは
    // 「ストアが書けなかった」だけです
    if (!isStoreError(error)) throw error;
    // #16: 失敗の事実を DB に書きに行けないので、呼び出し側が数えます。
    // 1件でも 0 でなければ削除判定に進めず、**承認でも免除されません**
    tally.writeFailures += 1;
    return undefined;
  }
  distinct.add(String(observed.documentId));
  if (observed.created) tally.discovered += 1;
  if (observed.revived) tally.revived += 1;
  return observed;
}

/**
 * 落としたものを記録する。
 *
 * **`unlistable_subtree` だけ宛先が違います。** 残りは「そこに在るが鍵にできない」
 * ですが、これは「そこに何件在ったのかが分からない」です。件数が分からない以上、
 * 減った件数を正常と読む根拠がありません。だから弁を閉じる側へ出します。
 */
async function recordSkipped(
  store: LineageStore,
  scanId: ScanId,
  skipped: SkippedEntry,
  tally: Tally,
  distinct: Set<string>,
): Promise<void> {
  if (skipped.kind === "unlistable_subtree") {
    // 失敗しても握りつぶしません。呼べなければ弁が閉じず、
    // 見えなかった範囲がそのまま欠損として墓標になります
    await store.recordUnlistableSubtree(scanId, {
      subtreeKey: skipped.subtreeKey,
      errorKind: skipped.errorKind,
    });
    tally.unlistable += 1;
    return;
  }

  // **落とした事実は、理由に関わらずここ1箇所に残します。**
  // 「何を列挙から落としたか」を1本の問い合わせで数えられるようにするためです。
  // 下の観測と二重に見えますが、答える問いが違います
  await store.appendObservation({
    kind: "entry_skipped",
    scanId,
    detail: { ...skipped },
  });
  tally.skipped += 1;

  // **列挙に出たものは、観測にも通します。**
  //
  // 通さないと `last_seen` が進まず、**ディスク上に在るファイルが次の
  // 削除判定で墓標になります。** 実測: 60件を取り込んだ後に1件へ hardlink を
  // 張ると、既定に近い閾値（9000 / 1000）でも走査は `completed` で終わり、
  // その1件が tombstone されました。欠損比 1.7% は弁を通ります。
  // `lstat` が `EACCES` で落ちた枝でも同じことが起きます（実測: WSL / ext4）。
  //
  // #17 と同じ形です。あちらは「読めなかったことは見えなかったことではない」、
  // こちらは**「鍵にできなかったことも、見に行けなかったことも、
  // 無くなったことではない」**。
  if (!listedAndKeyable(skipped)) return;
  await observe(
    store,
    scanId,
    {
      stableKey: skipped.stableKey,
      outcome: {
        kind: "unreadable",
        // 落ちた理由が分かっている枝は理由を残す。`kind` で潰さない
        errorKind: skipped.kind === "vanished_during_scan" ? skipped.errorKind : skipped.kind,
      },
    },
    tally,
    distinct,
  );
}

/**
 * 1件を取り込む。**3つの結末すべてが `recordObservedDocument` を通ります。**
 *
 * 版になるのは `content` の枝だけですが、`unreadable` も `size_mismatch` も
 * 「観測された」ことに変わりはありません。ここを通さないと `last_seen` が
 * 進まず、読めなかった1件が次の削除判定で欠損に見えます（#17）。
 */
async function ingestOne(
  deps: ScanDependencies,
  scanId: ScanId,
  entry: SourceEntry,
  tally: Tally,
  distinct: Set<string>,
  recovery: ScanRecoveryOptions,
): Promise<void> {
  const { adapter, blobs, store } = deps;

  let put: PutResult | undefined;
  let outcome: IngestOutcome;
  try {
    const content = await adapter.fetch(entry.stableKey);
    // 鍵は渡しません。内容から導出され、材料はその場にあります。
    // `expectedSizeBytes` は接続元の申告で、**反証するために**渡します（#7）
    put = await blobs.put(content, entry.sizeBytes);
    outcome = { kind: "content", contentHash: put.contentHash, sizeBytes: put.sizeBytes };
  } catch (error) {
    if (error instanceof SizeMismatchError) {
      // 2つの数は欄から取ります。メッセージを読まないための型です
      outcome = {
        kind: "size_mismatch",
        declaredSizeBytes: error.declaredSizeBytes,
        actualSizeBytes: error.actualSizeBytes,
      };
    } else if (isStoreError(error, "blob_divergence")) {
      // **同じ鍵の位置に別内容がある。**「上書きも、無言のスキップもしない」が
      // `put` の契約です。ここで `unreadable` に写すと、走査は完了し
      // `last_seen` も進むので、**無言のスキップそのもの**になります
      if (!recovery.repairCorruptBlobs || !(error instanceof BlobDivergenceError) ||
          error.blobKey === undefined) throw error;
      // S4-9: 鍵は失敗した put が読んだ内容から決まる。再取得が変わっていれば
      // restore が拒み、ここから投げるので unreadable に畳まれない。
      put = await blobs.restoreFromVerifiedBytes(
        error.blobKey, await adapter.fetch(entry.stableKey), entry.sizeBytes,
      );
      tally.repairedBlobs += 1;
      outcome = { kind: "content", contentHash: put.contentHash, sizeBytes: put.sizeBytes };
    } else {
      outcome = { kind: "unreadable", errorKind: errorKindOf(error) };
    }
  }

  const observed = await observe(
    store,
    scanId,
    {
      stableKey: entry.stableKey,
      ...(entry.quickFingerprint === undefined
        ? {}
        : { quickFingerprint: entry.quickFingerprint }),
      outcome,
    },
    tally,
    distinct,
  );
  if (observed === undefined) return;

  if (outcome.kind !== "content" || put === undefined) return;

  const inserted = await store.insertVersionIfAbsent({
    documentId: observed.documentId,
    contentHash: put.contentHash,
    sizeBytes: put.sizeBytes,
    blobKey: put.blobKey,
    blobVerifiedAt: put.verifiedAt,
    mimeType: entry.mimeTypeHint ?? deps.fallbackMimeType,
    ...(entry.modifiedAt === undefined ? {} : { sourceModifiedAt: entry.modifiedAt }),
    discoveredByScanId: scanId,
    pipelineVersion: deps.pipelineVersion,
  });
  if (inserted.created) tally.versionsCreated += 1;

  // **`created` が false でも必ず呼びます（#15）。** 版の挿入後・ポインタ更新前に
  // 落ちた走査を再実行すると `created` は false ですが、ポインタは古いままです。
  // ここで打ち切ると、そのポインタは二度と直りません
  await store.setActiveVersion({
    documentId: observed.documentId,
    observedHash: put.contentHash,
    versionId: inserted.versionId,
    scanId,
  });
}

/**
 * 走査を1本回す。
 *
 * 削除判定まで含みます。**分けていないのは、分けると誰も呼ばないからです。**
 * 進める条件（`promoteToCompleted` が値を返すこと）は型が持っているので、
 * 一続きにしても弁を迂回する経路は生まれません。
 *
 * @throws 列挙そのものが続けられなくなった場合。走査は `failed` で閉じてから
 *         投げ直します。`failed` の走査は次回の基準値になれず（#3）、
 *         `promoteToCompleted` も通りません。
 *
 *         **閉じられなかった場合は `running` のまま残ります。** DB そのものが
 *         書けないとき（本物の `SQLITE_BUSY`、ディスク障害）は `failScan` も
 *         同じ理由で落ちるので、`AggregateError` を投げて走査は `running` の
 *         ままです。次の `runScan` は `concurrent_scan` で始まれません。
 *         運用者はプロセス停止を確認し、findRunningScan(sourceId) で世代を取得して
 *         interruptedScan に指定します（KNOWN_LIMITATIONS 12節 #2、S4-11）。
 */
export async function runScan(
  deps: ScanDependencies,
  thresholds: ScanThresholds,
  recovery: ScanRecoveryOptions = {},
): Promise<ScanReport> {
  const { adapter, store } = deps;
  const sourceId = adapter.descriptor.sourceId;

  if (recovery.interruptedScan !== undefined) {
    const running = await store.findRunningScan(sourceId);
    // S4-11: 古い運用画面の判断で、新たに始まった走査を閉じない。
    if (running?.scanId !== recovery.interruptedScan.scanId) {
      throw new InvalidArgumentError("interrupted scan is no longer the running scan for this source");
    }
    await store.failScan(running.scanId, recovery.interruptedScan.reason);
  }

  // **前回の未反映の削除を、走査を始める前に片付ける（C1）。**
  // ここで落ちたら走査は始めません。反映を飛ばして次を始めると、
  // 同じ欠損を二度数えた比率で弁が閉じ、閉じたこと自体が反映を妨げます
  const pending = await resumePendingDeletion(store, sourceId);

  const scan = await store.beginScan(sourceId, thresholds);

  const tally: Tally = {
    enumerated: 0,
    writeFailures: 0,
    unlistable: 0,
    skipped: 0,
    discovered: 0,
    revived: 0,
    versionsCreated: 0,
    repairedBlobs: 0,
  };
  /** 正規化は迂回できないので、ストアが返した ID を数えます（#6, #23） */
  const distinct = new Set<string>();
  let phase: "enumeration" | "ingestion" | "review" = "enumeration";

  try {
    for await (const item of adapter.enumerate()) {
      phase = "ingestion";
      if (item.kind !== "entry") {
        // **観測に通すものは列挙にも数えます。** 数えないと
        // `distinctCount > enumeratedCount` になり、`finishScan` が
        // `InvalidCountsError` で弾きます（lineage-store.ts:370、実測）
        if (listedAndKeyable(item)) tally.enumerated += 1;
        await recordSkipped(store, scan.scanId, item, tally, distinct);
        phase = "enumeration";
        continue;
      }
      tally.enumerated += 1;
      await ingestOne(deps, scan.scanId, item.entry, tally, distinct, recovery);
      phase = "enumeration";
    }
    if (recovery.reviewSafety !== undefined) {
      phase = "review";
      const approval = await recovery.reviewSafety({
        scanId: scan.scanId,
        previousDistinctCount: scan.previousDistinctCount,
        enumeratedCount: tally.enumerated,
        distinctCount: distinct.size,
        missingCount: await store.countMissingInRunningScan(scan.scanId),
        writeFailureCount: tally.writeFailures,
        unlistableSubtreeCount: tally.unlistable,
      });
      if (approval !== undefined) {
        await store.approveScan(scan.scanId, approval.note, approval.maxMissingCount);
      }
    }
  } catch (error) {
    try {
      // **理由は例外の種類から採ります。** 以前は一律 `enumeration_failed` でした。
      // それだと blob の分岐（`blob_divergence`）で止まった走査が、監査には
      // 「列挙が落ちた」と残ります。分岐の事実は observation に書けません
      // （`put` は観測より前に落ち、documentId がまだ無い）ので、
      // `abort_reason` が唯一の痕跡です（S4-9）。ストアの例外は `code` を、
      // それ以外は失敗した段階を見る。SQLITE_BUSY を列挙の失敗へ誤帰属させない。
      await store.failScan(
        scan.scanId,
        isStoreError(error) ? error.code : phase === "enumeration" ? "enumeration_failed"
          : phase === "review" ? "safety_review_failed" : errorKindOf(error),
      );
    } catch (closeError) {
      // 閉じられなかった。走査は running のまま残り、この source では
      // `idx_one_running_scan` によって次の `beginScan` が通りません。
      // **元の失敗を隠しません。** 原因はそちらです
      throw new AggregateError(
        [error, closeError],
        `scan ${scan.scanId} could not be closed after ${phase} failed`,
      );
    }
    throw error;
  }

  const finished = await store.finishScan(scan.scanId, {
    enumeratedCount: tally.enumerated,
    distinctCount: distinct.size,
    writeFailureCount: tally.writeFailures,
  });

  const base: ScanReport = {
    scanId: scan.scanId,
    status: finished.status,
    ...(finished.abortReason === undefined ? {} : { abortReason: finished.abortReason }),
    enumeratedCount: tally.enumerated,
    distinctCount: distinct.size,
    writeFailureCount: tally.writeFailures,
    unlistableSubtreeCount: tally.unlistable,
    skippedCount: tally.skipped,
    discoveredCount: tally.discovered,
    revivedCount: tally.revived,
    versionsCreatedCount: tally.versionsCreated,
    missingCount: 0,
    tombstonedCount: 0,
    repairedBlobCount: tally.repairedBlobs,
    ...(recovery.interruptedScan === undefined ? {} : { recoveredScanId: recovery.interruptedScan.scanId }),
    ...(pending === undefined ? {} : { resumed: pending }),
  };

  // **この文は変異検査で殺されません（実測: P10 が生存）。** 直後の
  // `promoteToCompleted` が `status !== "completed"` を同じ理由で弾くので、
  // 消しても振る舞いは変わりません。**残してあるのは、これが
  // `SAFETY_ABORT_WRITES_NOTHING` の主張そのものの文だからです。**
  // 門は2つありますが、独立に失敗しうるのは片方だけです
  if (finished.status !== "completed") return base;

  // 削除判定へ進む唯一の門。null なら進めない（追い越された / 弁が閉じた）
  const completed = await store.promoteToCompleted(scan.scanId);
  if (completed === null) return base;

  const applied = await applyDeletions(store, completed);
  return { ...base, ...applied, ...(pending === undefined ? {} : { resumed: pending }) };
}

/**
 * 削除の反映。**通常経路と再開経路が同じ関数を通ります。**
 *
 * 2本に分かれていると、再開の側だけ検査が緩む余地が残ります。門は
 * `promoteToCompleted` で、ここに来る時点で通過済みです。
 *
 * **検査点は3つ**（C1 の受け入れ条件）:
 *
 *   1. `finishScan` の後 … `deletion_state='pending'` が行に残る
 *   2. 各 `document_missing` の後 … 観測は追記なので再開しても失われない
 *   3. 各 `tombstone` の後 … 墓標が立った文書は `active` でなくなるので、
 *      再開時の `findMissingSince` からは自動的に外れる
 *
 * どこで落ちても `pending` のままなので、次の走査の前に再開されます。
 * **途中まで反映された状態から再開しても、中断しなかった実行と同じ状態に
 * 収束します**（2 と 3 が冪等なため）。プロセスが落ちても同じです——
 * 検査点は行であって、メモリ上の変数ではありません。
 */
async function applyDeletions(
  store: LineageStore,
  completed: CompletedScanRun,
): Promise<{ missingCount: number; tombstonedCount: number }> {
  // **欠損集合を先に確定させます。** 反復しながら書くと、自分の書き込みが
  // 自分の読み取り集合を変えうる形になります（#4 と同じ形）。いまの
  // `findMissingSince` は先に materialize していますが、それは実装の選択で
  // 契約ではありません。ここで受けきっておけば、どちらでも同じです
  const missing: Document[] = [];
  for await (const document of store.findMissingSince(completed)) missing.push(document);

  let tombstoned = 0;
  for (const document of missing) {
    // **「欠損に見えた」と「墓標を立てた」は別の事実です。**
    // `tombstone` は、列挙と書き込みの間に**この走査以降の**観測が入れば
    // false を返します（この走査自身の観測と、後から始まった走査の観測の
    // 両方。開始順で見ます）。その分は `document_tombstoned` に残らないので、
    // ここで書かないと「欠損として数えられたが墓標にならなかった1件」が
    // 痕跡ごと消えます
    await store.appendObservation({
      kind: "document_missing",
      documentId: document.documentId,
      scanId: completed.scanId,
      detail: { stableKey: document.stableKey },
    });
    if (await store.tombstone(completed, document.documentId)) tombstoned += 1;
  }

  // **最後の検査点。** ここまで来て初めて「この走査は削除まで終わった」。
  // 先に印を付けると、途中で落ちた反映が終わったことになります
  await store.markDeletionApplied(completed);

  return { missingCount: missing.length, tombstonedCount: tombstoned };
}

/**
 * 前回の走査が残した未反映の削除を、**新しい走査を始める前に**片付ける（C1）。
 *
 * 前でなければならない理由: 新しい走査の `finishScan` は「今回見なかった
 * active 文書」を数えて欠損率を測ります。先に反映しておけば、既に消えた文書は
 * `active` でなくなっているので分子から外れます。後に回すと、同じ欠損を
 * 二度数えた比率で弁が閉じ、**閉じたこと自体が反映を妨げます**（それが C1）。
 *
 * **閾値は下げません。承認もしません。** 門は通常経路と同じ
 * `promoteToCompleted` です。前回の走査は既にその門を通っており、
 * ここでやっているのは中断した仕事の続きであって、新しい判断ではありません。
 *
 * 門が `null` を返したら、**黙って捨てずに報告します。** 反映できない
 * `pending` が残っていることは、次の走査の結果を読むうえで必要な事実です。
 */
async function resumePendingDeletion(
  store: LineageStore,
  sourceId: SourceId,
): Promise<ResumedDeletion | undefined> {
  const scanId = await store.findPendingDeletion(sourceId);
  if (scanId === null) return undefined;

  const completed = await store.promoteToCompleted(scanId);
  if (completed === null) return { scanId, applied: false, missingCount: 0, tombstonedCount: 0 };

  const result = await applyDeletions(store, completed);
  return { scanId, applied: true, ...result };
}
