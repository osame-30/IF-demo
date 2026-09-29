-- ============================================================================
--  Document Ingestion Framework — schema (v0.1 / types.ts v0.2 準拠)
-- ============================================================================
--
--  SQLite で動かすが PostgreSQL 互換に保つ（AGENTS.md 6節）。
--  ORM を使わないため、型だけでは守れない不変条件をここで宣言的に守る。
--
--  時刻はすべて EpochMs = BIGINT。
--  PostgreSQL の INTEGER は32bitでありエポックミリ秒が溢れるため、
--  時刻とバイト数には必ず BIGINT を使う（SQLite では INTEGER 親和性になる）。
--  ISO 文字列を持つ時刻列は1つも存在しない（#14 / AGENTS.md 3.8）。
--
--  比率は整数のベーシスポイント（bp）で持つ。浮動小数は使わない。
--  SQLite の REAL は8バイトだが PostgreSQL の REAL は4バイトで、
--  安全弁という「境界そのものが判断基準」の場所で移植先だけ結果が変わるため。
--  canonicalConfigHash が浮動小数を禁じているのと同じ理由が同じ強さで掛かる。
--
--  PRAGMA はここに置かない。接続セットアップの責務（store/sqlite/connection.ts）。
--
--  表は依存順に並べてある。**前方参照は1箇所だけ**（document → document_version）で、
--  これは document と document_version が相互参照するため原理的に消せない。
--  PostgreSQL は CREATE 時に参照先の実在を要求するので、移植時はこの1本を
--  ALTER TABLE ... ADD CONSTRAINT に外に出す。該当箇所に印を付けてある。
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 接続元
-- ----------------------------------------------------------------------------
--
-- keyNormalization を JSON ではなく列に開いているのは、
-- この4つが documentId の導出結果を決めるためです。
-- 後から変更できない値なので、スキーマ上で見えている必要があります（#6, #23）。

CREATE TABLE source (
  source_id           TEXT    PRIMARY KEY,
  kind                TEXT    NOT NULL,
  config_hash         TEXT    NOT NULL,
  display_name        TEXT    NOT NULL,

  key_unicode_form    TEXT    NOT NULL CHECK (key_unicode_form IN ('NFC', 'NFD', 'none')),
  key_case_fold       INTEGER NOT NULL CHECK (key_case_fold IN (0, 1)),
  key_path_separator  TEXT    NOT NULL CHECK (key_path_separator IN ('posix', 'as-is')),
  key_trim_slashes    INTEGER NOT NULL CHECK (key_trim_slashes IN (0, 1))
);

-- ----------------------------------------------------------------------------
-- 2. 走査
-- ----------------------------------------------------------------------------

