/** Opt-in native window smoke test against two unpacked candidates, using identical runtime bytes.
 * This verifies shell activation and pause intent, not browser binding or real desktop input.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { configureClient } from "../apps/windows/src/runtime.js";

if (process.platform !== "win32" || process.env.ABRIDGE_WINDOWS_LIVE !== "1")
  throw Error("Native shell checks require Windows and explicit ABRIDGE_WINDOWS_LIVE=1.");
const [oldPath, newPath] = process.argv.slice(2).map((path) => resolve(path));
if (!oldPath || !newPath) throw Error("Provide old and new unpacked package directories.");
async function inventory(directory: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name === "runtime-manifest.json") continue;
    const path = join(directory, item.name),
      name = prefix + item.name;
    if (item.isDirectory()) Object.assign(result, await inventory(path, name + "/"));
    else
      result[name] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
  }
  return result;
}
assert.deepEqual(await inventory(join(oldPath, "runtime")), await inventory(join(newPath, "runtime")));
const temp = await mkdtemp(join(tmpdir(), "abridge-native-shell-"));
// No real account or device authorization; refused loopback endpoint exercises offline pause persistence.
const state = join(temp, "shared-state");
await configureClient(state, {
  url: "http://127.0.0.1:1",
  device_key: "abr_device_shell_fixture",
  capabilities: { screen: false, input: false, shell: false, files: false },
});
await mkdir(join(state, "windows-ui"), { recursive: true });
await writeFile(join(state, "windows-ui/native-preferences.json"), '{"theme":2}');
const script = join(temp, "check.ps1");
await writeFile(
  script,
  `
param([string]$Old,[string]$New,[string]$State)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NativeShellCheck {
 public delegate bool EnumProc(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback,IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint msg,IntPtr w,IntPtr l);
 public static IntPtr Find(int pid) {
  IntPtr found=IntPtr.Zero;
  EnumWindows((h,p)=>{uint owner; GetWindowThreadProcessId(h,out owner); var title=new StringBuilder(256); GetWindowText(h,title,256); if(owner==pid && title.ToString()=="aBridge") found=h; return true;},IntPtr.Zero);
  return found;
 }
}
'@
function Wait-For([scriptblock]$Condition,[string]$Message) {
 $until=[DateTime]::UtcNow.AddSeconds(20)
 do { if (& $Condition) {return}; Start-Sleep -Milliseconds 50 } while([DateTime]::UtcNow -lt $until)
 throw $Message
}
function Run-Pair([string]$First,[string]$Second) {
 $process=$null
 try {
  $process=Start-Process -FilePath (Join-Path $First 'aBridge.exe') -ArgumentList @('--state-dir',('"'+$State+'"')) -WindowStyle Hidden -PassThru
  Wait-For { [NativeShellCheck]::Find($process.Id) -ne [IntPtr]::Zero } 'Primary shell did not create its window'
  $window=[NativeShellCheck]::Find($process.Id)
  [void][NativeShellCheck]::PostMessage($window,0x10,[IntPtr]::Zero,[IntPtr]::Zero)
  Wait-For { -not [NativeShellCheck]::IsWindowVisible($window) } 'Close did not hide to tray'
  $secondProcess=Start-Process -FilePath (Join-Path $Second 'aBridge.exe') -ArgumentList @('--state-dir',('"'+$State.ToUpperInvariant()+'/"')) -WindowStyle Hidden -PassThru
  if(-not $secondProcess.WaitForExit(10000)){ Stop-Process -Id $secondProcess.Id -Force; throw 'Cross-version mutex failed' }
  Wait-For { [NativeShellCheck]::IsWindowVisible($window) } 'Second instance did not activate first shell'
  Wait-For { Test-Path -LiteralPath (Join-Path $State 'control-auth.json') } 'Runtime did not open local control'
  Start-Sleep -Milliseconds 500
  [void][NativeShellCheck]::PostMessage($window,0x312,[IntPtr]1,[IntPtr]::Zero)
  Wait-For { (Get-Content -LiteralPath (Join-Path $State 'config.json') -Raw | ConvertFrom-Json).paused -eq $true } 'Pause shortcut did not persist pause'
  [void][NativeShellCheck]::PostMessage($window,0x312,[IntPtr]1,[IntPtr]::Zero)
  Start-Sleep -Milliseconds 750
  if(-not (Get-Content -LiteralPath (Join-Path $State 'config.json') -Raw | ConvertFrom-Json).paused){throw 'Repeated pause shortcut resumed client'}
  Write-Output ('PASS: '+$First+' -> '+$Second+' hide, mutual exclusion, activation, pause-only shortcut')
 } finally {
  if($process -and -not $process.HasExited){Stop-Process -Id $process.Id -Force}
  # The real host observes pipe/parent loss and cleans its children. This is cleanup, not graceful-quit acceptance.
  Start-Sleep -Seconds 3
 }
}
Run-Pair $Old $New
Run-Pair $New $Old
`,
  "utf8",
);
try {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-Old",
      oldPath,
      "-New",
      newPath,
      "-State",
      state,
    ],
    {
      windowsHide: true,
      encoding: "utf8",
      timeout: 90000,
    },
  );
  process.stdout.write(result.stdout ?? "");
  if (result.status !== 0) {
    const diagnostic = spawnSync(
      join(oldPath, "runtime/node.exe"),
      [join(oldPath, "runtime/cli.js"), "status", "--state-dir", state],
      { windowsHide: true, encoding: "utf8" },
    );
    process.stderr.write(diagnostic.stdout + diagnostic.stderr);
  }
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(
    JSON.parse(await readFile(join(state, "windows-ui/native-preferences.json"), "utf8")).theme,
    2,
  );
  console.log("Identical packaged runtime, legacy preferences and bidirectional shell smoke checks passed.");
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
