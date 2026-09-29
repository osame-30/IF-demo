/**
 * ============================================================================
 *  Document Ingestion Framework — Core Domain Types (v0.2)
 * ============================================================================
 *
 *  v0.1 → v0.2 の改訂理由:
 *    敵対レビューで30シナリオの攻撃を受け、6つの根本原因に集約した。
 *      1. 走査に排他と権限モデルがない
 *      2. 「行が存在する」を完了の証拠にしている
 *      3. blob書き込みが原子的でなく exists() が嘘をつく
 *      4. キー導出の入力が正規化されていない
 *      5. リースと時刻の権威が分散している
 *      6. 「観測したがversion化しない」を表す型がない
 *
 *    derivationKey の式そのものは無傷。変えたのは入力の正規化。
 *
 *  絶対ルール（v0.1から不変）:
 *    1. 原本のバイト列は決して書き換えない
 *    2. すべての派生物は derivationKey 経由で入力まで逆引きできる
 *    3. 同じ入力 + 同じ processor + 同じ config → 同じ ID
 *    4. ACL は DocumentVersion に入れない
 *
 *  v0.2 で追加された絶対ルール:
 *    5. 「存在する」は「正しい」の証拠にならない
 *    6. 削除判定は completed 走査からしか行えない（型で強制する）
 *    7. 時刻の権威は1つ。比較に使う時刻は必ずストアが付与する
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// 1. 識別子
// ----------------------------------------------------------------------------

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type DocumentId = Brand<string, "DocumentId">;
export type VersionId = Brand<string, "VersionId">;
export type DerivationKey = Brand<string, "DerivationKey">;
export type ArtifactId = Brand<string, "ArtifactId">;
export type RunId = Brand<string, "RunId">;
export type ScanId = Brand<string, "ScanId">;
export type SourceId = Brand<string, "SourceId">;
export type ContentHash = Brand<string, "ContentHash">;
export type BlobKey = Brand<string, "BlobKey">;

/** ワーカーの識別子。リースの所有権判定に使う */
export type WorkerId = Brand<string, "WorkerId">;

/**
 * 証拠のブランド。**識別子のブランドとは別の目印を使います。**
 *
 * 識別子のブランドは「この文字列は何の名前か」を言い、
 * 証拠のブランドは「この値はどうやって手に入れたか」を言います。
 * 同じ目印を使うと `ContentHash` と `VerifiedContentHash` が
 * 交換可能になり、区別したかったことが消えます。
 */
declare const evidence: unique symbol;
type Attested<T, E extends string> = T & { readonly [evidence]: E };

/**
 * **バイト列を読み切って計算されたハッシュ。**
 *
 * 呼び出し側が宣言した `ContentHash` と型で区別します。
 * 鋳造元は `src/domain/evidence.ts` の1本だけで、そこ以外での
 * `as VerifiedContentHash` は AC-EVD-01 が落とします。
 *
 * **主張の範囲を正確に:** この型が言うのは
 * 「この値は、ある**バイト列を最後まで読んだ**関数が計算した」だけです。
 * そのバイト列が blob store に永続しているかどうかは言いません。
 * 広く読むと `exists()` の再来になります（AGENTS.md 3.7）。
 */
export type VerifiedContentHash = Attested<ContentHash, "FullRead">;

/**
 * **読了の証拠を持つ者が、永続を主張した時刻。**
 *
 * 攻撃 #8 / #21 への対処である `blobVerifiedAt` は、以前ただの `EpochMs` でした。
 * 任意の数値を書けるので、**時刻の姿をした `exists()`** です。
 * この型は `VerifiedContentHash` を持たなければ作れません。
 *
 * **ここでも主張は縮んでいます。** 永続そのもの（fsync が返ったこと）は
 * 型では確かめられません。確かめているのは「主張した者が `VerifiedContentHash` を
 * **1つ**持っていたこと」までです。**どのバイト列の証拠だったかは、この値に
 * 結ばれていません**（`attestPersisted` は受け取ったハッシュを捨てます。
 * 実測: 空配列の証拠1つで、別の内容の版に付く `VerifiedAt` が鋳造できます。
 * KNOWN_LIMITATIONS 11.4、S4-14）。残りは `BlobStore.put` の7手順が負う
 * 契約上の義務で、型の保証ではありません（KNOWN_LIMITATIONS 11節）。
 * 実体との一致を見るのは `HASH_MATCHES_BLOB`（`blobs` を渡した検査）だけです。
 */
export type VerifiedAt = Attested<EpochMs, "Persisted">;

/**
 * エポックミリ秒。**時刻はすべてこの型で扱う。**
 *
 * 攻撃 #14: heartbeatAt がワーカー時計、reap が呼び出し側時計、
 * ISO文字列のタイムゾーン表記が混在して辞書順比較が破綻した。
 * 時計が遅いワーカーは生きたままリースを奪われ、
 * 進んだワーカーはクラッシュ後も永久に leased のまま残る。
 *
 * 比較に使う時刻は必ずストアが付与する。ワーカーは時刻を送らない。
 */
export type EpochMs = Brand<number, "EpochMs">;

// ----------------------------------------------------------------------------
// 2. ID 導出と正規化（v0.2 で凍結）
// ----------------------------------------------------------------------------

/**
 * stableKey の正規化ポリシー。接続元ごとに**明示的に**宣言する。
 *
 * 攻撃 #6: 設定が /mnt/nas から /mnt/nas/ に変わっただけで
 *          全 documentId が変わり、全件tombstone + 全件新規になった。
 * 攻撃 #23: macOS の NFD と他ツールの NFC で、同一物理ファイルに
 *          2つの document ができた。
 *
 * 既定値を持たせない。実装者に選ばせる。
 */
export interface KeyNormalizationPolicy {
  /** Unicode 正規化形式。ファイルパスを扱う接続元では "NFC" を推奨 */
  unicodeForm: "NFC" | "NFD" | "none";
  /** 大文字小文字を畳むか。Windows / macOS の既定FSでは true */
  caseFold: boolean;
  /** パス区切りの正規化 */
  pathSeparator: "posix" | "as-is";
  /** 先頭・末尾のスラッシュを除去するか */
  trimSlashes: boolean;
}

export interface IdDerivation {
  /**
   * documentId = sha256("doc:" + F(sourceId) + F(normalize(stableKey, policy)))
   *
   * **F は長さ前置。区切り文字は使わない。** F(s) = <s の UTF-8 バイト長の10進> + ":" + s
   * 先頭のドメインタグ "doc:" は固定リテラルなので長さ前置しない。
   *
   * normalize は KeyNormalizationPolicy に従う純関数。
   * ポリシーが変わると全 documentId が変わるため、
   * ポリシー自体を SourceDescriptor に固定し、変更は migration 扱いとする。
   */
  documentId(sourceId: SourceId, stableKey: string, policy: KeyNormalizationPolicy): DocumentId;

  /** versionId = sha256("ver:" + F(documentId) + F(contentHash))。F は上と同じ */
  versionId(documentId: DocumentId, contentHash: ContentHash): VersionId;

  /**
   * derivationKey = sha256(
   *   "der:" + F(processorName) + F(processorVersion) + F(configHash) +
   *   <sortedInputIds の要素数の10進> + ":" + sortedInputIds.map(F).join("")
   * )
   *
   * 場の構成（何を何の順で入れるか）は v0.1 から変更なし。
   * 変わったのは configHash の作り方（下記 canonicalConfigHash）と、
   * **符号化を区切り文字連結から長さ前置に変えたこと**。
   * 後者は可変長フィールドの境界が値によって動く問題への対処。
   */
  derivationKey(input: DerivationInput): DerivationKey;

  /** artifactId = sha256("art:" + F(key) + F(String(ordinal)))。ordinal は10進、ゼロ埋めなし */
  artifactId(key: DerivationKey, ordinal: number): ArtifactId;

  /**
   * 設定オブジェクトの正規化ハッシュ。
   *
   * 攻撃 #22: キー順ソートはしていても、1.0 と 1、undefined とキー欠落、
   *          Unicodeエスケープ、浮動小数の表現が環境で違い、
   *          同じ設定から違う derivationKey が出て毎回全再計算になった。
   *
   * 規則（凍結。変更は pipelineVersion の更新を伴う）:
   *   - キーは UTF-8 バイト列の昇順でソート
   *   - 値が undefined のキーは存在しないものとして扱う（null とは区別する）
   *   - 数値は整数のみ許可。浮動小数は例外を投げる
   *   - 文字列は NFC 正規化。非ASCIIはエスケープせず生の UTF-8 で出力
   *   - 配列の順序は意味を持つ（ソートしない）
   *   - 出力に空白を含めない
   *
   * この関数には固定値テストベクタを必ず持たせる。
   * 既知の設定 → 既知のハッシュ が全環境で一致することを CI で検証する。
   */
  canonicalConfigHash(config: unknown): string;
}

export interface DerivationInput {
  processorName: string;
  processorVersion: string;
  configHash: string;
  inputIds: ReadonlyArray<VersionId | ArtifactId>;
}

// ----------------------------------------------------------------------------
// 3. 接続元
// ----------------------------------------------------------------------------

export interface SourceDescriptor {
  sourceId: SourceId;
  kind: string;
  configHash: string;
  displayName: string;
  /**
   * v0.2 追加。documentId の導出結果を決定づけるため、後から変更できない。
   *
   * **v0.1 では宣言にすぎません。** documentId を実際に決めているのは
   * `source` 行の4列（`key_*`）で、ストアはそこからしか読みません。
   * この欄と行の一致は誰も検査せず、行を作る API も `LineageStore` にありません
   * （実測: `src/**` でこの欄を読む実装は0件。KNOWN_LIMITATIONS 18節、S4-15）。
   * 権威は行にあります。ここに書いた値が行と食い違っても、何も鳴りません。
   */
  keyNormalization: KeyNormalizationPolicy;
}

export interface SourceEntry {
  stableKey: string;
  sizeBytes: number;
  /**
   * 接続元が報告する更新時刻。**参考値**。
   *
   * 攻撃 #19: バックアップ復元で modifiedAt が既存より古くなったが内容は別。
   *          「報告時刻が古い → スキップ」と判断すると変更が永久に取り込まれない。
   *
   * この値を単独で「hash取得をスキップする根拠」にしてはいけない。
   */
  modifiedAt?: EpochMs;
  /** 弱い指紋（etag / revisionId / mtime+size）。#18 の注意を参照 */
  quickFingerprint?: string;
  mimeTypeHint?: string;
}

// ----------------------------------------------------------------------------
// 4. 走査（v0.2 で大幅に強化）
// ----------------------------------------------------------------------------

export type ScanStatus =
  | "running"
  | "completed"
  | "aborted_safety"
  | "failed";

