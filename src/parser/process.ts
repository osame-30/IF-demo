/** 解析中の例外や暴走をUIプロセスの完了と混同しない。 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseDocumentResult } from "../domain/parsed-document.ts";
import type { ParsedDocument } from "../domain/parsed-document.ts";
import { LIMITS } from "./limits.ts";

// 第三者の解析依存を親プロセスへimportしない。制限と版は鍵の材料にも含める。
export const PARSER_CONFIG = { schema: 1, ...LIMITS, dependencies: { yauzl: "3.4.0", saxes: "6.0.0" } };
export const PARSER_VERSION = "office-xml-9";
export class ParserFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export async function parseInChildProcess(bytes: Buffer, format: "docx" | "xlsx"): Promise<ParsedDocument> {
  if (bytes.length > PARSER_CONFIG.inputBytes) throw new ParserFailure("limit_exceeded", "原本が20MiBを超えています。");
  const response = await new Promise<{ stdout: string; failed: boolean }>((resolve, reject) => {
    const child = execFile(process.execPath, ["--max-old-space-size=256", "--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./worker.ts", import.meta.url)), format], {
      encoding: "utf8", timeout: PARSER_CONFIG.timeoutMs, maxBuffer: PARSER_CONFIG.outputBytes + 1024, windowsHide: true,
    }, (error, stdout) => {
      if (error && (!stdout || error.killed || error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) reject(new ParserFailure("parser_stopped", "解析が制限時間・出力量を超えたか、子プロセスが停止しました。資料を確認して再試行してください。"));
      else resolve({ stdout, failed: error !== null });
    });
    // 入力を拒否した子へのEPIPEは終了応答側で判定する。別の成功にはしない。
    child.stdin!.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") reject(error); });
    child.stdin!.end(bytes);
  });
  const value: unknown = JSON.parse(response.stdout);
  if (!value || typeof value !== "object") throw new ParserFailure("invalid_response", "解析結果の形式が不正です。");
  if ("error" in value) {
    const error = value.error;
    if (error && typeof error === "object" && "code" in error && "message" in error && typeof error.code === "string" && typeof error.message === "string") throw new ParserFailure(error.code, error.message);
    throw new ParserFailure("invalid_response", "解析失敗の形式が不正です。");
  }
  if (!("result" in value)) throw new ParserFailure("invalid_response", "解析結果がありません。");
  if (response.failed) throw new ParserFailure("parser_stopped", "子プロセスが正常終了していないため、解析結果を確定しません。");
  const result = parseDocumentResult(value.result);
  if (result.format !== format) throw new ParserFailure("invalid_response", "解析形式が一致しません。");
  return result;
}