CREATE TABLE scan_run (
  scan_id                    TEXT   PRIMARY KEY,
  source_id                  TEXT   NOT NULL REFERENCES source(source_id),
  started_at                 BIGINT NOT NULL,

  -- 走査の**開始**順（source 内の全順序）。beginScan の INSERT と同一
  -- トランザクションで採番する。started_at では順序が決まらない理由は
  -- completion_seq と同じで、固定時計のテストでは同値が既定になる。
  --
  -- **status に依存させないこと。** aborted_safety / failed で終わる走査も、
  -- 観測の時点では last_seen_scan_id を動かしています。「running か
  -- completion_seq が大きい走査」で代用すると、aborted で終わった後続が
  -- 見た文書が前の走査から墓標を立てられます。
  start_seq                  BIGINT NOT NULL,
  finished_at                BIGINT,
  status                     TEXT   NOT NULL
    CHECK (status IN ('running', 'completed', 'aborted_safety', 'failed')),

  enumerated_count           BIGINT NOT NULL DEFAULT 0 CHECK (enumerated_count >= 0),
  -- 安全弁が見るのはこちらだけ（#27）
  distinct_count             BIGINT NOT NULL DEFAULT 0 CHECK (distinct_count >= 0),

  -- 基準値は completed の走査からしか採れない（#3）。
  -- completed であることの強制は finishScan / promoteToCompleted の責務
  previous_completed_scan_id TEXT,
  previous_distinct_count    BIGINT NOT NULL DEFAULT 0 CHECK (previous_distinct_count >= 0),

  -- 9000 = 0.90。除算せず整数の交差積で比較する（0除算と NaN が構造的に消える）
  count_ratio_threshold_bp   BIGINT NOT NULL
    CHECK (count_ratio_threshold_bp BETWEEN 0 AND 10000),
  -- 1000 = 0.10
  missing_ratio_threshold_bp BIGINT NOT NULL
    CHECK (missing_ratio_threshold_bp BETWEEN 0 AND 10000),

  -- 0 でなければ削除判定フェーズに進めない（#16）
  write_failure_count        BIGINT NOT NULL DEFAULT 0 CHECK (write_failure_count >= 0),

  -- 一覧できなかった部分木の数。0 でなければ削除判定へ進めない。
  -- write_failure_count と違い、呼び出し側が完了時にまとめて渡すのではなく
  -- 走査中に recordUnlistableSubtree で積む。どのディレクトリが見えなかったかを
  -- observation に残すため（見えなかった範囲は監査の対象そのもの）
  unlistable_subtree_count   BIGINT NOT NULL DEFAULT 0
    CHECK (unlistable_subtree_count >= 0),

  -- 承認はこの走査にのみ効く。閾値そのものは書き換わらない（#28）
  approved_at                BIGINT,
  approved_note              TEXT,
  -- S4-3: 承認時の見立てより欠損が増えた走査を無条件には通さない。
  approved_max_missing_count BIGINT CHECK (approved_max_missing_count >= 0),

  -- 完了走査の全順序（#B-4）。finished_at だけでは同値が起こり、
  -- 固定時計のテストでは同値が例外ではなく既定になる。
  -- completed へ遷移する同一トランザクション内で採番する
  completion_seq             BIGINT,

  abort_reason               TEXT,

  -- **削除反映の状態。completed の走査だけが持つ（C1）。**
  --
  -- `completed` は「列挙と安全弁を通った」であって「削除を反映した」では
  -- ありません。finishScan の後、削除記録と tombstone は別々の書き込みとして
  -- 起きるので、その間の失敗で **基準値だけが進み、削除は未反映**という
  -- 状態が残ります。次の走査はその基準値で欠損率を測るため、同じ入力で
  -- 何度やっても aborted_safety になり、自力では戻れません（実測）。
  --
  --   pending    … 弁は通ったが、削除の反映がまだ終わっていない
  --   applied    … この走査の削除反映が最後まで終わった
  --   superseded … 後続の完了走査が反映を済ませたので、この走査の分は不要
  --
  -- 「completed かつ pending」の走査は、次の走査の**前に**反映を再開します。
  -- 再開の門は通常経路と同じ promoteToCompleted です（閾値は下げません）。
  deletion_state             TEXT
    CHECK (deletion_state IS NULL OR
           deletion_state IN ('pending', 'applied', 'superseded')),

  -- 基準走査が別 source から来る事故を塞ぐ（#3 の変種）
  UNIQUE (scan_id, source_id),
  FOREIGN KEY (previous_completed_scan_id, source_id)
    REFERENCES scan_run(scan_id, source_id),

  -- 重複除去後の件数が総件数を超えることはあり得ない（#27）
  CHECK (distinct_count <= enumerated_count),
  -- running な走査に終了時刻はなく、終わった走査には必ずある
  CHECK ((status = 'running') = (finished_at IS NULL)),
  -- 完了走査だけが順序番号を持つ
  CHECK ((status = 'completed') = (completion_seq IS NOT NULL)),
  -- 完了走査だけが削除反映の状態を持つ。completed が何の完了かを行の形で示す
  CHECK ((status = 'completed') = (deletion_state IS NOT NULL)),
  -- 承認は時刻と理由が揃って初めて記録とみなす（#28）
  CHECK ((approved_at IS NULL) = (approved_note IS NULL)),
  CHECK ((approved_at IS NULL) = (approved_max_missing_count IS NULL)),
  -- 安全弁で止まった走査には理由が必ず残る
  CHECK (status <> 'aborted_safety' OR abort_reason IS NOT NULL)
);

-- 同一 source で running な走査は同時に1件（#1 / AGENTS.md 7節）
CREATE UNIQUE INDEX idx_one_running_scan
  ON scan_run(source_id) WHERE status = 'running';

-- 完了順は source 内で一意（#B-4）
CREATE UNIQUE INDEX idx_scan_completion_seq
  ON scan_run(source_id, completion_seq) WHERE completion_seq IS NOT NULL;

-- 開始順も source 内で一意。部分索引にしないのは、start_seq が
-- status に依らず全走査に付くため（攻撃 #1）
CREATE UNIQUE INDEX idx_scan_start_seq
  ON scan_run(source_id, start_seq);

CREATE INDEX idx_scan_run_source_finished
  ON scan_run(source_id, finished_at);

-- ----------------------------------------------------------------------------
-- 3. Document（可変）
-- ----------------------------------------------------------------------------