/**
 * 走査の1回分。
 *
 * v0.1 からの変更点:
 *   - distinctCount を追加（#27: 重複列挙が基準値を膨らませる）
 *   - previousCompletedScanId を明示（#3: failed走査が基準値を汚染する）
 *   - missingRatioThreshold を追加（#5: 件数一致は安全の証明にならない）
 *   - writeFailureCount を追加（#16: 1件の書き込み失敗が誤tombstoneを生む）
 *   - approvedByOperator を追加（#28: 承認の記録場所がなく閾値が無効化される）
 */
export interface ScanRun {
  scanId: ScanId;
  sourceId: SourceId;
  startedAt: EpochMs;
  finishedAt?: EpochMs;
  status: ScanStatus;

  /** 列挙された総件数（重複を含む） */
  enumeratedCount: number;
  /**
   * stableKey の重複を除いた件数。**安全弁はこちらだけを見る。**
   *
   * 攻撃 #27: bindマウントで同じキーが2回列挙され件数が2倍になった。
   *          次回の正常走査が前回比50%で誤停止し、逆に重複が消える
   *          タイミングでは真の欠損が相殺されて通過した。
   */
  distinctCount: number;

  /**
   * 基準値の出所。**completed の走査からのみ採用する。**
   *
   * 攻撃 #3: マウント半死で120件しか取れず failed。次の走査が
   *          その120件を基準にして 110/120 = 0.92 で弁を通過し、
   *          9890件を tombstone にした。
   */
  previousCompletedScanId?: ScanId;
  previousDistinctCount: number;

  /**
   * 例 9000 = 0.90: 前回の90%を下回ったら停止。
   *
   * ベーシスポイントの整数で持つ。SQLite の REAL は8バイトだが
   * PostgreSQL の REAL は4バイトで、境界そのものが判断基準になる場所で
   * 移植先だけ結果が変わりうるため。比較は整数の交差積で行い、除算しない
   * （0除算と NaN が構造的に消える）。
   */
  countRatioThresholdBp: number;
  /**
   * 例 1000 = 0.10: tombstone候補が前回 distinct 数の10%を超えたら停止。
   *
   * 攻撃 #5: 同件数の別ボリュームがマウントされ、件数閾値は通過したまま
   *          全件tombstone + 全件新規になった。件数一致は安全の証明にならない。
   */
  missingRatioThresholdBp: number;

  /**
   * 観測の記録に失敗した件数。
   *
   * 攻撃 #16: SQLITE_BUSY を catch してログだけ出し走査を続行した結果、
   *          その document の lastSeen が更新されず tombstone された。
   *
   * **1件でも 0 でなければ削除判定フェーズに進めない。**
   */
  writeFailureCount: number;

  /**
   * 運用者による1回限りの承認。
   *
   * 攻撃 #28: 正当に空になった source で弁が毎回発火し、
   *          運用者が閾値を0にして恒久的に無効化した。
   *
   * 承認はこの走査にのみ効き、閾値そのものは変更されない。
   * maxMissingCount は運用者が許した欠損件数の上限。確定時の再計数で超えれば停止する。
   */
  approvedByOperator?: { approvedAt: EpochMs; note: string; maxMissingCount: number };

  /**
   * 完了走査の全順序。completed へ遷移する同一トランザクション内で採番する。
   *
   * finishedAt だけでは同値が起こる。しかも Clock を注入している以上、
   * テストでは同値が例外ではなく既定になる（固定時計で2走査を完了させれば必ず同値）。
   * isLatestCompleted の判定はこの列だけで行う。
   */
  completionSeq?: number;

  abortReason?: string;

  /**
   * **削除反映の状態。`completed` の走査だけが持つ（C1）。**
   *
   * `completed` は「列挙と安全弁を通った」であって「削除を反映した」では
   * ありません。`finishScan` の後、削除記録と `tombstone` は別々の書き込みとして
   * 起きるので、その間の失敗で**基準値だけが進み、削除は未反映**という状態が
   * 残ります。次の走査はその基準値で欠損率を測るため、入力を静止させても
   * 同じ理由で `aborted_safety` になり続けます（実測。20件中2件削除、
   * 閾値 9000/1000 で 2/18 ≒ 11.1% > 10%）。
   *
   * **`completed` かつ `pending` の走査は、次の走査の前に反映を再開します。**
   * 再開の門は通常経路と同じ `promoteToCompleted` で、閾値は下げません。
   */
  deletionState?: DeletionState;
}

/**
 * **削除判定フェーズに渡せるのはこの型だけ。**
 *
 * 攻撃 #4: AsyncIterable で列挙しながら逐次 tombstone を書く実装では、
 *          enumeratedCount が確定する前に大量の tombstone が書かれ、
 *          その後で弁が発火して aborted_safety になった。
 * 攻撃 #1: 走査AとBが重なり、Bが全件 lastSeen を更新した後に
 *          遅れてAが完了して findMissingSince(A) を呼び、全件が欠損に見えた。
 *
 * 型は順序と権限の**入口**を絞りますが、門そのものではありません。
 * TypeScript の構造的部分型では、`promoteToCompleted` を通らなくても
 * 口の形さえ合えばこの型の値を組めます（`as` も要りません。`tsc --noEmit` が
 * exit 0 になることを実測済み）。だから `findMissingSince` と `tombstone` は
 * 渡された値ではなく `scan_run` の行を読み直して判定します。
 * ScanId を裸で渡せる API を作らないこと。
 */
export type DeletionState =
  /** 弁は通ったが、削除の反映がまだ終わっていない */
  | "pending"
  /** この走査の削除反映が最後まで終わった */
  | "applied"
  /** 後続の完了走査が反映を済ませたので、この走査の分は不要 */
  | "superseded";

export interface CompletedScanRun extends ScanRun {
  status: "completed";
  finishedAt: EpochMs;
  writeFailureCount: 0;
  /**
   * この走査より後に**完了**した走査が存在しないこと。
   *
   * **v0.1 で狭めました。** 以前は「後に開始・完了した走査が存在しないこと」と
   * 書いていましたが、それは値の性質としては成立しません。`promoteToCompleted`
   * が返った次の瞬間に別の走査が始まれば偽になり、しかも `beginScan` は
   * それを拒みません（前の走査は既に completed なので
   * `idx_one_running_scan` に掛からない）。**契約に実装を合わせたのではなく、
   * 成立しない契約を直しました。**
   *
   * 「後に開始した走査」への防御はこの欄ではなく削除判定の側にあります:
   * **後に開始した走査が見た文書は、この走査の欠損ではありません。**
   * `findMissingSince` と `tombstone` が走査の開始順（`scan_run.start_seq`）で
   * これを判定します。開始順は status に依らず全走査に付きます。
   * `aborted_safety` や `failed` で終わる走査も、観測の時点では
   * `last_seen_scan_id` を動かしているためです。
   */
  isLatestCompleted: true;
}

// ----------------------------------------------------------------------------
// 5. Document / DocumentVersion
// ----------------------------------------------------------------------------

export type DocumentState =
  | "active"
  | "tombstoned"
  /** 人間の確認待ち。検索対象から外すが削除もしない */
  | "quarantined";

export interface Document {
  documentId: DocumentId;
  sourceId: SourceId;
  stableKey: string;
  state: DocumentState;
  activeVersionId?: VersionId;
  firstSeenAt: EpochMs;
  lastSeenAt: EpochMs;
  lastSeenScanId: ScanId;

  /**
   * v0.2 追加。hash取得をスキップする判断に使う弱い指紋。
   *
   * 攻撃 #18: 型に置き場所がないため、実装者は
   *          (a) DocumentVersion に足して UPDATE する → immutable違反
   *          (b) 毎回全件 fetch + hash → 大規模で終わらない
   *          のどちらかを選ばざるを得なかった。
   *
   * Document は可変なのでここが正しい置き場所。
   * ただし cp -p や rsync は mtime と size を保ったまま内容を変えるため、
   * 「同fingerprint = 同内容」とは限らない。定期的な全hash検証を別途持つ。
   */
  lastFingerprint?: string;
  lastFingerprintAt?: EpochMs;

  /**
   * 攻撃 #25: tombstone された文書が復元されると、state は active に戻るのに
   *          tombstonedAt が残り内部矛盾になった。
   *          復活時は必ず null に戻し、関連する confirmed_rename を
   *          needs_recheck に差し戻す。
   */
  tombstonedAt?: EpochMs;
}

/**
 * 内容スナップショット。完全に immutable。
 * この型に対する UPDATE 文は1本も存在してはいけない。
 */
export interface DocumentVersion {
  versionId: VersionId;
  documentId: DocumentId;

  /** 生バイト列の sha256。正規化後テキストではない */
  contentHash: ContentHash;
  sizeBytes: number;
  blobKey: BlobKey;

  /**
   * v0.2 追加。blob の実バイト列が contentHash と一致することを
   * 確認した時刻。**この値がない version 行は書いてはいけない。**
   *
   * 攻撃 #8: 一時ファイルを hash名に rename した後 fsync 前に電源断。
   *          hash名のファイルが0バイトのまま残り、再実行時に
   *          exists() が true を返して put がスキップされた。
   * 攻撃 #21: 10GB のストリーミング中にディスクフル。
   *          「hashは計算済み」として version 行が書かれた。
   */
  blobVerifiedAt: EpochMs;

  mimeType: string;
  sourceModifiedAt?: EpochMs;
  ingestedAt: EpochMs;
  discoveredByScanId: ScanId;
  pipelineVersion: string;
}

/**
 * 呼び出し側が組み立てられる DocumentVersion。
 *
 * `versionId` と `ingestedAt` を持ちません。
 * 前者はストアが `documentId` と `contentHash` から導出し、
 * 後者はストアの時計が刻みます。
 *
 * `blobVerifiedAt` と `sourceModifiedAt` は**残します**。
 * どちらも「判定に使わない証拠値」だからです。前者は BlobStore が
 * 検証を行った事実の記録（#8, #21）、後者は接続元が報告した参考値（#19）で、
 * どちらも比較や順序判断には使いません。
 * 「時刻の権威は1つ」は比較・判定に使う時刻の規則です。
 */
export interface VersionDraft {
  documentId: DocumentId;
  /**
   * 生バイト列の sha256。正規化後テキストではない（AGENTS.md 3.1）。
   *
   * **証拠型です。** 宣言した値ではなく、バイト列を読み切った関数の戻り値だけが
   * 入ります。ストアは版の同一性をこの値から導出する（`versionId`）ので、
   * ここが宣言値だと版の同一性そのものが宣言値になります。
   */
  contentHash: VerifiedContentHash;
  sizeBytes: number;
  blobKey: BlobKey;
  /**
   * BlobStore の PutResult.verifiedAt。この値なしに version 行は書けない。
   *
   * **`contentHash` との対応は運びません。** `VerifiedAt` はどのバイト列の
   * 証拠かを持たないので、ストアは「この時刻の証拠がこの hash のものか」を
   * 検査できず、検査しません。実行時に見るのは正の整数であることだけです
   * （KNOWN_LIMITATIONS 11.4、S4-14）。
   */
  blobVerifiedAt: VerifiedAt;
  mimeType: string;
  sourceModifiedAt?: EpochMs;
  discoveredByScanId: ScanId;
  pipelineVersion: string;
}

