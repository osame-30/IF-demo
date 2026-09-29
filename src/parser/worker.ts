/** 入力バイトだけを渡す一回限りの子プロセス。OSの権限を隔離するsandboxではない。 */
import { ParseError, parseOffice } from "./office.ts";
import { LIMITS } from "./limits.ts";
try {
  const format = process.argv[2];
  if (format !== "docx" && format !== "xlsx") throw new ParseError("unsupported_format", "最初の対応形式は .docx と .xlsx です。");
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > LIMITS.inputBytes) throw new ParseError("limit_exceeded", "原本が20MiBを超えています。");
    chunks.push(bytes);
  }
  process.stdout.write(JSON.stringify({ result: await parseOffice(Buffer.concat(chunks), format) }));
} catch (error) {
  const failure = error instanceof ParseError ? error : new ParseError("parser_failed", "解析処理が終了しました。資料を確認して再試行してください。");
  process.stdout.write(JSON.stringify({ error: { code: failure.code, message: failure.message } }));
  process.exitCode = 1;
}
