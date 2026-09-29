/** 参照ボタン用。このPCの画面にWindows標準のフォルダ選択を出し、選ばれたパスだけを返す。登録はしない。 */
import { spawn } from "node:child_process";
import { join, posix, win32 } from "node:path";

/** 未選択は null。signal の中断で選択画面を閉じる。 */
export type FolderPicker = (signal: AbortSignal) => Promise<string | null>;

/** 子プロセスの出力は `OK:<UTF-8のbase64>` か `CANCEL` の1つだけ。コンソールの文字コードに依存しない。 */
export function parsePickerOutput(stdout: string, platform: NodeJS.Platform = process.platform): string | null {
  const text = stdout.trim();
  if (text === "CANCEL") return null;
  const match = /^OK:([A-Za-z0-9+/]+={0,2})$/.exec(text);
  if (!match) throw new Error("フォルダの選択結果を読み取れません");
  const bytes = Buffer.from(match[1]!, "base64");
  if (bytes.toString("base64") !== match[1]) throw new Error("フォルダの選択結果を読み取れません");
  const path = bytes.toString("utf8");
  if (!(platform === "win32" ? win32 : posix).isAbsolute(path)) throw new Error("選択結果が絶対パスではありません");
  return path;
}

/** C#ソースを一時ファイル経由でコンパイルするため、日本語は \u エスケープで渡す。 */
const csharpString = (value: string) => [...value].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");

// 新しい形式（エクスプローラーと同じ見た目）の選択画面。所有者を最前面の見えない窓にして、ブラウザの後ろに隠れにくくする。
const SCRIPT = `$ErrorActionPreference = 'Stop'
try {
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;
namespace IngestionFrame {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogCoClass {}
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, [In] ref Guid bhid, [In] ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, out IntPtr ppszName);
  }
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName(out IntPtr pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
  }
  public static class FolderDialog {
    const int Cancelled = unchecked((int)0x800704C7);
    public static string Pick() {
      using (var owner = new Form()) {
        owner.TopMost = true; owner.ShowInTaskbar = false; owner.FormBorderStyle = FormBorderStyle.None;
        owner.StartPosition = FormStartPosition.CenterScreen; owner.Size = new System.Drawing.Size(1, 1); owner.Opacity = 0;
        owner.Show(); owner.Activate();
        var dialog = (IFileDialog)new FileOpenDialogCoClass();
        uint options; dialog.GetOptions(out options);
        dialog.SetOptions(options | 0x20 | 0x40 | 0x8); // PICKFOLDERS | FORCEFILESYSTEM | NOCHANGEDIR
        dialog.SetTitle("${csharpString("接続するフォルダを選択")}");
        dialog.SetOkButtonLabel("${csharpString("このフォルダを選ぶ")}");
        int hr = dialog.Show(owner.Handle);
        if (hr == Cancelled) return null;
        Marshal.ThrowExceptionForHR(hr);
        IShellItem item; dialog.GetResult(out item);
        IntPtr name; item.GetDisplayName(0x80058000, out name); // SIGDN_FILESYSPATH
        try { return Marshal.PtrToStringUni(name); } finally { Marshal.FreeCoTaskMem(name); }
      }
    }
  }
}
'@
$path = [IngestionFrame.FolderDialog]::Pick()
if ($null -eq $path) { [Console]::Out.Write('CANCEL') } else { [Console]::Out.Write('OK:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($path))) }
} catch {
[Console]::Out.Write('ERR:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.Message)))
exit 1
}
`;

export function windowsFolderPicker(): FolderPicker {
  // PATH上の同名プログラムを拾わないよう、システムのPowerShellを絶対パスで起動する。
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");
  return (signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
      windowsHide: true, stdio: ["ignore", "pipe", "ignore"], signal,
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { if (stdout.length < 65536) stdout += chunk; });
    // DF-14: abortのerrorイベントだけでは子の終了前。closeまで選択枠を保持する。
    let failureToRun: Error | undefined;
    child.on("error", (error) => { failureToRun = error; });
    child.on("close", (code) => {
      if (signal.aborted) { reject(signal.reason instanceof Error ? signal.reason : new Error("選択を中断しました")); return; }
      if (failureToRun) { reject(failureToRun); return; }
      const failure = /^ERR:([A-Za-z0-9+/=]*)$/.exec(stdout.trim());
      if (failure) { reject(new Error(Buffer.from(failure[1]!, "base64").toString("utf8") || "理由不明")); return; }
      if (code !== 0) { reject(new Error("PowerShellを実行できませんでした。管理端末の制限を確認するか、パスを直接入力してください")); return; }
      try { resolve(parsePickerOutput(stdout, "win32")); } catch (error) { reject(error); }
    });
  });
}