/**
 * ACL は独立した次元。
 *
 * v0.2 追加: state フィールド。
 *
 * 攻撃 #29: fetchAcl がタイムアウトしたとき principals=[] で upsert され、
 *          空を「制限なし」と読む下流には漏洩、「全拒否」と読む下流には
 *          全断が起きた。行が存在しないことの意味も未定義だった。
 *
 * 取得失敗は既存 ACL を上書きしない。未取得は明示的に "unknown"。
 */
export interface AccessControl {
  documentId: DocumentId;
  tenantId: string;
  state: "synced" | "unknown";
  /** state が "synced" のときのみ意味を持つ */
  principals: ReadonlyArray<string>;
  classification?: string;
  aclHash: string;
  syncedAt?: EpochMs;
  lastAttemptAt?: EpochMs;
  lastError?: string;
}

export interface RenameCandidate {
  disappearedDocumentId: DocumentId;
  appearedDocumentId: DocumentId;
  contentHash: ContentHash;
  observedAt: EpochMs;
  /**
   * 攻撃 #25: confirmed_rename の後に元文書が復元されると、
   *          確定済みの系譜判断が事後的に誤りになる。
   */
  resolution: "unresolved" | "confirmed_rename" | "rejected" | "needs_recheck";
}

// ----------------------------------------------------------------------------
// 6. Derivation / Artifact
// ----------------------------------------------------------------------------

/**
 * v0.2 の最重要変更: artifactCount と outputsHash を追加した。
 *
 * 攻撃 #9: Derivation を先に書いてクラッシュすると、再実行時に
 *          insertDerivationIfAbsent が created:false を返し
 *          「もう済んでいる」と判断され Artifact が永久に書かれない。
 * 攻撃 #10: 1回目が10個中6個書いてクラッシュ、2回目が9個生成すると、
 *          ordinal 9 が1回目の残骸として残り和集合になる。
 * 攻撃 #11: 依存ライブラリ版の違う2台が同じキーを処理すると、
 *          artifactId は同じで contentHash が違う。IfAbsent が
 *          2つ目を無言でスキップし先着が正になる。
 *
 * → Derivation の存在を「処理済み」の根拠にしない。
 *   完了の証拠は「Derivation + 全Artifact + run完了が同一トランザクションで
 *   成立していること」。個数とハッシュがそれを機械検証可能にする。
 */
export interface Derivation {
  derivationKey: DerivationKey;
  processorName: string;
  processorVersion: string;
  configHash: string;
  inputIds: ReadonlyArray<string>;
  rootVersionId: VersionId;
  documentId: DocumentId;
  createdAt: EpochMs;

  /** 生成された Artifact の個数。実際の行数と一致しなければ不整合 */
  artifactCount: number;
  /**
   * sha256(artifactId + ":" + contentHash を ordinal 順に連結)
   * 再実行でこの値が変われば決定性が壊れたということ。握りつぶさず失敗にする。
   */
  outputsHash: string;
}

/**
 * 呼び出し側が組み立てられる Derivation。
 *
 * `derivationKey` / `artifactCount` / `outputsHash` / `createdAt` を持ちません。
 * 前3つは入力から決まる値なので、ストアが導出します。呼び出し側が渡せると、
 * 「宣言した個数」と「実際の個数」が食い違う余地が生まれます — それはまさに
 * #9 が突いた穴です。
 *
 * **`rootVersionId` と `documentId` も持ちません（2026-09-10）。**
 * 原本を指定する口は `claimRun` に1つだけあります。commit 側にもう1つあると、
 * 同じ事実を2点で受け取ることになり、**確定の時点で差し替えられます。**
 * 実測: 文書 A の run で「原本は文書 B の版」の派生・artifact が確定でき、
 * `LINEAGE_COMPLETE` の `artifact_document_disagrees_with_version` に触れる行が
 * 入りました。鍵の材料に `rootVersionId` は入っていないので、鍵の照合では
 * 止まりません。
 *
 * いま `commitDerivation` は、**検証した run の原本**を使い、
 * **その原本から文書を導出します**（同一トランザクション内。9節 軸1）。
 * 受け取らないので、食い違いようがありません。**`derivationKey` の式は
 * 変わりません**——`rootVersionId` は元から鍵の材料ではないからです。
 */
export interface DerivationDraft {
  processorName: string;
  processorVersion: string;
  configHash: string;
  inputIds: ReadonlyArray<VersionId | ArtifactId>;
}

/**
 * 呼び出し側が組み立てられる Artifact。**置き場所で枝が分かれます。**
 *
 * `artifactId` は derivationKey と ordinal から導出されるのでストアが決めます。
 * `derivationKey` / `documentId` / `rootVersionId` は Derivation から継がれます。
 *
 * 枝を分けたのは、**枝ごとに払える述語が違う**からです（AGENTS.md 9節 軸4）。
 * 1つの型に `inlineContent?` と `contentHash` を同居させると、
 * 「本文はあるのに、ハッシュは別のバイト列のもの」という組が**書けてしまいます**。
 * schema の `CHECK ((inline_content IS NULL) <> (blob_key IS NULL))` が
 * 排他を守っているのは行の側だけで、型の側は守っていませんでした。
 *
 * | 枝 | 呼び出し側が渡すもの | ハッシュ・サイズ |
 * |---|---|---|
 * | `inline` | 本文・種類・ordinal | **ストアが本文から導出** |
 * | `blob` | blobKey・検証済みハッシュ・サイズ・種類・ordinal | 受け取る（軸4） |
 */
export type ArtifactDraft = InlineArtifactDraft | BlobArtifactDraft;

/** 2つの枝に共通の、置き場所と無関係な部分 */
interface ArtifactDraftBase {
  ordinal: number;
  type: ArtifactType;
}

/**
 * 本文を行の中に持つ artifact。
 *
 * **ハッシュもサイズも受け取りません。** 本文はここにあるので、
 * ストアが `content` の UTF-8 バイト列から導出します。
 * 保存する値も `outputsHash` に入る値も、その導出値です。
 *
 * 実測（2026-09-10）: 以前はここも `contentHash` を受け取っていました。
 * 本文 `"WRONG"` に `attestContentHash(Buffer.from("RIGHT"))` を付けた artifact が
 * 確定でき、`sizeBytes` は `99999` でも通り、**15項目すべてが緑**でした。
 * 証拠型は「ある実在のバイト列を読み切った」ことしか運ばず、*どの*バイト列かを
 * 運ばないからです（`VerifiedAt` と同じ形。KNOWN_LIMITATIONS 11.4/11.5）。
 * 当時は監査も届きませんでした——`HASH_MATCHES_BLOB` は `blob_key IS NOT NULL` の
 * 行しか見ていませんでした。いまは inline の独立した検算を含みます
 * （既に保存された行を見つけられるのはそちらだけです）。
 *
 * **本文は正規化しません。** NFC 化や改行の畳み込みを入れると、保存された本文と
 * ハッシュの原像が別物になり、独立した検算（監査器）が偽の不一致を報告します。
 */
export interface InlineArtifactDraft extends ArtifactDraftBase {
  kind: "inline";
  content: string;
}

/**
 * 本文を blob store に持つ artifact。
 *
 * こちらは**受け取ります。** バイト列は既に別の場所にあり、
 * 確定時に読み直す述語は払えません（AGENTS.md 9節 軸4）。
 * 費用は値が作られる時点に移してあります（`VerifiedContentHash`）。
 *
 * **証拠がこの artifact のバイト列のものであることは、依然として型の外です。**
 * 実体との一致を見るのは `HASH_MATCHES_BLOB` だけで、
 * それは `BlobVerifier` を渡したときにしか走りません（KNOWN_LIMITATIONS 11.5）。
 */
export interface BlobArtifactDraft extends ArtifactDraftBase {
  kind: "blob";
  blobKey: BlobKey;
  contentHash: VerifiedContentHash;
  sizeBytes: number;
}

/**
 * 呼び出し側が組み立てられる AccessControl。
 *
 * `syncedAt` と `lastAttemptAt` はストアの時計が刻みます。
 * 取得失敗を「同期できた時刻」として記録させないためです（#29）。
 */
export interface AclDraft {
  documentId: DocumentId;
  tenantId: string;
  state: "synced" | "unknown";
  /** state が "synced" のときのみ意味を持つ。unknown では空でなければならない */
  principals: ReadonlyArray<string>;
  classification?: string;
  aclHash: string;
  lastError?: string;
}

export type ArtifactType =
  | "parsed_document"
  | "normalized_document"
  | "chunk"
  | "metadata"
  | "fact"
  | "summary"
  | "embedding_record"
  | "quality_report";

export interface Artifact {
  artifactId: ArtifactId;
  derivationKey: DerivationKey;
  ordinal: number;

  documentId: DocumentId;
  rootVersionId: VersionId;

  type: ArtifactType;
  inlineContent?: string;
  blobKey?: BlobKey;
  contentHash: ContentHash;
  sizeBytes: number;
  createdAt: EpochMs;
}

// ----------------------------------------------------------------------------
// 7. ProcessingRun
// ----------------------------------------------------------------------------

export type RunStatus =
  | "pending"
  | "leased"
  | "succeeded"
  | "failed"
  | "abandoned";

export interface ProcessingRun {
  runId: RunId;
  derivationKey: DerivationKey;
  documentId: DocumentId;
  rootVersionId: VersionId;

  status: RunStatus;
  attempt: number;

  workerId?: WorkerId;
  /** すべてストアが付与する。ワーカーは時刻を送らない（#14） */
  startedAt?: EpochMs;
  heartbeatAt?: EpochMs;
  leaseExpiresAt?: EpochMs;
  finishedAt?: EpochMs;

  errorKind?: string;
  errorMessage?: string;
  permanent?: boolean;
}

// ----------------------------------------------------------------------------
// 8. Observation
// ----------------------------------------------------------------------------

