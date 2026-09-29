> Office版の技術的制約・試験割当の記録です。日付付きの状態は当時のものです。
> 開発記録・実資料の画像は同梱しません。公開版の範囲は README.md を参照してください。

# FIXTURES.md — 敵対シナリオのテスト割り当て

30の攻撃シナリオを `test/fixtures/` の命名に落としたものです。
このファイル自体が Claude Code への委譲仕様になります。

**すべて .txt のダミーファイルで再現できます。PDF も DOCX も不要です。**

この主張は下記のv0.1の30シナリオについてです。⑤の追加コーパスは
`test/support/office-samples.ts` の架空のWord・Excelで、
`src/parser/office.test.ts` と `src/console/server.test.ts` が検証します。
既存30シナリオの表・deferredを変更せず、⑤の実測（開発時の非公開記録）に別記します。

---

## 委譲の指示（そのまま渡せる形）

> `FIXTURES.md` の各行について、1シナリオ1ファイルでフィクスチャを実装してください。
> 各フィクスチャは次の3つを export します。
>
> ```ts
> export const setup: (ctx: FixtureContext) => Promise<void>   // 初期状態を作る
> export const execute: (ctx: FixtureContext) => Promise<void> // 攻撃を実行する
> export const assertions: ReadonlyArray<InvariantName>        // 検証する不変条件
> ```
>
> `scope: v0.1` の行のみ実装してください。`deferred` の行は空のスタブにして
> `export const deferred: string` に理由（KNOWN_LIMITATIONS.md の該当節）を書きます。
> ランナーがこれを見て `it.skip` にします。
>
> 各フィクスチャは独立して動作すること。実行順に依存しないこと。
> 時刻は必ず `ctx.clock` を経由し、`Date.now()` を直接呼ばないこと。

### 4つ目の export（例外的。増やさない）

```ts
export const expectedViolations: ReadonlyArray<{
  invariant: InvariantName;
  problem: string;   // invariant-checker の Finding.problem と完全一致
  reason: string;    // なぜ「世界についての主張」なのか。必須
}>
```

**実行後に成立していないことが正しい不変条件**を名指しします。
使ってよいのは、破れた不変条件が「世界についての主張」であって
「ストアについての主張」でない場合**だけ**です。

現時点で使っているのは **#11 の1本だけ**です。`DERIVATION_OUTPUT_STABLE` の定義は
`derivation_output_divergence_count == 0` で、分岐が実際に起きた以上この主張は
本当に偽ですが、ストアは正しく検出して拒んでいます。

ストアの欠陥に使った瞬間、この仕組みは消音ボタンになります。

**歯止めは散文ではなくランナーにあります。** `runner.test.ts` の
`MAX_FIXTURES_WITH_EXPECTED_VIOLATIONS`（現在 1）を超えると落ちます。
2件目を入れるにはこの数を上げる必要があり、その1行は差分に必ず現れます。
**上げる前にオーナーに上げてください。**

緩めではなく追加の要求です。名指しした違反が実際に起きなければランナーは落ちます。

### ランナーが FIXTURES.md を読みます

`test/fixtures/runner.test.ts` は上の表を解析し、
**行とファイルが1対1であること**と、**表の不変条件がフィクスチャの
`assertions` と一致すること**を検査します。
この文書が実装より古くなると、検査そのものが嘘をつきます。

---

## A. 走査の排他と権限（scan/）

| # | ファイル | 検証する不変条件 | scope |
|---|---|---|---|
| 1 | `scan/overlapping-scans-mass-tombstone.ts` | ONE_RUNNING_SCAN_PER_SOURCE, DELETION_ONLY_FROM_COMPLETED_SCAN | v0.1 |
| 2 | `scan/stale-scan-rewinds-active-pointer.ts` | POINTER_MATCHES_OBSERVATION, SINGLE_ACTIVE_VERSION | v0.1 |
| 3 | `scan/failed-scan-poisons-baseline.ts` | SAFETY_ABORT_WRITES_NOTHING | v0.1 |
| 4 | `scan/tombstone-written-before-valve.ts` | SAFETY_ABORT_WRITES_NOTHING, DELETION_ONLY_FROM_COMPLETED_SCAN | v0.1 |
| 5 | `scan/same-count-different-volume.ts` | SAFETY_ABORT_WRITES_NOTHING, NO_WORK_WITHOUT_CHANGE | v0.1 |
| 16 | `scan/write-failure-causes-false-tombstone.ts` | DELETION_ONLY_FROM_COMPLETED_SCAN, IDEMPOTENT_REPLAY | v0.1 |
| 27 | `scan/duplicate-enumeration-skews-baseline.ts` | SAFETY_ABORT_WRITES_NOTHING | v0.1 |
| 28 | `scan/valve-approval-not-threshold-change.ts` | SAFETY_ABORT_WRITES_NOTHING | v0.1 |

**#1 の作り方**: 走査Bを完了させた後に走査Aの `promoteToCompleted` を呼び、
`null` が返ることを検証する。DB のユニークインデックスで `beginScan` が
そもそも失敗することも別途検証する。

