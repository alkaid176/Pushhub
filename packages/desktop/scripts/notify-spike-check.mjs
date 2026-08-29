#!/usr/bin/env node
// 05-03 Task 2 Spike 自动断言（winrt-toast-reborn 三 API 运行时实证）。
//
// 用法：node packages/desktop/scripts/notify-spike-check.mjs
// 流程：
//   1. 清空 %TEMP%/pushhub-spike-result.txt → spawn cargo run --example notify_spike
//   2. 等 SHOW Ok 标记（首次编译 winrt/windows 依赖树可能需数分钟）
//   3. PowerShell UIA 自动点击 toast（横幅期直查 CoreWindow；错过横幅则
//      Win+N 开通知中心再查；InvokePattern 优先，ClickablePoint+mouse_event 兜底）
//   4. 等 spike 进程自行退出（激活或 60s 超时后 REMOVE 收尾）
//   5. 断言结果文件含 SHOW Ok / ACTIVATED / REMOVE Ok → 输出 PASS/FAIL → 删临时文件
//
// 说明：横幅视觉呈现属人工观察项（不阻塞）；本脚本断言的是结果文件标记 +
// API 返回值——与计划的自动化断言口径一致。

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tauriDir = path.resolve(here, "..", "src-tauri");
const resultFile = path.join(os.tmpdir(), "pushhub-spike-result.txt");

const readResult = () => {
  try {
    return fs.readFileSync(resultFile, "utf8");
  } catch {
    return "";
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[spike-check] ${msg}`);

// ---- PowerShell：UIA 查找并点击 toast（单次尝试）----
const PS_CLICK = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$target = $null
if ($wins) {
  foreach ($w in $wins) {
    if ($w.Current.ClassName -ne 'Windows.UI.Core.CoreWindow') { continue }
    foreach ($name in @('PushHub Spike', 'activation probe')) {
      $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
      $el = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
      if ($el) { $target = $el; break }
    }
    if ($target) { break }
  }
}
if (-not $target) { Write-Output 'CLICK NOT_FOUND'; exit 0 }
$invoke = $null
if ($target.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
  $invoke.Invoke(); Write-Output 'CLICK INVOKE_OK'; exit 0
}
try {
  $pt = $target.GetClickablePoint()
  Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint data, UIntPtr extra);' -Name U32 -Namespace PushHubSpike
  [PushHubSpike.U32]::SetCursorPos([int]$pt.X, [int]$pt.Y)
  Start-Sleep -Milliseconds 150
  [PushHubSpike.U32]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
  [PushHubSpike.U32]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
  Write-Output 'CLICK POINT_OK'; exit 0
} catch { Write-Output 'CLICK FAILED'; exit 0 }
`;

// ---- PowerShell：Win+N 开/关通知中心（toggle）----
const PS_CENTER = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);' -Name K -Namespace PushHubSpike
[PushHubSpike.K]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
[PushHubSpike.K]::keybd_event(0x4E, 0, 0, [UIntPtr]::Zero)
[PushHubSpike.K]::keybd_event(0x4E, 0, 2, [UIntPtr]::Zero)
[PushHubSpike.K]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)
Write-Output 'CENTER TOGGLED'
`;

function runPs(script) {
  const r = spawnSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], { encoding: "utf8", timeout: 30000 });
  return (r.stdout || "") + (r.stderr || "");
}

async function attemptClick() {
  // 横幅期（toast 弹出后约 5-7 秒）
  for (let i = 1; i <= 3; i++) {
    const out = runPs(PS_CLICK);
    const last = out.trim().split("\n").pop();
    log(`banner click attempt ${i}/3: ${last}`);
    if (/CLICK (INVOKE_OK|POINT_OK)/.test(out)) return true;
    await sleep(2000);
  }
  // 横幅期未命中 → 开通知中心再试（toast 在中心内仍可点击激活）
  runPs(PS_CENTER);
  await sleep(1500);
  for (let i = 1; i <= 3; i++) {
    const out = runPs(PS_CLICK);
    const last = out.trim().split("\n").pop();
    log(`center click attempt ${i}/3: ${last}`);
    if (/CLICK (INVOKE_OK|POINT_OK)/.test(out)) {
      runPs(PS_CENTER); // 关闭通知中心
      return true;
    }
    await sleep(2000);
  }
  runPs(PS_CENTER); // 关闭通知中心
  return false;
}

async function main() {
  log("== PushHub notify spike check ==");
  fs.rmSync(resultFile, { force: true });

  const child = spawn("cargo", ["run", "--example", "notify_spike"], {
    cwd: tauriDir,
    stdio: "inherit",
    shell: true,
  });

  // 1) 等 SHOW 标记（含首次编译时间，上限 5 分钟）
  let shown = false;
  for (let i = 0; i < 300; i++) {
    const c = readResult();
    if (/^SHOW Ok$/m.test(c)) {
      shown = true;
      break;
    }
    if (/^SHOW Err/m.test(c)) break;
    await sleep(1000);
  }
  if (!shown) {
    log(`FAIL: SHOW Ok marker not seen (show failed or build/run issue)`);
    log("--- result file ---\n" + readResult());
    child.kill();
    process.exitCode = 1;
    return;
  }
  log("SHOW Ok observed");

  // 2) 等 banner 渲染后自动点击
  await sleep(2500);
  const clicked = await attemptClick();
  log(clicked ? "click automation succeeded" : "click automation did not land");

  // 3) 等 spike 自行退出（激活即 ~2s；未激活 60s 超时后 REMOVE 收尾）
  const exitDeadline = Date.now() + 120_000;
  while (child.exitCode === null && Date.now() < exitDeadline) {
    await sleep(1000);
  }
  if (child.exitCode === null) {
    log("WARN: spike process still running, killing");
    child.kill();
  }

  // 4) 断言
  const content = readResult();
  const checks = [
    ["SHOW Ok", /^SHOW Ok$/m.test(content)],
    ["ACTIVATED", /^ACTIVATED/m.test(content)],
    ["REMOVE Ok", /^REMOVE Ok$/m.test(content)],
  ];
  log("--- result file ---");
  for (const line of content.trim().split("\n")) log(`  ${line}`);
  let pass = true;
  for (const [name, ok] of checks) {
    log(`${ok ? "PASS" : "FAIL"}: ${name}`);
    if (!ok) pass = false;
  }
  fs.rmSync(resultFile, { force: true });
  log(pass ? "SPIKE PASS" : "SPIKE FAIL");
  process.exitCode = pass ? 0 : 1;
}

main().catch((e) => {
  log(`FAIL: unexpected error ${e && e.stack ? e.stack : e}`);
  process.exitCode = 1;
});