export type ObservationKind =
  | "document_discovered"
  | "version_created"
  | "version_reverted"
  | "document_missing"
  | "document_tombstoned"
  | "document_revived"
  | "scan_aborted_safety"
  | "scan_approved_by_operator"
  | "rename_candidate_detected"
  | "rename_needs_recheck"
  | "acl_changed"
  | "acl_fetch_failed"
  | "run_failed"
  | "quarantined"
  // --- v0.2 追加: 「観測したが version 化しなかった」を表す ---
  /**
   * 列挙されたが版にできなかった（#17）。tombstone にしてはいけない。
   *
   * **「接続元が読めなかった」より広い。** 保存先（`BlobStore.put`）の失敗も、
   * 駆動部自身の例外も、`IngestOutcome.unreadable` を通ってここに来ます。
   * detail の `errorKind` で種類は追えますが、**出所（接続元か保存先か）は
   * 区別されません**（KNOWN_LIMITATIONS 17節、S4-10）。
   */
  | "document_unreadable"
  /**
   * **列挙はできたが、鍵として運べなかった。**
   *
   * `document_unreadable` は「document になった1件が読めなかった」です。
   * こちらは document にすらなっていません。`documentId` を持たないのは
   * そのためです。detail に `SkippedEntry` がそのまま入ります。
   *
   * `unlistable_subtree` はここに来ません。あちらは
   * `recordUnlistableSubtree` を通り、**安全弁を閉じます。**
   * 「そこに在るが鍵にできない」と「そこに何件在ったか分からない」は
   * 別の話で、後者だけが件数の減少を正常と読む根拠を奪います。
   */
  | "entry_skipped"
  /**
   * 部分木そのものを**一覧できなかった**（#17 の親版）。
   *
   * `document_unreadable` はファイル1件の話です。ディレクトリを開けないと、
   * その下に何件あったのかが分かりません。**「見えなかった」を「無くなった」と
   * 読むと、消えていない文書が tombstone になります。**
   */
  | "subtree_unlistable"
  /** 列挙時 size と読み取りバイト数が不一致（#7, #20）。version 化しない */
  | "size_mismatch_rejected"
  /** 同 fingerprint で別内容が観測された（#18） */
  | "fingerprint_collision"
  /**
   * **同じ走査の中で、別の生の鍵が同じ documentId に潰れた。**
   *
   * 正規化は単射ではありません（#23 の防御がそのまま作る形）。NFD と NFC、
   * 大小だけが違う名前、POSIX の `a` + バックスラッシュ + `b.txt` と
   * ディレクトリ `a` の中の `b.txt` は、ポリシー次第で同じ documentId に
   * なります。**どちらが勝つかは列挙順で決まります。**
   *
   * どちらを正とするかはシステムには言えません。記録だけします。
   */
  | "stable_key_collision"
  /** 走査対象から外れた sourceId の active 文書を検出（#24） */
  | "orphaned_source_detected"
  /** リース失効後に復活したワーカーの操作を拒否（#13） */
  | "stale_worker_rejected"
  /** 再実行で outputsHash が変わった（#10, #11） */
  | "derivation_output_divergence"
  /** blob 参照整合性の検証に失敗（#30） */
  | "blob_reference_broken";

/**
 * 追記専用の監査記録。
 *
 * **順序は `observationSeq`、同一性は `observationId`。**
 *
 * `observationId` は事象そのものの識別子なので UUIDv4 で採番され、
 * 構造的に整列できません（それが狙いです）。`occurredAt` も順序には使えません。
 * 同一トランザクション内で書かれた複数の観測は必ず同値になりますし、
 * Clock を注入している以上、固定時計のテストでは同値が例外ではなく既定です。
 *
 * `scan_run.completionSeq` を入れたのと同じ理由がここにも掛かります。
 * 分岐検出（#10, #11）と失効ワーカーの拒否（#13）の前後関係は、
 * この列でしか復元できません。
 */
export interface Observation {
  /** 追記順の全順序。**同一性の判定には使わない** */
  observationSeq: number;
  /** 事象の同一性。**比較や整列には使わない**（AGENTS.md 3.2） */
  observationId: string;
  kind: ObservationKind;
  documentId?: DocumentId;
  versionId?: VersionId;
  scanId?: ScanId;
  runId?: RunId;
  occurredAt: EpochMs;
  detail: Readonly<Record<string, unknown>>;
}

/**
 * 1件の列挙対象を取り込もうとした結果。
 *
 * **3つの枝はすべて「観測された」を意味します。** 区別しているのは
 * 「存在したか」ではなく「版になりうるか」です。
 *
 * v0.2 の根本原因6「『観測したがversion化しない』を表す型がない」への答えが
 * この判別可能ユニオンです。型がなかったため、読めなかったファイルを
 * 「見えなかった」として扱う実装しか書けませんでした（#17）。
 * この形なら、非 content の枝を記録する経路が lastSeen を更新する経路と
 * 同一になるので、「読めなかった → 欠損 → tombstone」が書けません。
 */
export type IngestOutcome =
  /** バイト列が読めて hash が取れた。版になりうる唯一の枝 */
  | { kind: "content"; contentHash: ContentHash; sizeBytes: number }
  /**
   * 列挙できたが版にできなかった（#17）。version 化しないが tombstone でもない。
   *
   * **読み取り権限が無い場合だけではありません。** 駆動部は `size_mismatch` と
   * `blob_divergence` 以外の**あらゆる**例外をここへ畳みます。接続元のストリームが
   * 途中で落ちた場合も、保存先（`BlobStore.put`）が `ENOSPC` / `ENOTDIR` で
   * 落ちた場合も、駆動部自身の `TypeError` も同じ枝です。読み取りは `put` の
   * 中で起きる（`fetch` はストリームを返すだけ）ので、例外の発生場所では
   * 出所を分けられません。`errorKind` に種類は残りますが、
   * **「接続元が壊れた」と「保存先が壊れた」は監査から区別できません**
   * （KNOWN_LIMITATIONS 17節、S4-10）。
   */
  | { kind: "unreadable"; errorKind: string }
  /**
   * 列挙時 size と読み取りバイト数が不一致（#7, #20）。
   * 0 は正当な値であり、値なしと区別する。
   */
  | { kind: "size_mismatch"; declaredSizeBytes: number; actualSizeBytes: number };

/**
 * 走査が観測した1件。
 *
 * `documentId` を持ちません。導出はストアが `KeyNormalizationPolicy` に従って
 * 行います。呼び出し側が渡せると正規化を迂回でき、#6 と #23 が復活します。
 *
 * `state` と `activeVersionId` も持ちません。前者を渡せると観測経路から
 * tombstone を書けてしまい、後者を渡せるとポインタが「挿入結果」で決まって
 * #15 が復活します。
 */
export interface ObservedEntry {
  /** 接続元が報告した生の鍵。正規化前 */
  stableKey: string;
  /** 弱い指紋。同指紋で別 hash なら fingerprint_collision を記録する（#18） */
  quickFingerprint?: string;
  outcome: IngestOutcome;
}

export interface ObservedResult {
  /** ストアが導出した ID。呼び出し側が自分で導出しないための戻り値（#23） */
  documentId: DocumentId;
  /** この観測で document 行が新規作成されたか */
  created: boolean;
  /** tombstone から復活したか（#25） */
  revived: boolean;
}

/**
 * 呼び出し側が組み立てられる Observation。
 *
 * `observationId` と `occurredAt` を**持たない**のが本質です。
 * 事象 ID はストアが採番し、時刻はストアの時計が刻みます（#14）。
 * Omit ではなく明示的な型にしてあるのは、
 * 「時刻を渡す口が無いこと」を AST で機械検査できるようにするためです。
 */
export interface ObservationDraft {
  kind: ObservationKind;
  documentId?: DocumentId;
  versionId?: VersionId;
  scanId?: ScanId;
  runId?: RunId;
  detail: Readonly<Record<string, unknown>>;
}

// ----------------------------------------------------------------------------
// 9. Adapter インターフェース
// ----------------------------------------------------------------------------

/**
 * 列挙から落としたもの。**捨てるのではなく報告します。**
 *
 * `unlistable_subtree` は `LineageStore.recordUnlistableSubtree` へ、
 * 残りは `entry_skipped` の観測として記録するのが呼び出し側の責務です。
 *
 * **接続元の実装ではなくここに置いてあります。** 以前は local-fs の中にあり、
 * 報告先は構築時のコールバック（`onSkipped`）でした。`SourceAdapter` 型で
 * 受け取る駆動部からは**その口が見えず**、`recordUnlistableSubtree` を
 * 呼べません。呼ばれなければ安全弁は閉じず、見えなかった部分木が
 * そのまま欠損として tombstone になります。
 */
export type SkippedEntry =
  /** ディレクトリを開けなかった。この下に何件あったかは分からない */
  | { readonly kind: "unlistable_subtree"; readonly subtreeKey: string; readonly errorKind: string }
  /** 通常ファイルではない（symlink / junction / FIFO / デバイス / ソケット） */
  | { readonly kind: "not_a_regular_file"; readonly stableKey: string; readonly entryKind: string }
  /** hardlink。実体が root の外にあるかどうかは、中からは分からない */
  | { readonly kind: "hard_linked"; readonly stableKey: string; readonly linkCount: number }
  /**
   * 名前を鍵として運べない。
   *
   * `replacement_character` … 名前を UTF-8 に写せなかった
   *   （KNOWN_LIMITATIONS 14節）。**この名前では `open` もできない**
   * `separator_or_nul` … バックスラッシュか NUL。**どこでも落とします。**
   *   バックスラッシュは `normalizeStableKey` が `/` に畳むので、POSIX の
   *   `a\b.txt` がディレクトリ `a` の中の `b.txt` と同じ documentId に
   *   潰れます（S-11）
   * `reserved_character` … Windows のパス構文で構造的な意味を持つ文字
   *   （`:` と制御文字）。**POSIX では落としません。** 落とすと
   *   `log_2024-01-01T12:00:00.txt` のようなありふれた命名が
   *   恒久に取り込めなくなります
   */
  | {
      readonly kind: "unusable_name";
      readonly stableKey: string;
      readonly reason: "replacement_character" | "separator_or_nul" | "reserved_character";
    }
  /**
   * 名前が返された後、素性を確かめる前に消えた（または読めなくなった）。
   *
   * **これは走査を止める理由になりません。** 消えた1件は次の走査で
   * 欠損として扱われます。ここで例外を投げると、無関係な残り全件まで
   * 列挙されなくなります（F-1）。
   */
  | { readonly kind: "vanished_during_scan"; readonly stableKey: string; readonly errorKind: string }
  /**
   * Office が文書を開いている間だけ作る所有者ファイル（ファイル名が `~$` で始まる通常ファイル）。
   *
   * **観測に通しません。document を作らないためです。** 通すと `document_unreadable` の文書が
   * 増え、Office を閉じるたびに削除確認が出ます（2026-09-15 の実操作動画）。
   * これは「列挙に出たものは今回は墓標にしない」原則の**意図的な例外**で、規則の前に
   * 文書になった `~$` は次の走査で1回だけ欠損になります。
   *
   * 判定はファイル名の生の `~$` だけです。正規化・拡張子の条件を付けず、ディレクトリには
   * 当てません（攻撃レビュー DF-6）。偶然 `~$` で始まる本物の資料も対象外になります
   * （KNOWN_LIMITATIONS 12節 #6）。`sizeBytes` は、何を落としたかを後から確かめるための値です。
   */
  | { readonly kind: "office_temporary_file"; readonly stableKey: string; readonly sizeBytes: number };

