/**
 * 攻撃 #29 — ACL 取得のタイムアウトが「制限なし」にも「全断」にもなりうる。
 *
 * 元の穴: `fetchAcl` がタイムアウトしたとき、`principals=[]` で
 * `AccessControl` を upsert する実装がありました。空の `principals` は
 * 意味が未定義で、それを「制限なし」と読む下流には**漏洩**が、
 * 「全拒否」と読む下流には**全断**が起きました。行が存在しないことの
 * 意味も未定義のままでした。
 *
 * 防御（型としては既に入っている）: `AccessControl.state` に
 * `"synced" | "unknown"` を持たせ、取得失敗は既存 ACL を**上書きしない**。
 * `state: "unknown"` の `principals` は必ず空という制約で、
 * 空配列を「制限なし」とも「全拒否」とも解釈させない。
 * `SqliteLineageStore.upsertAcl` はこの規則を既に実装している
 * （既存が "synced" で新規が "unknown" なら principals を据え置き、
 * `lastAttemptAt` / `lastError` だけを更新する）。
 *
 * **なぜ v0.1 で deferred なのか**: v0.1 のローカルFS アダプタは
 * `fetchAcl` を実装しません。すべての `AccessControl` 行は
 * `state: "unknown"` にしかなりえず、タイムアウトという事象そのものが
 * v0.1 の経路に存在しません（KNOWN_LIMITATIONS.md 5節「ACL 関連（範囲外）」）。
 * `upsertAcl` の型と規則は前借りして正しくしてありますが、
 * `fetchAcl` を呼ぶ機構は前借りしません（KNOWN_LIMITATIONS.md 冒頭の
 * 「型は直す / 機構は作らない」区分）。
 */

import type { InvariantName } from "../../../src/domain/types.ts";
import type { FixtureContext } from "../context.ts";

export const assertions: ReadonlyArray<InvariantName> = ["ACL_DOES_NOT_VERSION"];

/** deferred の理由。ランナーがこれを見て it.skip にする */
export const deferred =
  "v0.1 のローカルFS アダプタは fetchAcl を実装しない（KNOWN_LIMITATIONS.md 5節）";

export async function setup(_ctx: FixtureContext): Promise<void> {}
export async function execute(_ctx: FixtureContext): Promise<void> {}
