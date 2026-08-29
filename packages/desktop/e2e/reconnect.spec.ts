/**
 * SC4-e/WIN-05 断连重连补拉 E2E（05-07 Task 1，D-78）：真服务端 × 真 WebView
 * （CDP 驱动 tauri dev）——断连源 = spec 自管 wrangler dev 进程的 kill/respawn
 * （Pitfall 9：重启 wrangler dev 即免费混沌测试；playwright webServer 管理的
 * 4911 实例无法中途重启，本 spec 以随机高位端口 + 独立 --persist-to 自管生命
 * 周期，状态目录跨 respawn 复用保证频道/历史存活）。
 *
 * 序列（对齐 web-sdk reconnect.spec.ts 的 seq 收集器/零重复断言模式）：
 *  1. spawn wrangler（隔离状态目录）→ createChannel → writeTempConfig →
 *     launchDesktop → 断言 online；
 *  2. 基线 2 条（seq 记为基线，DOM 可见）；
 *  3. kill wrangler 进程树 → 断言 #status 转 reconnecting（断连期间 UI 不崩溃
 *     ——DOM 状态仍在事件驱动更新）；
 *  4. respawn 同端口同状态目录 → 端口即听即发 2 条（与客户端重连竞速——尽力
 *     使其成为离线窗口消息：实时帧错过、经首拉/sync 补拉到达）；
 *  5. 断言 5-30s（宽限 60s）内回到 online（真实退避时间——E2E 不注入随机源）；
 *  6. 恢复后再发 1 条实时帧 → 断言全部 5 条恰为 [基线 2 + 离线窗 2 + 恢复后 1]
 *     DOM seq 升序、无缺失（恰补缺口）、零重复（收集器断言）。
 *
 * 竞速说明（checker 已知警告）：「恰补缺口」的离线窗证明依赖 respawn 后发送
 * 早于客户端重连完成——本 spec 以端口即听即发最大化概率，但硬保证是
 * 「零丢失 + 零重复 + 全量可见」全集断言（无论经实时或补拉路径到达）。
 */
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { launchDesktop, rmTempConfig, writeTempConfig } from "./helpers";
// 类型注：工作区未装 @types/node（02-05 既定取舍——行级 @ts-expect-error 压制）。
// @ts-expect-error -- 工作区未装 @types/node（见 helpers.ts「类型注」）
import { spawn, exec, type ChildProcess } from "node:child_process";
// @ts-expect-error -- 工作区未装 @types/node
import { mkdtempSync, rmSync } from "node:fs";
// @ts-expect-error -- 工作区未装 @types/node
import { tmpdir } from "node:os";
// @ts-expect-error -- 工作区未装 @types/node
import { join, dirname, resolve } from "node:path";
// @ts-expect-error -- 工作区未装 @types/node
import { fileURLToPath } from "node:url";
// @ts-expect-error -- 工作区未装 @types/node
import { env } from "node:process";

const ADMIN_KEY = "e2e-admin-key"; // 仅存在于本地 wrangler dev 进程（--var 注入）
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

interface ChannelInfo {
  channelKey: string;
  channelId: string;
  sendKey: string;
}

// ---- 自管 wrangler 生命周期（spawn 与 kill 成对——acceptance 源断言锚点）----