/**
 * `enumerate` が流すもの。**見えた1件と、落とした1件を同じ流れに載せます。**
 *
 * 落としたものをコールバックで別口に出していた頃は、次の2つが同時に成り立って
 * いました。
 *
 *   - コールバックは同期で、失敗を返せない。`recordUnlistableSubtree` は
 *     `Promise` を返すので、**握りつぶす形でしか呼べません**（#16 と同じ形）
 *   - 口が `SourceAdapter` に無いので、**渡し忘れても型検査を通ります**
 *
 * 列挙の要素にすると、駆動部は `await` してよい場所で受け取ります。
 * 記録に失敗したら、そこで走査を落とせます。
 *
 * **入れ子にしてあります**（`{ kind: "entry", entry }`）。`SourceEntry` に
 * `kind` を生やすと、その値が `ObservedEntry` や `VersionDraft` まで
 * ついて回ります。判別子は「列挙のどの流れか」の話で、
 * 見えたファイルそのものの性質ではありません。
 */
export type EnumeratedItem =
  | { readonly kind: "entry"; readonly entry: SourceEntry }
  | SkippedEntry;

export interface SourceAdapter {
  readonly descriptor: SourceDescriptor;
  enumerate(): AsyncIterable<EnumeratedItem>;
  fetch(stableKey: string): Promise<ReadableStream<Uint8Array>>;
  fetchAcl?(stableKey: string): Promise<Omit<AccessControl, "documentId" | "state" | "syncedAt">>;
}

export interface PutResult {
  blobKey: BlobKey;
  /** 書き戻したバイト列を読み直して計算した値。宣言値ではない */
  contentHash: VerifiedContentHash;
  sizeBytes: number;
  /**
   * その鍵に**今回**書いたなら true、既に同じ内容があったなら false。
   *
   * `commitDerivation` の `created` と同じ役目です。呼び出し側が
   * 「初めて置いた」と「既にあった」を区別できないと、冪等な再実行と
   * 内容の食い違いが同じ見え方になります。
   */
  created: boolean;
  /** 永続化が確認された時刻。DocumentVersion.blobVerifiedAt に入る */
  verifiedAt: VerifiedAt;
}

/**
 * blob の削除の**授権**。**主張ではありません。**
 *
 * 初版は `blobKey` と一度きりの `token` を持っていました。
 * 「この token はこの鍵に対して発行された」という主張を運ぶ値です。
 * **その主張を述べられるのは発行者だけで、受け取る側の `BlobStore` には
 * その文が書けません**（AGENTS.md 9節 軸5）。
 *
 * さらに悪いことに、主張を値にすると**発行時点の世界**が実行時点まで運ばれます。
 * 値は保存でき、遅延でき、バックアップから復元でき、組み替えられます。
 * 「発行時に参照が無かった」は「実行時に参照が無い」を含意しません。
 *
 * 裁定: **grant が運ぶのは授権の範囲だけです。**
 * 「消してよいか」は削除の実行時点で、権威を持つ側が評価します
 * （`BlobDeletionJudge`）。
 *
 * この形にすると、権限の消滅（token の消費）と実体の消滅（unlink）が
 * 二段にならないので、**逆順で壊れる対がまるごと消えます** —
 * 「token を消費したが unlink に失敗した」も
 * 「unlink したが token が残った」も、書けなくなります。
 *
 * **v0.1 に発行元はありません。** `LineageStore` に発行メソッドを置いていないので、
 * `delete` は呼べません。「削除は v0.1 では実装しない」を散文ではなく
 * 型で持っている状態です（AC-BLB-04）。
 */
export interface BlobDeletionGrant {
  /** 誰に授けたか。実行時に名乗りと照合する */
  readonly grantedTo: WorkerId;
  /**
   * どの走査世代の判断に基づく授権か。
   *
   * **実行時点でこの走査がまだ最新完了走査であることを再確認します。**
   * 追い越されていたら拒否（`scan_superseded`）。論理削除（tombstone）が
   * `CompletedScanRun` を要求するのと同じ門を、物理削除にも通します。
   */
  readonly basedOn: CompletedScanRun;
  /** この授権で消してよい最大件数。無制限の授権を書けなくする */
  readonly maxDeletions: number;
  readonly grantedAt: EpochMs;
}

/** 削除を断る理由。すべて**実行時点**の評価結果 */
export type DeletionRefusal =
  /** その鍵への参照が1つでも残っている（version / artifact の両方を見る） */
  | "still_referenced"
  /** `basedOn` より後に完了した走査がある。判断の前提が古い */
  | "scan_superseded"
  /** 直近の走査が aborted_safety で終わっている。疑わしい観測の下では消さない */
  | "safety_abort_in_effect"
  /** この授権の `maxDeletions` を使い切った */
  | "grant_exhausted"
  /** 同じ鍵に対する put と競合した。遅い方を落とす */
  | "concurrent_put";

export interface DeletionVerdict {
  deletable: boolean;
  refusal?: DeletionRefusal;
}

/**
 * 削除述語の評価者。**`LineageStore` の実装が提供します。**
 *
 * `BlobStore` は系譜を知らないので、参照の有無を自分では判定できません。
 * かといって判定結果を値（token）で受け取ると、それは発行時点の世界の
 * 持ち込みになります。**関数で受け取れば、評価は実行時点に起きます。**
 *
 * 述語に必ず含めるもの:
 *
 * 1. **実行時点での参照不在。** `#allReferencesTo(blobKey)` を通ること。
 *    version 参照だけを見ると、artifact だけが参照している鍵が
 *    「参照ゼロ」に見えます。`artifact` 行は残るので `NO_ORPHAN_ARTIFACT` は
 *    緑のまま、実体だけが消えます。
 * 2. **`basedOn` がまだ最新完了走査であること。**
 * 3. **直近の走査が `aborted_safety` で終わっていないこと。**
 *    `SAFETY_ABORT_WRITES_NOTHING` は墓標の数しか数えないので、
 *    物理削除は字義上その不変条件を破らずにすり抜けます。
 *    弁の目的は「疑わしい観測の下で不可逆な操作をしない」ことなので、
 *    **論理削除と同じ世代ゲートに物理削除も従属させます。**
 *
 * **評価と unlink は同じ排他区間で行われなければなりません。** 詳細は
 * `BlobStore.delete` の契約に書いてあります。実行時再評価だけでは
 * 「評価通過後・unlink 前に同じ鍵へ put が完了する」窓が閉じません。
 */
export interface BlobDeletionJudge {
  confirmDeletable(key: BlobKey, grant: BlobDeletionGrant): Promise<DeletionVerdict>;
}

export interface BlobDeletionOutcome {
  deleted: boolean;
  refusal?: DeletionRefusal;
}

/**
 * blob への参照。**`verifyBlobReferences` が返す単位。**
 *
 * v0.4 で `{ versionId, blobKey }` から変更しました。理由が2つあります。
 *
 * - **artifact も blob を参照します。** version 参照だけを列挙すると、
 *   artifact だけが指している鍵が監査から丸ごと落ちます。
 * - **`contentHash` が無いと検証できません。** `BlobStore.verify(key, expectedHash)`
 *   は期待値を要求するのに、列挙側がそれを返していませんでした。
 *   監査の入口が、監査に必要な材料を渡していなかったということです。
 */
export type BlobReference =
  | {
      kind: "version";
      versionId: VersionId;
      blobKey: BlobKey;
      contentHash: ContentHash;
    }
  | {
      kind: "artifact";
      artifactId: ArtifactId;
      derivationKey: DerivationKey;
      blobKey: BlobKey;
      contentHash: ContentHash;
    };

/**
 * 検証つき読み取りの戻り値。**バイト列と証拠の対。**
 *
 * `completed` は**読み切ってハッシュが一致したときにだけ**解決します。
 * 途中で読むのをやめれば解決しません（reject します）。
 * 確定の口がこの証拠を要求するので、early-exit した読み取りは
 * そこへ到達できません。
 *
 * **副作用を伴う消費では、この保証は事後通知に縮退します。**
 * ストリームを読みながら別の場所へ書く消費者にとって、
 * `completed` が reject した時点で書き込みは既に起きています。
 * その場合の後始末は消費者の責任です（KNOWN_LIMITATIONS 11節）。
 */
export interface VerifiedRead {
  stream: ReadableStream<Uint8Array>;
  completed: Promise<VerifiedContentHash>;
}

/**
 * 内容アドレスの実体置き場。
 *
 * v0.2 の変更: exists() を削除した。
 *
 * 「存在する」は「正しい」の証拠にならない。
 * 0バイトのファイルも、切断されたファイルも、存在はする（#8, #20, #21）。
 *
 * put は次を満たすこと:
 *   1. 一時ファイルへ書く（内容アドレス名を持たせない）
 *   2. fsync
 *   3. ハッシュとサイズを検証
 *   4. expectedSizeBytes と一致しなければ一時ファイルを破棄して例外
 *   5. 最終名へ rename
 *   6. 親ディレクトリを fsync
 *   7. verifiedAt を返す
 *
 * 途中生成物は内容アドレス名を一切持たない。これが #21 への答え。
 *
 * ---
 *
 * **この契約が書けなくするもの（4点）**
 *
 * 1. **鍵と中身が食い違う put。** `put` は鍵を受け取りません。鍵は内容から
 *    導出され、しかも導出に必要な材料（バイト列）はその場にあります
 *    （AGENTS.md 9節の1つ目の対処）。鍵を受け取ると、渡された鍵と実際の
 *    内容が食い違う put が書けます。`exists()` を消したのと同じ形です。
 *    **鍵はフルリードが終わるまで確定しません。** 途中で名前が決まる経路が
 *    無いので、「読み終える前に内容アドレス名を持つ中間物」も作れません（#21）。
 *
 * 2. **検証を忘れた get。** `get` は `expectedHash` を要求します。生バイトを
 *    返す口を既定にすると、全呼び出し側が毎回ハッシュ検証を思い出す必要があり、
 *    **忘れられる検証は消音ボタン**です。未検証の口は
 *    `getUnverifiedForRepair` という名前で切ってあります。名前で切るのは、
 *    grep 一発で「検証していない読み手」を全部数えられるようにするためです。
 *
 * 3. **黙って通る上書き。** 同じ鍵に別内容が来たら `BlobDivergenceError`。
 *    上書きも、無言のスキップもしません。`DerivationDivergenceError` の
 *    blob 版です。「存在するから正しい」を拒みます（#8, #10, #11）。
 *
 * 4. **系譜より先の blob 削除。** `delete` は鍵だけでは呼べません。
 *    授権（`BlobDeletionGrant`）と述語の評価者（`BlobDeletionJudge`）を
 *    同時に要求します。**判定結果を値で受け取る形は採りません** —
 *    値は発行時点の世界を実行時点まで運んでしまうためです（軸5）。
 *
 * 5. **証拠の詐称。** `PutResult.contentHash` と `verifiedAt` は証拠型です。
 *    任意の値を書けません。`get` は「バイト列」ではなく
 *    「バイト列 + 読み切った証拠」を返すので、途中でやめた読み取りは
 *    `commitDerivation` に渡せません。
 */