**#4 の作り方**: `findMissingSince` に `ScanId` を渡すコードが
**コンパイルできないこと**を型テスト（`@ts-expect-error`）で検証する。
これは実行時テストではなく型テスト。

---

## B. トランザクションと「存在＝正しい」（commit/）

| # | ファイル | 検証する不変条件 | scope |
|---|---|---|---|
| 9 | `commit/derivation-artifact-split-crash.ts` | NO_ORPHAN_ARTIFACT, LINEAGE_COMPLETE | v0.1（ダミーprocessor） |
| 10 | `commit/artifact-union-across-runs.ts` | DERIVATION_OUTPUT_STABLE, IDEMPOTENT_REPLAY, NO_ORPHAN_ARTIFACT | v0.1（ダミーprocessor） |
| 11 | `commit/same-key-different-content.ts` | DERIVATION_OUTPUT_STABLE | v0.1（ダミーprocessor） |
| 15 | `commit/version-inserted-pointer-not-updated.ts` | POINTER_MATCHES_OBSERVATION, LINEAGE_COMPLETE | v0.1 |
| 26 | `commit/observation-state-commit-skew.ts` | IDEMPOTENT_REPLAY | v0.1 |

**ダミーprocessor について**: v0.1 に Parser はないので、
入力 version を受け取って固定の Artifact を N 件返すだけの
`EchoProcessor`（`processorName: "echo"`）をテスト用に置きます。
これで Derivation 経路のトランザクション性を検証できます。

**クラッシュの再現方法**: `LineageStore` をラップして、
指定した SQL の実行後に例外を投げる `CrashInjectingStore` を用意します。
プロセスを実際に落とす必要はありません。

---

## C. blob の原子性（blob/）

| # | ファイル | 検証する不変条件 | scope |
|---|---|---|---|
| 8 | `blob/torn-write-hash-named-file.ts` | HASH_MATCHES_BLOB, NO_VERSION_WITHOUT_VERIFIED_BLOB | v0.1 |
| 20 | `blob/empty-file-is-valid-content.ts` | HASH_MATCHES_BLOB, NO_WORK_WITHOUT_CHANGE | v0.1 |
| 21 | `blob/disk-full-mid-stream.ts` | NO_VERSION_WITHOUT_VERIFIED_BLOB | v0.1 |
| 30 | `blob/db-blob-backup-skew.ts` | LINEAGE_COMPLETE, HASH_MATCHES_BLOB | v0.1（検出のみ） |

**#8 の作り方**: blob の置き場所に手で 0 バイトのファイルを置き、その後 `put` を呼ぶ。
置き場所は `<root>/<鍵の先頭2文字>/<残り>` で、導出は
`src/store/blob/blob-path.ts` の `blobPath` が唯一の入口。
**パスを手で組み立てないこと。** 組み立てると、配置を変えたときに
このフィクスチャだけが古い場所を見て緑のままになる。
`put` が一時ファイル経由で正しく上書き（または検証失敗）することを確認する。

