/**
 * E2E helpers（05-01 Task 2，D-78）——CDP 驱动 Tauri dev 模式 WebView2 + 服务端频道操作。
 *
 * - launchDesktop：spawn `pnpm tauri dev` 并注入
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<cdpPort>，
 *   轮询 chromium.connectOverCDP 直至超时（Pitfall 10：WebView2 调试端口就绪前
 *   连接会拒，需重试）；cleanup 杀整个进程树（Pitfall 9：shell:true 下 pid 是
 *   cmd 的 pid，必须 taskkill /T /F 才能连带 tauri cli/cargo/app 全树退出）。
 * - createChannel/sendMessage：自 web-sdk e2e/reconnect.spec.ts 移植
 *   （POST /api/admin/channels Bearer ADMIN_KEY + POST /api/send Bearer sendKey）。
 * - writeTempConfig：写临时 JSON 配置并返回路径（配合 PH_CONFIG_PATH 环境变量
 *   实现每份测试的配置隔离，config.rs 缺省 %APPDATA% 不受污染）。
 */
import { chromium, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
// 类型注：工作区未装 @types/node（02-05 既定取舍——行级 @ts-expect-error 压制
// 而非新增 devDependency；运行时 Playwright 的 node 环境照常解析）。
// @ts-expect-error -- 工作区未装 @types/node（见上"类型注"）
import { spawn, exec, type ChildProcess } from "node:child_process";
// @ts-expect-error -- 工作区未装 @types/node（见上"类型注"）
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
// @ts-expect-error -- 工作区未装 @types/node（见上"类型注"）
import { tmpdir } from "node:os";
// @ts-expect-error -- 工作区未装 @types/node（见上"类型注"）
import { join } from "node:path";
// @ts-expect-error -- 工作区未装 @types/node（见上"类型注"；命名导入取代 process 全局名）
import { env, platform, kill } from "node:process";
// @ts-expect-error -- 工作区未装 @types/node（见上"类型注"）
import { fileURLToPath } from "node:url";

export const BASE = "http://127.0.0.1:4911";
export const ADMIN_KEY = "e2e-admin-key"; // 仅存在于本地 wrangler dev 进程（--var 注入）

/** packages/desktop 目录锚点（spawn tauri dev 的 cwd）。 */
const desktopRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");

export interface ChannelInfo {
  channelKey: string;
  sendKey: string;
  channelId: string;
}

export interface DesktopHandle {
  browser: Browser;
  page: Page;
  /** 杀进程树 + 关闭 CDP 连接（testCleanup 用） */
  cleanup: () => Promise<void>;
}

export async function createChannel(request: APIRequestContext): Promise<ChannelInfo> {
  const name = `e2e-desktop-${Date.now()}`;
  const resp = await request.post(`${BASE}/api/admin/channels`, {
    headers: {
      Authorization: `Bearer ${ADMIN_KEY}`,
      "content-type": "application/json",
    },
    data: { name },
  });
  expect(resp.status()).toBe(201);
  const channel = (await resp.json()) as {
    channelKey: string;
    channelId: string;
    sendKeys: { key: string }[];
  };
  expect(channel.channelKey).toMatch(/^phc_[0-9A-Za-z]{32}$/);
  expect(channel.sendKeys[0].key).toMatch(/^phs_[0-9A-Za-z]{32}$/);
  return {
    channelKey: channel.channelKey,
    channelId: channel.channelId,
    sendKey: channel.sendKeys[0].key,
  };
}

/**
 * 发送 webhook 消息（POST /api/send Bearer sendKey）——载荷面覆盖
 * options/callback_url（05-06 reply-chain E2E：快捷回复链构造）。
 */
export async function sendMessage(
  request: APIRequestContext,
  sendKey: string,
  payload: { title?: string; text: string; options?: string[]; callback_url?: string },
): Promise<{ id: string; seq: number }> {
  const resp = await request.post(`${BASE}/api/send`, {
    headers: {
      Authorization: `Bearer ${sendKey}`,
      "content-type": "application/json",
    },
    data: payload,
  });
  expect(resp.status()).toBe(200);
  return (await resp.json()) as { id: string; seq: number };
}

export interface TempChannelConfig {
  id: string;
  name: string;
  key: string;
}

/** 写临时 config.json 并返回路径（PH_CONFIG_PATH 指向它；rmTempConfig 清理）。 */
export function writeTempConfig(serverUrl: string, channels: TempChannelConfig[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pushhub-e2e-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ server: serverUrl, channels }, null, 2), "utf8");
  return path;
}