export interface BlobStore {
  /**
   * @param expectedSizeBytes 列挙時に報告されたサイズ。
   *        読み取りバイト数がこれと違えば例外。書き込み途中のファイルを
   *        「存在しなかった状態」として永続化しないため（#7）。
   *        0 は正当な値であり、undefined と区別する（#20）。
   *
   *        **これは「食い違い得る同一性引数の対」ではありません。**
   *        鍵と違い、これは接続元が申告した値で、こちらで導出できません。
   *        食い違いこそが検出対象なので、受け取って**反証するために**使います。
   *
   * 既に同じ鍵がある場合:
   *   - 保存済みバイト列を読み直してハッシュを再計算し、一致すれば
   *     `created: false` を返す（冪等な no-op）
   *   - 一致しなければ `BlobDivergenceError`。**上書きしない**
   *
   * 重複 put のたびに実体を1回読み直します。**この費用は意図したものです。**
   * サイズや mtime で済ませるのは `exists()` を名前を変えて復活させることで、
   * 0バイトのファイルも切断されたファイルもそこを通ります（#8, #20）。
   */
  put(content: ReadableStream<Uint8Array>, expectedSizeBytes: number): Promise<PutResult>;

  /**
   * 実バイト列を読み直してハッシュを再計算する。真の検証（#8, #30）。
   *
   * boolean を返すのは、これが**監査**の入口だからです
   * （`verifyBlobReferences` が列挙した参照を潰していく用途）。
   * 消費のための読み取りには使わないでください。それは `get` の仕事です。
   */
  verify(key: BlobKey, expectedHash: ContentHash): Promise<boolean>;

  /**
   * 検証つきの読み取り。**既定の口はこちらだけです。**
   *
   * 返るストリームは、読み切った時点でハッシュが `expectedHash` と
   * 一致しなければ**エラーで終わります**。
   *
   * **保証が成立するのは読み切った場合だけです。** 以前はこれを散文で
   * 書いていましたが、**途中でやめた読み取りと読み切った読み取りの型が
   * 同じ**なので、下流には区別がつきませんでした。
   * いまは `VerifiedRead.completed` を返し、確定の口
   * （`commitDerivation` / `insertVersionIfAbsent`）が
   * その証拠を要求します。**early-exit した読み取りは確定に渡せません。**
   *
   * 先頭 N バイトだけで判断する処理を書くなら、その処理自身が
   * 別の根拠を持つ必要があります。
   */
  get(key: BlobKey, expectedHash: ContentHash): Promise<VerifiedRead>;

  /**
   * 検証しない読み取り。**修復専用です。**
   *
   * 存在理由は1つ。「壊れた blob を調べる」には壊れた blob が読めなければ
   * ならないからです（`verify` が false を返した実体の中身を見る、など）。
   * 通常の消費経路で使わないでください。
   *
   * **名前が長いのは意図的です。** `get` と同じ短さだと、検証つきの口と
   * 取り違えて使われます。この名前なら、grep で未検証の読み手を全部数えられます。
   */
  getUnverifiedForRepair(key: BlobKey): Promise<ReadableStream<Uint8Array>>;

  /**
   * 壊れた実体を、**検証済みの正バイト列で置き換える。修復専用です。**
   *
   * この口が無いと閉区画ができます（KNOWN_LIMITATIONS 12節）。
   * `put` は上書きしない × grant は参照のある鍵に発行されない ×
   * `getUnverifiedForRepair` は読むだけ — 門はどれも正しいのに、
   * **積が「参照されている壊れた blob」からの出口を塞ぎます。**
   *
   * **上書きしてよい理由は内容アドレスにあります。** 供給されたバイト列の
   * ハッシュが `key` に対応しなければ拒否するので、この口が書ける内容は
   * **その鍵の正しい内容ただ1つ**です。「別内容で上書き」は定義上書けません。
   * `put` が上書きを拒むのは「どちらが正か言えない」からで、
   * ここでは正が一意に決まります。
   *
   * 手順は `put` と同じ7段（一時ファイル → fsync → 検証 → rename →
   * 親ディレクトリ fsync）。置き換え中の中間物に内容アドレス名を持たせません。
   */
  restoreFromVerifiedBytes(
    key: BlobKey,
    content: ReadableStream<Uint8Array>,
    expectedSizeBytes: number,
  ): Promise<PutResult>;

  /**
   * 実体を消す。**鍵だけでは呼べません。**
   *
   * @param grant 授権の範囲（誰が / どの走査世代の判断に基づき / 何件まで）。
   *        **「この鍵は消してよい」という主張は入っていません。**
   * @param judge 削除述語の評価者。`LineageStore` の実装が提供する。
   *
   * ## 手順
   *
   * `put` には7手順の耐久儀式があるのに、`delete` の契約には長らく
   * 手順が1行もありませんでした。**削除の完遂は「不在の永続」を含意します。**
   * `put` と同じ強度で書きます。
   *
   * 1. `key` に対する**排他区間**に入る。この区間は `put` と共有する。
   *    同じ鍵に対する `put` はこの間ブロックするか、失敗する
   * 2. `judge.confirmDeletable(key, grant)` を呼ぶ。
   *    `deletable: false` なら何もせず `refusal` を返す
   * 3. unlink
   * 4. **親ディレクトリを fsync。** ここを省くと、unlink 後・fsync 前の
   *    電源断でディレクトリエントリが復活します。#8 の鏡像です
   *    （#8 は「無いはずのものが在る」、これは「消したはずのものが在る」）
   * 5. 排他区間を出る
   *
   * **復活した実体は矛盾として検出対象です。** 「消したのに在る」を
   * 「まあ在るならいい」と読むと、それは `exists()` を信じるのと
   * 同じ判断になります。
   *
   * ## 同一鍵の直列化（1 が要る理由）
   *
   * 述語の再評価だけでは窓が閉じません:
   *
   * 1. 削除側が `confirmDeletable` を通過（参照ゼロ）
   * 2. **別のワーカーが同じ内容を `put` して完了。version 行が立つ**
   * 3. 削除側が unlink
   *
   * 結果は「参照のある version 行 + 実体なし」です。
   * 2 は正常な冪等 `put`（`created: false`）なので、どこにも異常が現れません。
   * **実行時の再検査は「その瞬間」しか保証しないので、
   * 検査と作用の間に窓が残ります。** 閉じられるのは直列化だけです。
   *
   * v0.1 では実装しません。**契約だけ先に置きます。**
   */
  delete(
    key: BlobKey,
    grant: BlobDeletionGrant,
    judge: BlobDeletionJudge,
  ): Promise<BlobDeletionOutcome>;
}

/**
 * 状態と系譜の保存先。
 *
 * v0.2 の変更:
 *   - insertDerivationIfAbsent / insertArtifactsIfAbsent を廃止
 *     → commitDerivation に統合（原子的）
 *   - findMissingSince が CompletedScanRun を要求
 *   - heartbeat / completeRun が workerId を要求
 *   - リース時刻の引数を削除（ストアが付与）
 */
export interface LineageStore {
  // --- 走査 ---
  /**
   * 同一 source で running な走査が既にあれば例外。
   * DB 側にも部分ユニークインデックスを張ること（#1）:
   *   CREATE UNIQUE INDEX ... ON scan_run(source_id) WHERE status = 'running';
   */
  beginScan(sourceId: SourceId, thresholds: {
    countRatioThresholdBp: number;
    missingRatioThresholdBp: number;
  }): Promise<ScanRun>;

  /**
   * 観測の記録。失敗したら例外を投げること。握りつぶし禁止（#16）。
   *
   * outcome がどの枝でも lastSeen を更新する。読めなかったことは
   * 見えなかったことではない（#17）。
   */
  recordObservedDocument(scanId: ScanId, entry: ObservedEntry): Promise<ObservedResult>;

  /**
   * 走査を完了させ、安全弁を判定する。
   * 弁が発火したら aborted_safety を返し、以後 CompletedScanRun は得られない。
   *
   * 弁の発火はエラーではありません。正常な結果なので状態として返します。
   */
  /**
   * 部分木を**一覧できなかった**ことを記録する。
   *
   * `enumerate` が返せるのは `SourceEntry`、つまり**見えたファイル1件**です。
   * ディレクトリを開けなかったという事実には置き場所がありませんでした。
   * 実装者に残されていたのは「例外で走査全体を止める」か「黙って飛ばす」の
   * 二択で、後者を選ぶと**閾値以下の欠損が正当な tombstone になります。**
   *
   * これを呼ぶと `finishScan` の安全弁が通らなくなります（`unlistable_subtree`）。
   * **承認では免除しません。** 見えなかった範囲について「無くなった」と
   * 述べる根拠が無い以上、運用者の確信も根拠にはなりません（AGENTS.md 3.5）。
   *
   * `writeFailureCount` と違い完了時にまとめて渡す形にしていないのは、
   * **どの部分木が見えなかったか**が監査の対象そのものだからです。
   * 件数だけでは「どこを見ていないのか」が残りません。
   */
  recordUnlistableSubtree(
    scanId: ScanId,
    subtree: { subtreeKey: string; errorKind: string },
  ): Promise<void>;

  finishScan(scanId: ScanId, counts: {
    enumeratedCount: number;
    distinctCount: number;
    /**
     * 観測の記録に失敗した件数（#16）。
     *
     * 数えているのは走査ループ側です。`recordObservedDocument` は握りつぶさず
     * 例外を投げるので、ストアには「何件失敗したか」が伝わりません。
     * 「DB が busy で書けなかった事実を DB に書きに行く」自己矛盾を避けるため、
     * カウンタは呼び出し側が持ち、完了時にまとめて渡します。
     *
     * クラッシュでカウンタが失われた場合は走査が running のまま残り、
     * promote されないので fail-closed です。
     */
    writeFailureCount: number;
  }): Promise<ScanRun>;