CREATE TABLE document (
  document_id         TEXT   PRIMARY KEY,
  source_id           TEXT   NOT NULL REFERENCES source(source_id),
  stable_key          TEXT   NOT NULL,
  state               TEXT   NOT NULL
    CHECK (state IN ('active', 'tombstoned', 'quarantined')),

  -- SINGLE_ACTIVE_VERSION は「列が1本しかない」ことで構造的に保証される。
  -- active でも版を持たない場合がある（#17: 列挙できたが読めなかった）ため
  -- NOT NULL にはしない
  active_version_id   TEXT,

  first_seen_at       BIGINT NOT NULL,
  last_seen_at        BIGINT NOT NULL,
  last_seen_scan_id   TEXT   NOT NULL REFERENCES scan_run(scan_id),

  -- hash 取得スキップ判断用の弱い指紋。Document は可変なのでここが正しい置き場所（#18）
  last_fingerprint    TEXT,
  last_fingerprint_at BIGINT,

  tombstoned_at       BIGINT,

  -- 同一 source 内で stableKey は一意。documentId はここから導出される
  UNIQUE (source_id, stable_key),

  -- >>> 唯一の前方参照。PostgreSQL ではこの1本だけを ALTER TABLE で後付けする <<<
  --     単一列の FK では d2 が d1 の版を指せてしまう（実測確認済み）。
  --     複合 FK にすることで、指せる版が自分の文書のものに限定される
  FOREIGN KEY (active_version_id, document_id)
    REFERENCES document_version(version_id, document_id)
    DEFERRABLE INITIALLY DEFERRED,
  -- >>> ここまで <<<

  -- 復活時に tombstonedAt が残って内部矛盾になる事故を型ではなく DB で潰す（#25）
  CHECK ((state = 'tombstoned') = (tombstoned_at IS NOT NULL)),
  CHECK ((last_fingerprint IS NULL) = (last_fingerprint_at IS NULL))
);

CREATE INDEX idx_document_source_state ON document(source_id, state);
CREATE INDEX idx_document_last_seen    ON document(source_id, last_seen_scan_id);

-- ----------------------------------------------------------------------------
-- 4. DocumentVersion（不変）
-- ----------------------------------------------------------------------------

CREATE TABLE document_version (
  version_id            TEXT   PRIMARY KEY,
  document_id           TEXT   NOT NULL REFERENCES document(document_id)
                                 DEFERRABLE INITIALLY DEFERRED,

  -- 生バイト列の sha256。正規化後テキストのハッシュを入れることは
  -- このプロジェクトで最も重大な誤り（AGENTS.md 3.1）
  content_hash          TEXT   NOT NULL,
  size_bytes            BIGINT NOT NULL CHECK (size_bytes >= 0),
  blob_key              TEXT   NOT NULL,

  -- NOT NULL であること自体が NO_VERSION_WITHOUT_VERIFIED_BLOB の強制（#8, #21）
  blob_verified_at      BIGINT NOT NULL,

  mime_type             TEXT   NOT NULL,
  source_modified_at    BIGINT,
  ingested_at           BIGINT NOT NULL,
  discovered_by_scan_id TEXT   NOT NULL REFERENCES scan_run(scan_id),
  pipeline_version      TEXT   NOT NULL,

  -- versionId = sha256("ver:" + documentId + contentHash) なので、
  -- この組は版を一意に決める。重複行は ID 導出が壊れた証拠になる。
  -- ACL_DOES_NOT_VERSION の構造的な受け皿でもある（AGENTS.md 3.4）
  UNIQUE (document_id, content_hash),
  -- document.active_version_id の複合 FK の参照先
  UNIQUE (version_id, document_id)
);

CREATE INDEX idx_version_document ON document_version(document_id);

-- 「この表に対する UPDATE 文は1本も存在してはいけない」を規約から制約へ格上げする。
-- PostgreSQL では BEFORE UPDATE トリガ関数 + RAISE EXCEPTION で同義
CREATE TRIGGER trg_document_version_immutable
BEFORE UPDATE ON document_version
BEGIN
  SELECT RAISE(ABORT, 'document_version is immutable');
END;

-- ----------------------------------------------------------------------------
-- 5. ACL（独立した次元。version を作らない）
-- ----------------------------------------------------------------------------
--
-- ファイルが1バイトも変わらないまま権限だけ変わる場合、
-- contentHash は同じで新版も生まれない。だから ACL は別表になる（AGENTS.md 3.4）。
--
-- なお UNIQUE(document_id, content_hash) が防ぐのは「同じ hash で2行できること」だけ。
-- contentHash の計算入力に ACL が混ざる経路は静的検査では捕まらないので、
-- upsertAcl の遷移検査（AC-ACL-02）で見る。