export function rmTempConfig(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

/**
 * 启动桌面应用（tauri dev）并经 CDP 接入 WebView2。
 *
 * @param cdpPort 随机高位端口（避免与其他 WebView2 应用冲突，Pitfall 10）
 * @param extraEnv 额外环境变量（PH_CONFIG_PATH 等）
 * @param timeoutMs connectOverCDP 轮询超时（默认 170s，首跑 cargo 编译慢）
 */
export async function launchDesktop(
  cdpPort: number,
  extraEnv: Record<string, string> = {},
  timeoutMs = 170_000,
): Promise<DesktopHandle> {
  const child: ChildProcess = spawn("pnpm", ["tauri", "dev"], {
    cwd: desktopRoot,
    env: {
      ...env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
      ...extraEnv,
    },
    shell: true,
    stdio: "ignore",
  });

  const endpoint = `http://127.0.0.1:${cdpPort}`;
  const deadline = Date.now() + timeoutMs;
  let browser: Browser | null = null;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      browser = await chromium.connectOverCDP(endpoint, { timeout: 5_000 });
      break;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  if (browser === null) {
    await killTree(child);
    throw new Error(`connectOverCDP ${endpoint} 超时（${timeoutMs}ms）: ${String(lastError)}`);
  }

  // WebView2 首页可能晚于 CDP 端口就绪——轮询等待窗口页面出现。
  let page: Page | undefined;
  const pageDeadline = Date.now() + 20_000;
  while (Date.now() < pageDeadline) {
    page = browser.contexts()[0]?.pages()[0];
    if (page !== undefined) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (page === undefined) {
    await browser.close().catch(() => {});
    await killTree(child);
    throw new Error("CDP 已连接但 WebView2 窗口页面未出现（20s）");
  }

  return {
    browser,
    page,
    cleanup: async () => {
      await killTree(child);
      await browser!.close().catch(() => {});
    },
  };
}

/** 等待一条 taskkill 结束（不吞错误信息——诊断失败用）。 */
function runTaskKill(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const killer = spawn("taskkill", args, { shell: false });
    killer.on("close", (code: number | null) => resolve(code ?? -1));
    killer.on("error", () => resolve(-1));
  });
}

/** 取监听指定端口的进程 pid（Windows：Get-NetTCPConnection）。 */
function portOccupantPid(port: number): Promise<number[]> {
  return new Promise((resolve) => {
    exec(
      `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue).OwningProcess"`,
      (err: unknown, stdout: string) => {
        if (err) {
          resolve([]);
          return;
        }
        const pids = stdout
          .split(/\s+/)
          .map((s: string) => Number(s))
          .filter((n: number) => Number.isInteger(n) && n > 0);
        resolve([...new Set(pids)]);
      },
    );
  });
}

const VITE_PORT = 1420;

/**
 * 杀进程树（Pitfall 9 + 实证加固：taskkill /T 单发不可靠——树遍历竞态会把
 * app/vite 孤儿化，残app 撞 single-instance、残 vite 撞 1420 strictPort，
 * 毒害下一次运行）。三层确定性清杀 + 端口释放验证：
 *  1. 树杀 spawn 的 shell pid（cmd → pnpm → tauri cli → vite/cargo/app）；
 *  2. 按映像名杀 app（单实例保证同时至多一个 pushhub-desktop.exe，
 *     连带其 msedgewebview2 子树）；
 *  3. 按 1420 端口杀孤儿 vite；
 *  4. 轮询验证 1420 释放（15s），未释放即抛错——响亮失败优于静默污染。
 */
async function killTree(child: ChildProcess): Promise<void> {
  if (platform !== "win32") {
    if (child.pid !== undefined) {
      try {
        kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
    return;
  }

  if (child.pid !== undefined && !child.killed) {
    await runTaskKill(["/pid", String(child.pid), "/T", "/F"]);
  }
  await runTaskKill(["/IM", "pushhub-desktop.exe", "/T", "/F"]);

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const occupants = await portOccupantPid(VITE_PORT);
    if (occupants.length === 0) return;
    for (const pid of occupants) {
      await runTaskKill(["/pid", String(pid), "/T", "/F"]);
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(
    `cleanup: 端口 ${VITE_PORT} 在 15s 内未释放（孤儿 vite 残留——下次运行将因 strictPort 失败）`,
  );
}