  /**
   * 運用者による1回限りの承認（#28）。
   *
   * **閾値そのものは変更しません。** この走査にのみ効きます。
   * 閾値を 0 にして弁を恒久的に無効化する運用を避けるための口であり、
   * 閾値を書き換える API は作りません（KNOWN_LIMITATIONS 8節）。
   *
   * 対象は running の走査に限ります。承認してから完了させる順序です。
   * パイプラインは列挙後の reviewSafety で実数を提示し、その走査に上限を付けます。
   * 上限は有限の非負整数。既に記録した承認の差し替えは拒みます（S4-3）。
   * 書き込み失敗（G1）は承認で免除されません。運用者は「記録されなかったもの」を
   * 知る手段を持たないので、承認という判断が原理的にできないためです。
   */
  approveScan(scanId: ScanId, note: string, maxMissingCount: number): Promise<ScanRun>;

  /** 運用者が残留走査の世代を知るための読み取り。終了は明示した scanId に限る。 */
  findRunningScan(sourceId: SourceId): Promise<ScanRun | null>;

  /** S4-3: 承認前の欠損件数。削除の能力は返さず、確定時にも再計数する。 */
  countMissingInRunningScan(scanId: ScanId): Promise<number>;

  /**
   * 走査を `failed` で閉じる。
   *
   * 列挙そのものが続けられなくなった場合（マウント断、接続元のエラー）に、
   * パイプライン層が呼びます。**安全側に倒れます**: `failed` の走査は
   * 次回の基準値になれず（#3）、`promoteToCompleted` も通らないので
   * 削除判定にも進めません。
   *
   * この口が無いと、クラッシュした走査が `running` のまま残り、
   * `idx_one_running_scan` によってその source では二度と `beginScan` できません。
   * 「安全に閉じる手段が無いこと」は fail-closed ではなく、ただの閉塞です。
   *
   * 時間経過による自動回収は入れません。何分で見捨てるかの方針決定が要り、
   * それは v0.2 の範囲です（KNOWN_LIMITATIONS 6節）。
   *
   * @param reason 機械判定できる正準トークン。空文字は拒否します
   */
  failScan(scanId: ScanId, reason: string): Promise<ScanRun>;

  /**
   * 削除判定に進めるかを問う。**唯一の入口。**
   * 次をすべて満たすときのみ CompletedScanRun を返す:
   *   - status === "completed"
   *   - writeFailureCount === 0
   *   - この走査より後に完了した走査が存在しない（#1, #2）
   *   - 安全弁を通過、または承認済み（#28）
   */
  promoteToCompleted(scanId: ScanId): Promise<CompletedScanRun | null>;

  /**
   * **削除の反映が済んでいない完了走査の scanId。1行も書きません。**
   *
   * `completed` は「列挙と安全弁を通った」であって「削除を反映した」では
   * ありません（`ScanRun.deletionState`）。反映の途中で書き込みが失敗すると、
   * 基準値だけが進んで削除は未反映という状態が残り、次の走査は同じ入力でも
   * `aborted_safety` になり続けます（C1）。
   *
   * **返すのは scanId だけです。** 削除判定へ進める門は
   * `promoteToCompleted` 1つで、ここが `CompletedScanRun` を返すと
   * 2つ目の門になります。呼び出し側はこの ID をその門に通します。
   *
   * 見るのは source ごとの**最新完了走査だけ**です。より古い pending は
   * 後続の完了走査が同じ欠損を見ているので、そちらの反映で足ります。
   */
  findPendingDeletion(sourceId: SourceId): Promise<ScanId | null>;

  /**
   * 削除の反映が最後まで終わったことを記録する。
   *
   * 渡された値を信じず `promoteToCompleted` と同じ門を通します。
   * 同じ source のより古い `pending` は `superseded` に畳みます
   * （この走査はそれらより後に列挙しているので、古い走査が欠損と見た文書は
   * この走査でも欠損として見えています）。
   *
   * @throws StaleScanError 追い越された走査、または弁を通っていない走査
   * @throws InvalidArgumentError 走査が無い / source が食い違う
   */
  markDeletionApplied(scan: CompletedScanRun): Promise<void>;

  /** ScanId ではなく CompletedScanRun を要求する。型で順序を強制（#4） */
  findMissingSince(scan: CompletedScanRun): AsyncIterable<Document>;

  /**
   * 欠損した文書に墓標を立てる。**論理削除です。行は消しません。**
   *
   * `findMissingSince` と同じく `CompletedScanRun` を要求します。
   * **`ScanId` を裸で受け取る削除系 API は作りません**（AGENTS.md 6節の禁止事項）。
   * 安全弁を通った証拠を持つ者だけが、この口に到達できます。
   *
   * 状態と観測を**同一トランザクション**で動かします。`document_tombstoned`
   * の観測が墓標の出所そのもの（`DELETION_ONLY_FROM_COMPLETED_SCAN` は
   * `observation.scan_id` で辿ります）なので、片方だけが残ると
   * 「出所の辿れない墓標」になります。
   *
   * @returns 立てたなら true。**既に tombstone 済み、またはこの走査以降に
   *          観測されている文書なら false。** 呼び出し側の誤りではないので
   *          例外にしません（`findMissingSince` の列挙と実際の書き込みの間に
   *          別の観測が入ることは正常に起こります）。
   *          「この走査以降」には**この走査自身の観測**と、**この走査より後に
   *          開始した走査の観測**の両方が入ります。後者を含めないと、
   *          重なった走査が実在するファイルに墓標を立てます（攻撃 #1）
   * @throws StaleScanError 追い越されていた場合（#1, #2）。
   *         **列挙の時点で最新でも、書く時点で最新とは限りません。**
   * @throws InvalidArgumentError 走査の source に属さない文書を指した場合
   */
  tombstone(scan: CompletedScanRun, documentId: DocumentId): Promise<boolean>;

  /** 走査対象に含まれない sourceId の active 文書を検出（#24） */
  findOrphanedSources(knownSourceIds: ReadonlyArray<SourceId>): Promise<ReadonlyArray<SourceId>>;

  // --- ドキュメント ---
  /**
   * active ポインタの更新。
   *
   * 攻撃 #15: version 挿入後・ポインタ更新前にクラッシュすると、
   *          再実行時に created:false が返り「変更なし」と判断されて
   *          ポインタが永久に古いままになる。
   *   → ポインタの正しさは挿入結果ではなく現在の観測から決まる。
   *     observedHash が現 active と違えば、version が既存でも更新する。
   *
   * 攻撃 #2: 古い走査の観測でポインタが巻き戻る。
   *   → scan がその source の最新完了走査でなければポインタは動かさない。
   *
   * 2026-09-10 の指摘: **「running か」は「この文書の走査か」ではない。**
   *   同一 source の running は高々1件だが、別 source の running 走査は
   *   いつでも存在する。#2 が `stale_scan` で拒んだのと同じ更新が、
   *   scanId を別 source の running 走査に替えるだけで通った。
   *   → 走査と文書の source が違えば `InvalidArgumentError`。
   *     競合ではなく取り違えなので `stale_scan` には畳まない。
   *
   * @throws InvalidArgumentError 文書が無い / versionId が
   *         documentId + observedHash と食い違う / **走査が文書の source に
   *         属さない**場合
   */
  setActiveVersion(args: {
    documentId: DocumentId;
    observedHash: ContentHash;
    versionId: VersionId;
    scanId: ScanId;
  }): Promise<{ updated: boolean; reason?: "stale_scan" | "already_current" }>;

  /**
   * versionId はストアが導出して返す。呼び出し側が導出しないための戻り値。
   *
   * **`created` を「変更なし」の根拠にしないでください（#15）。**
   * version 挿入後・ポインタ更新前にクラッシュすると、再実行時に
   * `created:false` が返ります。そこで打ち切るとポインタが永久に古いままです。
   * `created` の値に関わらず `setActiveVersion` を必ず呼びます。
   */
  insertVersionIfAbsent(version: VersionDraft): Promise<{ created: boolean; versionId: VersionId }>;

  // --- 派生 ---
  /**
   * Derivation・全 Artifact・run 完了を**同一トランザクションで**書く。
   * 部分的な成立はあり得ない（#9）。
   *
   * 既に同じ derivationKey の Derivation が存在する場合:
   *   - outputsHash と artifactCount が一致 → 冪等な no-op
   *   - 一致しない → DerivationDivergenceError（#10, #11）
   *     「存在するから正しい」とは扱わない。
   *
   * ## 同一性の引数は、消すのではなく束縛する
   *
   * `derivationKey` / `artifactCount` / `outputsHash` を受け取らないのは、
   * それらが**導出可能**だからです。呼び出し側が宣言した値と実際の値が
   * 食い違う余地を残さないために、導出できるものは導出します。
   *
   * `runId` は違います。**導出できません。** 鍵は「何を処理するか」を指し、
   * runId は「その鍵の、どの世代の試行か」を指します。同じワーカーが同じ鍵を
   * 再 claim すれば、鍵は同じで runId だけが変わります。runId はフェンシング
   * トークンであって、鍵の別名ではありません。
   *
   * だから受け取り、**一致を要求します**:
   *
   *   1. `derivation` から鍵を導出する（呼び出し側は鍵を渡せない）
   *   2. `runId` の run を引く
   *   3. その run の `derivation_key` が導出鍵と一致すること
   *   4. その run が `leased` で、期限内で、`worker_id` が `workerId` であること
   *
   * 3 が無いと、鍵Xのリースで鍵Yの派生を確定でき、鍵Xの run が
   * `succeeded` に閉じられます（元の B の穴）。
   * 4 が無いと、失効して reap された世代の遅れてきた commit が、
   * 同じワーカーが取り直した**次の世代**を閉じます（#13 が commit 経路で崩れる）。
   * どちらも `succeeded` を書き、`#blockingRun` がその鍵を恒久的に塞ぐので、
   * 誤った artifact が正本のまま二度と処理できなくなります。
   *
   * ## 原本と文書は、受け取らずに run から決めます（2026-09-10）
   *
   * `DerivationDraft` は `rootVersionId` も `documentId` も持ちません。
   * 検証した run の `root_version_id` を原本とし、**その原本の version 行から**
   * 文書を引きます。どちらも同一トランザクション内です。
   *
   * 一致を要求する（束縛する）形も考えられますが、**受け取らないほうが強い**です。
   * 束縛は「食い違ったら止める」で、受け取らなければ食い違いが表現できません。
   * `claimRun` から `documentId` を消したのと同じ理由です（9節 軸1）。
   * 鍵の照合（3）はこれを守れません——`rootVersionId` は鍵の材料ではないからです。
   *
   * **片方を消すと、消したほうの識別子が守っていた性質も消えます。**
   * 「食い違える引数を受け取らない」は、導出可能な引数についての規則です。
   * 独立した意味を持つ識別子の対には、束縛を書きます。
   */
  commitDerivation(args: {
    derivation: DerivationDraft;
    artifacts: ReadonlyArray<ArtifactDraft>;
    /**
     * この派生を行った試行。導出鍵のリースとして生きていなければ
     * `StaleWorkerError`（B / #13）。鍵の別名ではなく世代の識別子。
     */
    runId: RunId;
    /**
     * その run を現に持っているワーカー。
     * 一致しなければ `StaleWorkerError`（#13）。
     */
    workerId: WorkerId;
  }): Promise<{ created: boolean; derivationKey: DerivationKey }>;

