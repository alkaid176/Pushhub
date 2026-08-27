/**
 * ?v= 缓存参数与根 version 恒一致断言（02-05，G-02-3 机制闭环的断言半边）。
 *
 * 机制：build.mjs 构建期把根 package.json version 注入 index.html 的
 * pushhub.js?v=（注入半边，计划 action (a)）；本测试从磁盘读两端断言
 * 恒一致——机制的双保险而非替代品（UAT Test 3 裁决"机制化"，禁止 CI
 * 断言替代注入）：
 *  - Test 1（主断言）：?v= 值 === 根 package.json version，且该引用在
 *    文件中恰出现一次（未来 index.html 重构多出一个 pushhub.js 标签即
 *    失败——多标签漂移是静默 stale 缓存的另一形态）；
 *  - Test 2（机制生效）：执行一次真实构建后再断言 Test 1——注入幂等，
 *    重复构建不产生偏差。
 *
 * 类型注：工作区未装 @types/node（build.mjs / chaos-sc2.mjs 等 .mjs 不经
 * tsc，node: 内置 import 从未暴露该缺口；本测试是 tsc include 范围内首个
 * node: 消费者）——按最小侵入原则行级 @ts-expect-error 压制，运行时
 * vitest node 环境照常解析。
 */
// @ts-expect-error -- 工作区未装 @types/node（见头部"类型注"）
import { execFileSync } from "node:child_process";
// @ts-expect-error -- 工作区未装 @types/node（见头部"类型注"）
import { readFileSync } from "node:fs";
// @ts-expect-error -- 工作区未装 @types/node（见头部"类型注"）
import { dirname, resolve } from "node:path";
// @ts-expect-error -- 工作区未装 @types/node（见头部"类型注"）
import { fileURLToPath } from "node:url";
// @ts-expect-error -- 工作区未装 @types/node（见头部"类型注"；execPath 取代 process 全局名）
import { execPath } from "node:process";
import { describe, it, expect } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
// 根 package.json：packages/web-sdk/test → 仓库根（version 单一来源，0.1.8）。
const rootPkg = JSON.parse(
  readFileSync(resolve(here, "../../../package.json"), "utf8"),
) as { version: string };
const indexHtmlPath = resolve(here, "../../server/public/index.html");
const buildScriptPath = resolve(here, "../build.mjs");

/** pushhub.js?v= 引用提取（计划指定字符类；全局标志供 matchAll 计数）。 */
const SCRIPT_REF = /pushhub\.js\?v=([0-9A-Za-z.-]+)/g;

function refValues(html: string): string[] {
  return [...html.matchAll(SCRIPT_REF)].map((m) => m[1]);
}

describe("?v= 缓存参数与根 version 恒一致（G-02-3）", () => {
  it("index.html pushhub.js ?v= === 根 package.json version，且引用恰出现一次", () => {
    const values = refValues(readFileSync(indexHtmlPath, "utf8"));
    expect(values.length).toBe(1);
    expect(values[0]).toBe(rootPkg.version);
  });

  it("机制生效：执行一次构建后断言仍成立（注入幂等，重复构建不漂移）", () => {
    // 真实走 build.mjs 全链路（esbuild → copy → 注入），构建输出 pipe 吞掉。
    execFileSync(execPath, [buildScriptPath], { stdio: "pipe" });
    const values = refValues(readFileSync(indexHtmlPath, "utf8"));
    expect(values.length).toBe(1);
    expect(values[0]).toBe(rootPkg.version);
  });
});
