/**
 * import グラフの走査。**AC-EVD-01 と AC-IND-01 が共有します。**
 *
 * 「どのファイルがどのファイルに到達できるか」という同じ問いが2つあります。
 * 別々に実装すると閉包の定義が2つでき、片方だけが `import type` を数える、
 * 片方だけが推移を追う、という食い違いが起きます
 * （AGENTS.md 9節 軸1 / KNOWN_LIMITATIONS 12節と同じ族）。
 *
 * **`import type` も再エクスポートも数えます。** 型だけの import を値の import に
 * 変えるのは1文字の編集で、`export ... from` は包み直しそのものなので、
 * どちらも閉包の境界にできません。
 *
 * **静的 import しか見ません（既知の限界）。** 指定子が実行時に決まる
 * `import(\`./${path}\`)` はここに現れません。静的な包み直し
 * （`const mk = (s) => unsafeMint(s)` を別ファイルに置く形）は捕まえられます。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** リポジトリ相対、区切りは "/" 固定。Windows の "\\" が入ると比較が環境依存になる */
export const rel = (file: string): string => relative(ROOT, file).split("\\").join("/");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** `src/` と `test/` の全 .ts。リポジトリ相対パスで返す */
export function repoFiles(): string[] {
  return [...walk(join(ROOT, "src")), ...walk(join(ROOT, "test"))].map(rel);
}

/**
 * そのファイルが直接 import しているリポジトリ内ファイル。
 *
 * **再エクスポート（`export { X } from "..."`）も数えます。**
 * `import` だけを見ていたときは、逃げ道を `export ... from` で
 * 中継するファイルがグラフに現れませんでした（変異で実測）。
 * 包み直しの一種なので、同じ扱いにします。
 */
export function importsOf(file: string): string[] {
  const absolute = join(ROOT, file);
  const source = ts.createSourceFile(
    absolute,
    readFileSync(absolute, "utf8"),
    ts.ScriptTarget.ES2023,
    true,
  );
  const out: string[] = [];
  source.forEachChild((node) => {
    const spec =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : undefined;
    if (spec === undefined || !ts.isStringLiteral(spec) || !spec.text.startsWith(".")) return;
    out.push(rel(resolve(dirname(absolute), spec.text)));
  });
  return out;
}

/** `entry` から import をたどって到達できるファイルすべて（entry 自身は含まない） */
export function forwardClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [...importsOf(entry)];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    stack.push(...importsOf(next));
  }
  return seen;
}

/** `target` に import で到達できるファイルすべて（target 自身は含まない） */
export function reverseClosure(target: string, files: ReadonlyArray<string>): Set<string> {
  const reaching = new Set<string>();
  for (;;) {
    const before = reaching.size;
    for (const file of files) {
      if (file === target || reaching.has(file)) continue;
      const direct = importsOf(file);
      if (direct.some((d) => d === target || reaching.has(d))) reaching.add(file);
    }
    if (reaching.size === before) return reaching;
  }
}