  // --- 実行管理 ---
  /**
   * 原子的にリースを取得する。
   * SQLite では BEGIN IMMEDIATE、Postgres では SELECT ... FOR UPDATE SKIP LOCKED。
   * DB 側にも部分ユニークインデックスを張ること（#12）:
   *   CREATE UNIQUE INDEX ... ON processing_run(derivation_key) WHERE status = 'leased';
   */
  /**
   * **鍵ではなく材料を受け取ります**（AGENTS.md 9節）。
   *
   * 以前は `derivationKey` を受け取っていました。同じ同一性が
   * `claimRun` と `commitDerivation` の2点を渡り、claim 側は
   * **呼び出し側が計算した鍵を信じる**形です。2経路あるので食い違えます。
   * 鍵は sha256 の一方向要約なので、渡された鍵が本当にこの
   * `rootVersionId` のものかを判定する述語は書けません
   * ——**束縛できない冗長**でした。
   *
   * いま `claimRun` と `commitDerivation` は**同じ材料から同じ関数で**
   * 鍵を導出します。導出が1箇所なので、食い違いようがありません。
   *
   * `documentId` も受け取りません。`rootVersionId` から `version` 行を
   * 引けば同一トランザクション内で一意に決まります（9節 軸1）。
   * `rootVersionId` は残ります。鍵からも材料からも決まらず、閉包の外だからです。
   */
  claimRun(args: {
    // --- 鍵の材料。ここが正本になる ---
    processorName: string;
    processorVersion: string;
    configHash: string;
    inputIds: ReadonlyArray<VersionId | ArtifactId>;

    /**
     * derivation 行はまだ存在しない（commitDerivation が書く）ので、
     * 系譜の追跡に必要な参照は claim 時に受け取る。
     * 列を nullable にする案は追跡性を落とすので採らない。
     */
    rootVersionId: VersionId;
    workerId: WorkerId;
    /** 期間であって時刻ではない。ストアが now + leaseSeconds で失効時刻を決める */
    leaseSeconds: number;
  }): Promise<ProcessingRun | null>;

  /**
   * workerId が一致し、かつ status === "leased" のときのみ成功。
   * 失効後に復活したワーカーの操作は拒否し Observation に残す（#13）。
   */
  heartbeat(runId: RunId, workerId: WorkerId): Promise<{ ok: boolean; reason?: "stale_worker" }>;

  completeRun(args: {
    runId: RunId;
    workerId: WorkerId;
    status: "succeeded" | "failed";
    error?: { kind: string; message: string; permanent: boolean };
  }): Promise<{ ok: boolean; reason?: "stale_worker" }>;

  /** 引数に時刻を取らない。ストア側の時計だけを使う（#14） */
  reapAbandonedRuns(): Promise<number>;

  // --- 監査 ---
  /** observationId と occurredAt はストアが付与する。引数に時刻の口は無い（#14） */
  appendObservation(o: ObservationDraft): Promise<void>;

  /**
   * ACL を更新する。**取得失敗は既存を上書きしない（#29）。**
   *
   * state が "unknown" で既存が "synced" の場合、principals は据え置き、
   * lastAttemptAt と lastError だけを更新します。
   * 空の principals を「制限なし」とも「全拒否」とも解釈させないためです。
   */
  upsertAcl(acl: AclDraft): Promise<void>;

  traceToOrigin(artifactId: ArtifactId): Promise<{
    artifact: Artifact;
    derivation: Derivation;
    version: DocumentVersion;
    document: Document;
  }>;

  /**
   * 起動時の参照整合性チェック。blob に到達できない参照を検出（#30）。
   *
   * **version と artifact の両方を列挙します。** 到達可能性の閉包は
   * `#allReferencesTo(blobKey)` 一本で、削除述語もこの関数を通ります。
   * 経路ごとに別々の「参照がある」を持つと、片方から見て孤児・
   * もう片方から見て生存、という状態が作れます。
   */
  verifyBlobReferences(limit?: number): AsyncIterable<BlobReference>;
}

// ----------------------------------------------------------------------------
// 10. 不変条件
// ----------------------------------------------------------------------------
//
// v0.1 の8項目は「全部緑のまま状態が壊れる経路」が指摘されたため、
// 6項目を追加し、IDEMPOTENT_REPLAY の定義を明文化した。

export const INVARIANTS = {
  // --- v0.1 から継続 ---
  LINEAGE_COMPLETE: "artifact_to_origin_reachability == 1.0",
  NO_ORPHAN_ARTIFACT: "orphan_artifact_count == 0",

  /**
   * 再実行後の状態が一致する。
   *
   * v0.2 で定義を明文化（#26）:
   *   比較に含める  : document, document_version, derivation, artifact, access_control
   *   比較に含めない: observation の行数と observationId
   *   比較に含める  : observation の (kind, documentId) の**集合**
   *
   * Observation は追記専用なので行数は増えて当然。
   * ただし「どの種類の事実が起きたか」の集合は一致しなければならない。
   *
   * **主張の範囲（2026-09-10、S4-12）:** 1走査の中で各 documentId が高々1回
   * 観測される入力について。`stable_key_collision`（NFC と NFD の同名など）が
   * 起きた文書ではポインタが走査内で複数回動くので、**初回→2回目の遷移で
   * 観測の種類に `version_reverted` が加わる。** 状態の表は一致し、2回目以降の
   * 遷移では種類の集合も一致する。チェッカーはこれを違反として報告し、
   * それが正しい（`scan.test.ts` が形を固定。KNOWN_LIMITATIONS 16節）。
   */
  IDEMPOTENT_REPLAY: "replay_state_diff == empty (observations compared as kind-set)",

  /**
   * 無変更の再実行で、**内容3表**（document_version / derivation / artifact）に
   * 行が増えない。
   *
   * **observation は対象外**（追記専用）。読めなかったもの（`document_unreadable`）と
   * 鍵にできず落としたもの（`entry_skipped`）は、無変更でも走査ごとに1行ずつ残る。
   * 「その走査でも読めなかった」は新しい事実で、版と `last_seen` が運ぶ内容の枝と
   * 違ってそれ以外に痕跡が無いため。増え方は落とした1件につき2行が上限
   * （`scan.test.ts` が固定。KNOWN_LIMITATIONS 16節、S4-13）。
   */
  NO_WORK_WITHOUT_CHANGE: "unchanged_rerun_writes == 0",
  SINGLE_ACTIVE_VERSION: "documents_with_multiple_active_versions == 0",
  SAFETY_ABORT_WRITES_NOTHING: "tombstones_during_aborted_scan == 0",
  /**
   * 保存されたハッシュが実体と一致する。**置き場所2つを1つの主張で見る。**
   *
   *   - `blob_key` の行 … blob を読み直す。**`BlobVerifier` を渡したときだけ**走る
   *   - `inline_content` の行 … 行の中の本文から計算する。常に走る
   *
   * `BlobVerifier` が無いとき、この項は `ok` になりません（blob を1バイトも
   * 見ていないため）。ただし inline で見つけた不一致は `violated` として報告します。
   * **確定時の検査は新しい不整合を止めるだけなので、既に入った行を見つけるのは
   * この検算です**（2026-09-10。KNOWN_LIMITATIONS 11.5）。
   */
  HASH_MATCHES_BLOB: "hash_mismatch_count == 0",
  ACL_DOES_NOT_VERSION: "versions_created_by_acl_change == 0",

  // --- v0.2 追加 ---
  /** 同一 source で running な走査は同時に最大1件（#1） */
  ONE_RUNNING_SCAN_PER_SOURCE: "concurrent_running_scans_per_source <= 1",

  /** tombstone は completed かつ最新かつ writeFailure 0 の走査からのみ（#1,#3,#4,#16） */
  DELETION_ONLY_FROM_COMPLETED_SCAN: "tombstones_from_non_promoted_scan == 0",

  /**
   * blobVerifiedAt を持たない version 行が存在しない（#8, #21, #30）。
   *
   * **実行時に検査しているのは** `blob_verified_at > 0`、`blob_key` が非空、
   * `blob_verified_at <= ingested_at` の3つだけ。証拠が**その版の**バイト列の
   * ものかは型にも行にも無く、検査できない（`VerifiedAt` の doc、S4-14）。
   * 実体との一致は `HASH_MATCHES_BLOB` の担当。
   */
  NO_VERSION_WITHOUT_VERIFIED_BLOB: "versions_with_unverified_blob == 0",

  /** 同じ derivationKey の再実行で outputsHash と artifactCount が一致（#10, #11） */
  DERIVATION_OUTPUT_STABLE: "derivation_output_divergence_count == 0",

  /** activeVersionId が最新観測の contentHash と一致（#2, #15） */
  POINTER_MATCHES_OBSERVATION: "stale_active_pointer_count == 0",

  /** 固定値テストベクタが全環境で同じハッシュを返す（#6, #22, #23） */
  CANONICAL_KEY_STABILITY: "config_hash_test_vectors == expected",

  // --- v0.4 追加 ---
  /**
   * `derivation` 行の鍵が、**その行に保存された材料から再導出できる**。
   *
   * 既存14項目のどれもこれを主張していませんでした。
   * `CANONICAL_KEY_STABILITY` は凍結ベクタ（固定入力）の話で、
   * `DERIVATION_OUTPUT_STABLE` は `outputsHash` の話です。
   * **「保存されている鍵が、保存されている材料のものか」はどこにも無く、
   * 簡略式で作った鍵が入っていても全項目が緑のままでした。**
   *
   * これが無いと `IDEMPOTENT_REPLAY` が恒真式化します。
   * 2回の走行が同じ簡略式で同じ鍵を作れば、状態は必ず一致するからです
   * ——実導出経路を一度も通らずに。
   */
  DERIVATION_KEY_MATCHES_MATERIALS: "derivation_key_reforge_mismatch_count == 0",
} as const;

/** 各フィクスチャの `assertions` が参照する不変条件の名前 */
export type InvariantName = keyof typeof INVARIANTS;