/** 随机高位端口（避开 4911 webServer 与 1420 vite）。 */
function randomPort(lo: number, hi: number): number {
  return lo + Math.floor(Math.random() * (hi - lo));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** spawn wrangler dev（隔离 --persist-to：跨 kill/respawn 保频道/历史状态，
 * 且不与 webServer 的 4911 实例共享 .wrangler/state 目录——双 workerd 并发
 * 写同一 SQLite 有锁竞争风险）。 */
function spawnWrangler(port: number, persistDir: string): ChildProcess {
  return spawn(
    "pnpm",
    [
      "--filter", "@pushhub/server", "exec", "wrangler", "dev",
      "--port", String(port),
      "--ip", "127.0.0.1",
      "--var", `ADMIN_KEY:${ADMIN_KEY}`,
      "--persist-to", persistDir,
    ],
    { cwd: repoRoot, env: { ...env }, shell: true, stdio: "ignore" },
  );
}

/** 就绪探测：GET / 直到 2xx（wrangler 绑定端口并完成启动）。 */
async function waitHttpReady(request: APIRequestContext, port: number, timeoutMs: number): Promise<void> {
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const resp = await request.get(url, { timeout: 5_000 });
      if (resp.ok()) return;
      lastError = `HTTP ${resp.status()}`;
    } catch (err) {
      lastError = err;
    }
    await sleep(1_000);
  }
  throw new Error(`wrangler dev (${url}) ${timeoutMs}ms 内未就绪: ${String(lastError)}`);
}

/** 等待一条 taskkill 结束（诊断用——不吞错误码）。 */
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

/**
 * 杀 wrangler 进程树并验证端口释放（对齐 helpers.killTree 的实证教训：
 * taskkill /T 单发存在树遍历竞态会孤儿化 workerd）：
 *  1. 树杀 spawn 的 shell pid；2. 残留端口占用者补杀；3. 轮询验证端口释放。
 * 注意：只针对本 spec 的 wrangler 端口——不动 desktop（1420/pushhub-desktop.exe）。
 */
async function killWrangler(child: ChildProcess, port: number): Promise<void> {
  if (child.pid !== undefined && !child.killed) {
    await runTaskKill(["/pid", String(child.pid), "/T", "/F"]);
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const occupants = await portOccupantPid(port);
    if (occupants.length === 0) return;
    for (const pid of occupants) {
      await runTaskKill(["/pid", String(pid), "/T", "/F"]);
    }
    await sleep(1_000);
  }
  throw new Error(`wrangler 端口 ${port} 在 15s 内未释放（孤儿 workerd 残留）`);
}

// ---- 频道/消息操作（目标 = 自管端口，非 BASE 4911）----

async function createChannelOn(request: APIRequestContext, port: number): Promise<ChannelInfo> {
  const resp = await request.post(`http://127.0.0.1:${port}/api/admin/channels`, {
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
    data: { name: `e2e-reconnect-${Date.now()}` },
  });
  expect(resp.status()).toBe(201);
  const channel = (await resp.json()) as {
    channelKey: string;
    channelId: string;
    sendKeys: { key: string }[];
  };
  return {
    channelKey: channel.channelKey,
    channelId: channel.channelId,
    sendKey: channel.sendKeys[0].key,
  };
}

async function sendMessageOn(
  request: APIRequestContext,
  port: number,
  sendKey: string,
  payload: { title?: string; text: string },
): Promise<{ seq: number }> {
  const resp = await request.post(`http://127.0.0.1:${port}/api/send`, {
    headers: { Authorization: `Bearer ${sendKey}`, "content-type": "application/json" },
    data: payload,
  });
  expect(resp.status()).toBe(200);
  return (await resp.json()) as { seq: number };
}

// ---- 页面侧收集器（对齐 web-sdk reconnect.spec 的 seq 收集器模式）----

/** 宿主视角全部已见 seq（DOM .msg[data-seq]，渲染顺序即列表顺序）。 */
async function visibleSeqs(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("#messages .msg[data-seq]")).map((el) =>
      Number((el as HTMLElement).dataset.seq),
    ),
  );
}

async function waitStatus(page: Page, text: string, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    (t) => document.getElementById("status")?.textContent === t,
    text,
    { timeout: timeoutMs },
  );
}