CREATE TABLE access_control (
  document_id     TEXT NOT NULL REFERENCES document(document_id),
  tenant_id       TEXT NOT NULL,

  -- 取得失敗を principals=[] で表現させないための列（#29）
  state           TEXT NOT NULL CHECK (state IN ('synced', 'unknown')),

  -- JSON 配列。書き込み側は必ず昇順で正規化して入れる（比較の安定のため）
  principals      TEXT NOT NULL,
  classification  TEXT,
  acl_hash        TEXT NOT NULL,

  synced_at       BIGINT,
  last_attempt_at BIGINT,
  last_error      TEXT,

  PRIMARY KEY (document_id, tenant_id),

  -- synced を名乗るなら同期時刻が必ずある。unknown の principals は無意味なので空
  CHECK (state <> 'synced' OR synced_at IS NOT NULL),
  CHECK (state <> 'unknown' OR principals = '[]')
);

-- ----------------------------------------------------------------------------
-- 6. Derivation / Artifact
-- ----------------------------------------------------------------------------
--
-- 「行が存在する」を完了の証拠にしないため、artifact_count と outputs_hash を持つ。
-- 完了の証拠は Derivation + 全 Artifact + run 完了が同一トランザクションで
-- 成立していること（#9, #10, #11 / AGENTS.md 3.7）。

CREATE TABLE derivation (
  derivation_key    TEXT   PRIMARY KEY,
  processor_name    TEXT   NOT NULL,
  processor_version TEXT   NOT NULL,
  config_hash       TEXT   NOT NULL,
  -- JSON 配列。derivationKey に入ったソート済みの順序をそのまま保つ
  input_ids         TEXT   NOT NULL,
  root_version_id   TEXT   NOT NULL REFERENCES document_version(version_id),
  document_id       TEXT   NOT NULL REFERENCES document(document_id),
  created_at        BIGINT NOT NULL,

  artifact_count    BIGINT NOT NULL CHECK (artifact_count >= 0),
  -- sha256("out:" + (artifactId + ":" + contentHash) を ordinal 順に \x00 連結)
  outputs_hash      TEXT   NOT NULL
);

CREATE INDEX idx_derivation_root ON derivation(root_version_id);

CREATE TABLE artifact (
  artifact_id     TEXT   PRIMARY KEY,
  -- NO_ORPHAN_ARTIFACT。親を消せないことを FK で保証する
  derivation_key  TEXT   NOT NULL REFERENCES derivation(derivation_key)
                           DEFERRABLE INITIALLY DEFERRED,
  ordinal         BIGINT NOT NULL CHECK (ordinal >= 0),

  document_id     TEXT   NOT NULL REFERENCES document(document_id),
  root_version_id TEXT   NOT NULL REFERENCES document_version(version_id),

  type            TEXT   NOT NULL CHECK (type IN (
                    'parsed_document', 'normalized_document', 'chunk', 'metadata', 'fact',
                    'summary', 'embedding_record', 'quality_report')),
  inline_content  TEXT,
  blob_key        TEXT,
  content_hash    TEXT   NOT NULL,
  size_bytes      BIGINT NOT NULL CHECK (size_bytes >= 0),
  created_at      BIGINT NOT NULL,

  -- 1回目の残骸と2回目の出力が和集合になる事故を防ぐ（#10）
  UNIQUE (derivation_key, ordinal),
  -- 中身の置き場所は inline か blob のどちらか一方
  CHECK ((inline_content IS NULL) <> (blob_key IS NULL))
);

CREATE INDEX idx_artifact_derivation ON artifact(derivation_key);

-- ----------------------------------------------------------------------------
-- 7. ProcessingRun（リース）
-- ----------------------------------------------------------------------------
--
-- derivation_key に FK を張らないのは意図的。
-- run はまだ derivation 行が存在しない時点で始まるため（commitDerivation が両方を書く）。

CREATE TABLE processing_run (
  run_id           TEXT   PRIMARY KEY,
  derivation_key   TEXT   NOT NULL,
  document_id      TEXT   NOT NULL REFERENCES document(document_id),
  root_version_id  TEXT   NOT NULL REFERENCES document_version(version_id),

  status           TEXT   NOT NULL
    CHECK (status IN ('pending', 'leased', 'succeeded', 'failed', 'abandoned')),
  attempt          BIGINT NOT NULL CHECK (attempt >= 1),

  worker_id        TEXT,
  -- すべてストアが付与する。ワーカーは時刻を送らない（#14）
  started_at       BIGINT,
  heartbeat_at     BIGINT,
  lease_expires_at BIGINT,
  finished_at      BIGINT,

  -- リースの長さ。heartbeat(runId, workerId) は期間を受け取らないので、
  -- 延長幅は claim 時に決まった値をここから読む。
  -- 呼び出し側が延長のたびに期間を渡せると、失効寸前のワーカーが
  -- 自分で寿命を伸ばせてしまう
  lease_seconds    BIGINT CHECK (lease_seconds IS NULL OR lease_seconds > 0),

  error_kind       TEXT,
  error_message    TEXT,
  permanent        INTEGER CHECK (permanent IN (0, 1)),

  -- リースを持つなら所有者と失効時刻と期間が必ずある（#13）
  CHECK (status <> 'leased'
         OR (worker_id IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_seconds IS NOT NULL))
);