**#20 の注意**: 空ファイルの sha256 は
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`。
これを固定値としてテストに書き、`exists()` 相当の判定がサイズに
依存していないことを確認する。

**#21 の作り方**: `ReadableStream` を途中で `error()` させる。
実際にディスクを埋める必要はない。

---

## D. キー導出の正規化（keys/）

| # | ファイル | 検証する不変条件 | scope |
|---|---|---|---|
| 6 | `keys/root-path-trailing-slash.ts` | CANONICAL_KEY_STABILITY, NO_WORK_WITHOUT_CHANGE | v0.1 |
| 22 | `keys/config-hash-test-vectors.ts` | CANONICAL_KEY_STABILITY | v0.1 |
| 23 | `keys/unicode-nfd-nfc-case-fold.ts` | CANONICAL_KEY_STABILITY, SINGLE_ACTIVE_VERSION | v0.1 |

**最優先で書くこと。** この3本が緑でなければ他のテストは意味を持ちません。
キーが環境で揺れると、すべての ID が揺れます。

**#22 のテストベクタ**: 最低限これらを固定値で検証する。

```
{}                                → 既知のハッシュ
{a: 1}                            → 既知のハッシュ
{a: 1, b: 2} と {b: 2, a: 1}      → 同一
{a: undefined} と {}              → 同一
{a: null} と {}                   → 異なる
{a: "café"} NFC と NFD            → 同一
{a: 1.5}                          → 例外（浮動小数禁止）
{a: 1.0} と {a: 1}                → 同一（JS に両者の区別は無い）
{a: [1, 2]} と {a: [2, 1]}        → 異なる（配列は順序を持つ）
{a: "日本語"}                      → 既知のハッシュ（エスケープしない）
```

**#23 の注意**: macOS の CI と Linux の CI で同じ結果になることを確認する。
どちらか片方でしか回していないと、この攻撃は永久に見つかりません。

---

## E. リースと時刻（lease/）

| # | ファイル | 検証する不変条件 | scope |
|---|---|---|---|
| 12 | `lease/concurrent-claim-same-key.ts` | IDEMPOTENT_REPLAY | v0.1 |
| 13 | `lease/revived-worker-writes-stale.ts` | IDEMPOTENT_REPLAY | v0.1 |
| 14 | `lease/clock-authority-split.ts` | IDEMPOTENT_REPLAY | v0.1 |

**#12 の作り方**: 同じ `derivationKey` に対して `claimRun` を並行に2回呼び、
片方が `null` を返すことを検証する。SQLite なら `BEGIN IMMEDIATE` の有無で
結果が変わることを確認する。

**#14 の作り方**: `heartbeat` / `completeRun` の引数に時刻を渡す口が
**存在しないこと**を型テストで検証する。実行時テストでは、
`ctx.clock` を巻き戻しても `reapAbandonedRuns` の結果が
ストア時計に従うことを確認する。

---

## F. 観測したがversion化しない（observe/）

| # | ファイル | 検証する不変条件 | scope |
|---|---|---|---|
| 7 | `observe/size-mismatch-during-fetch.ts` | IDEMPOTENT_REPLAY, NO_WORK_WITHOUT_CHANGE | v0.1 |
| 17 | `observe/unreadable-is-not-missing.ts` | DELETION_ONLY_FROM_COMPLETED_SCAN | v0.1 |
| 18 | `observe/fingerprint-collision.ts` | NO_VERSION_WITHOUT_VERIFIED_BLOB | v0.1（記録のみ） |
| 19 | `observe/mtime-goes-backwards.ts` | LINEAGE_COMPLETE | v0.1 |
| 24 | `observe/renamed-source-id-zombies.ts` | SINGLE_ACTIVE_VERSION | v0.1（検出のみ） |
| 25 | `observe/tombstone-then-revival.ts` | IDEMPOTENT_REPLAY | v0.1 |
| 29 | `observe/acl-fetch-timeout.ts` | ACL_DOES_NOT_VERSION | deferred |

**#17 の作り方**: `chmod 000` で読めないファイルを作る。
CI が root で走ると権限が効かないので、その場合は
`SourceAdapter` をラップして `fetch` が `EACCES` を投げるようにする。
**root で走る CI では chmod が無効になることを見落としやすい。**

**#19 の作り方**: `utimes` で mtime を過去に戻し、内容だけ変える。
version が作られることを検証する（スキップされないこと）。

**#29 が deferred の理由**: v0.1 のローカルFS アダプタは
`fetchAcl` を実装しないため。KNOWN_LIMITATIONS.md 第5節。

`test/fixtures/observe/acl-fetch-timeout.ts` は**空のスタブ**で、
ランナーが `it.skip` にします。30本のうち緑にならないのはこの1本だけです。

**ストア側の規則は既に検証済みです。** 「取得失敗は既存の synced を上書きしない」
「unknown は principals を持てない」は `upsertAcl` の AC-ACL-01 / AC-ACL-02 が
検証しています（`src/store/sqlite/derivation.test.ts`）。
deferred なのは**アダプタ側の経路**、つまり「`fetchAcl` が失敗する」
という事象そのものです。v0.1 にその経路は存在しません。

**必要なのは失敗であって、時間切れではありません。**`state: "unknown"` は
失敗の結果です。拒否を投げるラッパーで足り、タイマも待ちも要りません
（#17 の代替経路と同じ形）。ファイル名の `timeout` は失敗の一例です。
解除条件は KNOWN_LIMITATIONS.md 5節。

型は前借りして正しくしてあり、機構は前借りしていません
（KNOWN_LIMITATIONS.md 冒頭の区分表）。

---

## 実行順序

1. **D（keys/）** — 最優先。ここが揺れると全部意味を持たない
2. **C（blob/）** — 原本の正しさ
3. **A（scan/）** — 誤削除の防止。データ消失に直結
4. **F（observe/）** — 誤削除の防止（続き）
5. **E（lease/）** — 並行性
6. **B（commit/）** — v0.1 では経路が存在しないため最後

---

## 共通ヘルパー（先に用意する）

```
test/support/
  clock.ts               # 制御可能な時計。Date.now() の直接呼び出しを禁止
  crash-injecting-store.ts  # 指定SQL後に例外を投げるラッパー
  echo-processor.ts      # ダミーprocessor（Derivation経路の検証用）
  fs-scenario.ts         # 一時ディレクトリにファイル構成を作る
  invariant-checker.ts   # INVARIANTS 全項目を一括検証
  state-snapshot.ts      # 再実行前後の状態比較（Observationはkind-setで比較）
```

`invariant-checker.ts` と `state-snapshot.ts` は
**全フィクスチャが共有する**ため、最初に作ります。

`state-snapshot.ts` の比較規則は `INVARIANTS.IDEMPOTENT_REPLAY` の
定義に厳密に従うこと（Observation の行数は比較しない、kind の集合は比較する）。