test("SC4-e: kill wrangler → reconnecting → respawn → 真实退避重连 → 补拉零丢失零重复", async ({ request }) => {
  // 全程含两次 wrangler 冷启动 + 真实退避（宽限 60s）——超时上限放宽。
  test.setTimeout(300_000);

  const port = randomPort(4925, 4994);
  const cdpPort = randomPort(20000, 39999);
  const persistDir = mkdtempSync(join(tmpdir(), "pushhub-wrangler-"));
  const wrangler1 = spawnWrangler(port, persistDir);
  let configPath = "";
  let desktop: Awaited<ReturnType<typeof launchDesktop>> | null = null;
  let wrangler2: ChildProcess | null = null;

  try {
    await waitHttpReady(request, port, 60_000);
    const channel = await createChannelOn(request, port);
    configPath = writeTempConfig(`http://127.0.0.1:${port}`, [
      { id: channel.channelId, name: "reconnect-e2e", key: channel.channelKey },
    ]);
    desktop = await launchDesktop(cdpPort, { PH_CONFIG_PATH: configPath });

    // 1) 在线 + 基线 2 条（seq 基线，DOM 可见）。
    await waitStatus(desktop.page, "online", 30_000);
    const m1 = await sendMessageOn(request, port, channel.sendKey, { title: "reconnect e2e", text: "baseline-1" });
    const m2 = await sendMessageOn(request, port, channel.sendKey, { title: "reconnect e2e", text: "baseline-2" });
    await desktop.page.waitForFunction(
      (n) => document.querySelectorAll("#messages .msg[data-seq]").length >= n,
      2,
      { timeout: 15_000 },
    );

    // 2) 断连：kill wrangler 进程树（断连源——Pitfall 9）。
    await killWrangler(wrangler1, port);
    // 断连期间 UI 不崩溃：状态仍在事件驱动更新（reconnecting 由 WsClose 即时产生）。
    await waitStatus(desktop.page, "reconnecting", 20_000);

    // 3) respawn 同端口同状态目录；端口即听即发 2 条（离线窗口消息——与
    //    客户端重连竞速，尽力使其只能经首拉/sync 补拉到达）。
    wrangler2 = spawnWrangler(port, persistDir);
    await waitHttpReady(request, port, 60_000);
    const m3 = await sendMessageOn(request, port, channel.sendKey, { title: "reconnect e2e", text: "offline-window-3" });
    const m4 = await sendMessageOn(request, port, channel.sendKey, { title: "reconnect e2e", text: "offline-window-4" });

    // 4) 真实退避时间回到 online（预期 5-30s；宽限 60s——attempt 递增时窗口指数增长）。
    await waitStatus(desktop.page, "online", 60_000);

    // 5) 恢复后实时帧 1 条。
    const m5 = await sendMessageOn(request, port, channel.sendKey, { title: "reconnect e2e", text: "after-recovery-5" });

    // 6) 硬保证：全集恰为 5 条、DOM 升序、无缺失（恰补缺口）、零重复。
    const expected = [m1.seq, m2.seq, m3.seq, m4.seq, m5.seq].sort((a, b) => a - b);
    await desktop.page.waitForFunction(
      (n) => document.querySelectorAll("#messages .msg[data-seq]").length >= n,
      expected.length,
      { timeout: 30_000 },
    );
    const seqs = await visibleSeqs(desktop.page);
    // 零重复（收集器断言——等值 seq 绝不渲染两次）。
    expect(new Set(seqs).size).toBe(seqs.length);
    // 全量可见且升序：恰为全部 5 条 seq（无缺失 = 断连窗口消息被补齐；升序 = 列表序正确）。
    expect(seqs).toEqual(expected);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    // 7) 消息内容抽查：离线窗口两条文本均可见（基线与恢复后条目已在 seq 断言覆盖）。
    const bodyText = await desktop.page.evaluate(() => document.getElementById("messages")?.textContent ?? "");
    expect(bodyText).toContain("offline-window-3");
    expect(bodyText).toContain("offline-window-4");
  } finally {
    if (wrangler2 !== null) {
      await killWrangler(wrangler2, port).catch(() => {});
    }
    if (desktop !== null) {
      await desktop.cleanup();
    }
    if (configPath !== "") {
      rmTempConfig(configPath);
    }
    rmSync(persistDir, { recursive: true, force: true });
  }
});