-- 同一 derivationKey で leased な run は同時に1件（#12 / AGENTS.md 7節）
CREATE UNIQUE INDEX idx_one_leased_run
  ON processing_run(derivation_key) WHERE status = 'leased';

CREATE INDEX idx_run_lease_expiry ON processing_run(lease_expires_at)
  WHERE status = 'leased';

-- ----------------------------------------------------------------------------
-- 8. Observation（追記専用）
-- ----------------------------------------------------------------------------
--
-- 追記専用なので行数は増えて当然。IDEMPOTENT_REPLAY は行数を比較せず、
-- (kind, document_id) の集合だけを比較する（AGENTS.md 5節）。
--
-- **順序は observation_seq、同一性は observation_id。**
-- 事象 ID は UUIDv4（構造的に整列不能）で、occurred_at は同一トランザクション内の
-- 複数観測で必ず同値になる。しかも Clock を注入している以上、固定時計のテストでは
-- 同値が例外ではなく既定になる。scan_run.completion_seq を入れたのと同じ理由が
-- そのまま当てはまるので、追記順の全順序を列として持つ。
-- これが無いと、分岐検出（#10, #11）と失効ワーカーの拒否（#13）の前後関係が
-- 監査から復元できない。
--
-- 「事象 ID を比較や整列に使わない」規約はこれで無傷のまま維持される。
-- 整列したいコードは observation_seq を見るしかない。
--
-- PostgreSQL では observation_seq BIGSERIAL PRIMARY KEY。
-- SQLite の AUTOINCREMENT は rowid の再利用を禁じる指定で、
-- 追記専用表の順序が削除後に巻き戻らないことを保証する。

CREATE TABLE observation (
  observation_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id TEXT   NOT NULL UNIQUE,
  kind           TEXT   NOT NULL CHECK (kind IN (
                   'document_discovered', 'version_created', 'version_reverted',
                   'document_missing', 'document_tombstoned', 'document_revived',
                   'scan_aborted_safety', 'scan_approved_by_operator',
                   'rename_candidate_detected', 'rename_needs_recheck',
                   'acl_changed', 'acl_fetch_failed', 'run_failed', 'quarantined',
                   'document_unreadable', 'size_mismatch_rejected',
                   'fingerprint_collision', 'entry_skipped', 'orphaned_source_detected',
                   'stale_worker_rejected', 'derivation_output_divergence',
                   'blob_reference_broken', 'subtree_unlistable',
                   'stable_key_collision')),
  document_id    TEXT   REFERENCES document(document_id),
  version_id     TEXT   REFERENCES document_version(version_id),
  scan_id        TEXT   REFERENCES scan_run(scan_id),
  run_id         TEXT   REFERENCES processing_run(run_id),
  occurred_at    BIGINT NOT NULL,
  detail         TEXT   NOT NULL
);

CREATE INDEX idx_observation_kind_document ON observation(kind, document_id);
CREATE INDEX idx_observation_scan          ON observation(scan_id);

-- ----------------------------------------------------------------------------
-- 9. RenameCandidate（記録のみ。自動統合はしない）
-- ----------------------------------------------------------------------------
--
-- 同一内容のファイルが複数ある環境では hash 一致がリネームを意味しない。
-- 誤統合は系譜を破壊するため v0.1 は記録だけする（KNOWN_LIMITATIONS.md 3節）。

CREATE TABLE rename_candidate (
  disappeared_document_id TEXT   NOT NULL REFERENCES document(document_id),
  appeared_document_id    TEXT   NOT NULL REFERENCES document(document_id),
  content_hash            TEXT   NOT NULL,
  observed_at             BIGINT NOT NULL,
  resolution              TEXT   NOT NULL CHECK (resolution IN (
                            'unresolved', 'confirmed_rename', 'rejected', 'needs_recheck')),

  PRIMARY KEY (disappeared_document_id, appeared_document_id)
);
