/**
 * ダミー processor。Derivation 経路のトランザクション性を検証するためだけに存在します。
 *
 * v0.1 に Parser はありません（AGENTS.md 2節「絶対に作らないもの」）。
 * それでも `commitDerivation` の型を正しくしてあるのは、後から
 * `insertDerivationIfAbsent` を分解するのが全やり直しになるからです
 * （KNOWN_LIMITATIONS.md 2節「型は直す / 機構は作らない」）。
 * この processor は**機構ではなくテストの道具**です。入力を読みも書きもせず、
 * 入力の versionId から決まる固定の Artifact を N 件返すだけです。
 *
 * ## 3つのつまみ
 *
 * 攻撃 #9 / #10 / #11 は「同じ derivationKey で何が変わりうるか」を突きます。
 * それを再現するために、3つを独立に動かせるようにしてあります。
 *
 *   - `processorVersion` / `configHash` — **鍵が変わる**。別の派生になる
 *   - `artifactCount`  — 鍵は同じで**件数だけ**変わる（#10）
 *   - `contentSalt`    — 鍵も件数も同じで**内容だけ**変わる（#11）
 *
 * `contentSalt` が要るのは、#11 が「依存ライブラリの版が違う2台が同じキーを
 * 処理する」攻撃だからです。鍵の入力（processor 名・版・config・入力 ID）は
 * どちらの台でも同じなのに、出てくるバイト列が違う。
 * **鍵を変えずに内容だけを変えられなければ、この攻撃は再現できません。**
 *
 * 出力は入力の versionId から決まります。同じ入力に同じ出力を返さない
 * processor だと、DERIVATION_OUTPUT_STABLE が processor 自身の非決定性で
 * 落ちるようになり、何を検証しているのか分からなくなります。
 */

import { createHash } from "node:crypto";

import { attestContentHash } from "../../src/domain/evidence.ts";
import { derivationKey as deriveDerivationKey } from "../../src/domain/ids.ts";
import type {
  ArtifactDraft,
  ArtifactId,
  ContentHash,
  DerivationDraft,
  DerivationKey,
  VersionId,
} from "../../src/domain/types.ts";

export interface EchoOptions {
  /** 上げると別の派生になる。「Parser を上げた → 別キー → 再処理」の再現 */
  readonly processorVersion?: string;
  /** 変えると別の派生になる。「Chunker 設定を変えた → 別キー」の再現 */
  readonly configHash?: string;
  /** 生成する Artifact の件数。**鍵は変わらない**（#10） */
  readonly artifactCount?: number;
  /**
   * 内容だけを変える。**鍵も件数も変わらない**（#11）。
   * 依存ライブラリの版が違う2台が同じキーを処理する状況の再現。
   */
  readonly contentSalt?: string;
}

const PROCESSOR_NAME = "echo";

export class EchoProcessor {
  readonly processorName = PROCESSOR_NAME;
  readonly processorVersion: string;
  readonly configHash: string;
  readonly artifactCount: number;
  readonly #salt: string;

  constructor(options: EchoOptions = {}) {
    this.processorVersion = options.processorVersion ?? "1";
    this.configHash = options.configHash ?? "echo-config";
    this.artifactCount = options.artifactCount ?? 1;
    this.#salt = options.contentSalt ?? "";
  }

  /**
   * この processor がこの入力に対して持つ derivationKey。
   *
   * `commitDerivation` が内部で導出する値と**同じ式**で計算します。
   * `claimRun` に渡す鍵がこれと違うと、リースと派生が別の鍵で管理される
   * ことになり、テストが何を守っているのか分からなくなります。
   */
  keyFor(rootVersionId: VersionId): DerivationKey {
    return deriveDerivationKey({
      processorName: this.processorName,
      processorVersion: this.processorVersion,
      configHash: this.configHash,
      inputIds: [rootVersionId],
    });
  }

  /**
   * `claimRun` に渡す鍵の材料。
   *
   * **鍵そのものは渡しません。** `claimRun` は材料を受け取って自分で導出します
   * （AGENTS.md 9節）。`keyFor` は「ストアが導出するはずの鍵」を
   * テスト側で言い当てて検算するために残してあります。
   */
  claimMaterialsFor(rootVersionId: VersionId): {
    processorName: string;
    processorVersion: string;
    configHash: string;
    inputIds: ReadonlyArray<VersionId>;
  } {
    return {
      processorName: this.processorName,
      processorVersion: this.processorVersion,
      configHash: this.configHash,
      inputIds: [rootVersionId],
    };
  }

  /**
   * `commitDerivation` に渡す材料。
   *
   * **原本も文書も渡しません（2026-09-10）。** `DerivationDraft` から
   * `rootVersionId` / `documentId` を外したので、ストアが run から決めます。
   * 引数に `rootVersionId` が残っているのは `inputIds` の材料としてです。
   */
  draftFor(args: { rootVersionId: VersionId }): DerivationDraft {
    return {
      processorName: this.processorName,
      processorVersion: this.processorVersion,
      configHash: this.configHash,
      inputIds: [args.rootVersionId],
    };
  }

  /**
   * 出力。入力の versionId と salt から決まるので、同じ条件なら必ず同じ列になります。
   * `artifactId` は渡しません。derivationKey と ordinal からストアが導出します。
   */
  run(rootVersionId: VersionId): ArtifactDraft[] {
    return Array.from({ length: this.artifactCount }, (_, ordinal) => ({
      ordinal,
      type: "chunk" as const,
      // inline の枝は本文だけを渡す。hash と size はストアが導出する（2026-09-10）。
      // 以前はここで `attestContentHash` を呼んで渡していたが、
      // **証拠は本文と結ばれていない**ので、渡せること自体が穴だった
      kind: "inline" as const,
      content: this.textFor(rootVersionId, ordinal),
    }));
  }

  /** この processor が ordinal 番目に出す本文。検算に使う */
  textFor(rootVersionId: VersionId, ordinal: number): string {
    return `${this.#salt}chunk ${ordinal} of ${rootVersionId}`;
  }

  /** その本文についてストアが導出するはずのハッシュ。**独立に計算する** */
  hashFor(rootVersionId: VersionId, ordinal: number): ContentHash {
    return attestContentHash(Buffer.from(this.textFor(rootVersionId, ordinal), "utf8"));
  }
}

/**
 * `outputsHash` の独立再計算。
 *
 * 凍結仕様: sha256("out:" + (artifactId + ":" + contentHash) を ordinal 順に \x00 で連結)
 *
 * `src/domain/ids.ts` の実装を import しません。ストアが書いた値を
 * ストア自身の関数で検算しても何も証明できないためです
 * （`test/support/invariant-checker.ts` が同じ理由で同じことをしています）。
 */
export function expectedOutputsHash(
  entries: ReadonlyArray<{ artifactId: ArtifactId; contentHash: ContentHash }>,
): string {
  const preimage = `out:${entries.map((e) => `${e.artifactId}:${e.contentHash}`).join("\u0000")}`;
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}
