/**
 * 型の到達経路の走査。**AC-CLK-01 と AC-KEY-01 が共有します。**
 *
 * 「`LineageStore` の引数から型 T に到達する経路をすべて集める」という
 * 同じ問いが2つあります。**別々に実装すると、閉包の定義が2つできます。**
 * 片方だけが型別名をたどる、片方だけが継承をたどる、という食い違いは
 * 「経路ごとに別の閉包を持つ」ことそのもので、この改訂で潰した形です
 * （AGENTS.md 9節 軸1 / KNOWN_LIMITATIONS 12節と同じ族）。
 *
 * 走査の性質:
 *   - `types.ts` 内で解決できる型参照だけをたどる（外部の型は葉として扱う）
 *   - `interface` は継承も含めて全メンバーへ潜る
 *   - **型別名もたどる。** `VerifiedAt = Attested<EpochMs, ...>` のように
 *     目的の型がブランドの下に隠れると、たどらない走査は1件も見つけません
 *   - 総称の別名（`Brand` / `Attested`）は本体に型変数しか無いので、実引数を見る
 *   - 循環は `seen` で止める。同じ型に2度入っても新しい経路は出ない
 */

import { readFileSync } from "node:fs";
import ts from "typescript";

export function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ES2023, true);
}

export interface TypeIndex {
  interfaces: Map<string, ts.InterfaceDeclaration>;
  aliases: Map<string, ts.TypeAliasDeclaration>;
}

export function indexOf(source: ts.SourceFile): TypeIndex {
  const interfaces = new Map<string, ts.InterfaceDeclaration>();
  const aliases = new Map<string, ts.TypeAliasDeclaration>();
  source.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node)) interfaces.set(node.name.text, node);
    else if (ts.isTypeAliasDeclaration(node)) aliases.set(node.name.text, node);
  });
  return { interfaces, aliases };
}

/** ある型の中で `target` に到達する経路をすべて集める */
export function findPaths(
  target: string,
  type: ts.TypeNode | undefined,
  index: TypeIndex,
  path: string,
  seen: ReadonlySet<string>,
): string[] {
  if (type === undefined) return [];

  // 配列と ReadonlyArray は要素型へ潜る。経路名に添字は入れない
  if (ts.isArrayTypeNode(type)) return findPaths(target, type.elementType, index, path, seen);

  if (ts.isTypeReferenceNode(type)) {
    const name = ts.isIdentifier(type.typeName) ? type.typeName.text : "";
    if (name === target) return [path];
    if (
      name === "ReadonlyArray" ||
      name === "Array" ||
      name === "Promise" ||
      name === "AsyncIterable" ||
      name === "Readonly"
    ) {
      return findPaths(target, type.typeArguments?.[0], index, path, seen);
    }

    const alias = index.aliases.get(name);
    if (alias !== undefined && !seen.has(name)) {
      const next = new Set([...seen, name]);
      // 総称の別名は本体に型変数しか無いので実引数を見る。素の別名は本体をたどる
      return (alias.typeParameters?.length ?? 0) > 0
        ? (type.typeArguments ?? []).flatMap((a) => findPaths(target, a, index, path, next))
        : findPaths(target, alias.type, index, path, next);
    }

    const declaration = index.interfaces.get(name);
    if (declaration === undefined || seen.has(name)) return [];
    return membersOf(target, declaration, index, path, new Set([...seen, name]));
  }

  if (ts.isTypeLiteralNode(type)) return literalMembers(target, type.members, index, path, seen);

  if (ts.isUnionTypeNode(type) || ts.isIntersectionTypeNode(type)) {
    return type.types.flatMap((t) => findPaths(target, t, index, path, seen));
  }

  return [];
}

function membersOf(
  target: string,
  declaration: ts.InterfaceDeclaration,
  index: TypeIndex,
  path: string,
  seen: ReadonlySet<string>,
): string[] {
  const inherited = (declaration.heritageClauses ?? []).flatMap((clause) =>
    clause.types.flatMap((expr) => {
      const name = ts.isIdentifier(expr.expression) ? expr.expression.text : "";
      const parent = index.interfaces.get(name);
      return parent === undefined || seen.has(name)
        ? []
        : membersOf(target, parent, index, path, new Set([...seen, name]));
    }),
  );
  return [...inherited, ...literalMembers(target, declaration.members, index, path, seen)];
}

function literalMembers(
  target: string,
  members: ts.NodeArray<ts.TypeElement>,
  index: TypeIndex,
  path: string,
  seen: ReadonlySet<string>,
): string[] {
  return members.flatMap((member) => {
    if (!ts.isPropertySignature(member) || member.name === undefined) return [];
    return findPaths(target, member.type, index, `${path}.${member.name.getText()}`, seen);
  });
}

/**
 * `interface` の各メソッドの引数から `target` に到達する経路。
 * 形式は `メソッド名: 引数からの経路`。
 */
export function parameterPathsTo(
  target: string,
  declaration: ts.InterfaceDeclaration,
  index: TypeIndex,
): string[] {
  const found: string[] = [];
  for (const member of declaration.members) {
    if (!ts.isMethodSignature(member) || member.name === undefined) continue;
    const method = member.name.getText();
    for (const parameter of member.parameters) {
      found.push(
        ...findPaths(target, parameter.type, index, parameter.name.getText(), new Set()).map(
          (p) => `${method}: ${p}`,
        ),
      );
    }
  }
  return found;
}
