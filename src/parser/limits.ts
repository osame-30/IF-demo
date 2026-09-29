/** 実行上限も設定の同一性に含め、上限の変更が古い成果物の再利用にならないようにする。 */
export const LIMITS = { inputBytes: 20 * 1024 * 1024, expandedBytes: 32 * 1024 * 1024, entries: 2000, nodes: 200000, depth: 64, cells: 20000, blocks: 20000, outputBytes: 8 * 1024 * 1024, timeoutMs: 30000 };
