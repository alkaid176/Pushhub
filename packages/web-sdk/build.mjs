#!/usr/bin/env node
/**
 * pushhub.js 构建流水线（02-01 Task 3，RESEARCH Pattern 1/5 方案 A）。
 *
 * 链路（key_links 首条：此链断裂即 SC1/SC4 同时失效）：
 *   esbuild .cts 入口 --format=iife → dist/pushhub.js（IIFE，全局 PushHub）
 *   → 复制到 packages/server/public/pushhub.js（wrangler 静态资产挂载点，
 *     asset-first 命中不触发 Worker——SC4）
 *
 * 报表：min/gzip 字节数（zlib gzipSync 实测，预算对照 RESEARCH A3）。
 * 冒烟：vm 沙箱加载产物断言 typeof PushHub === "function"（Pitfall 1 的
 * 警示信号是 typeof === "object"——{default:X} 形态即此处拦截）+
 * 静态 renderMarkdown 存在（D-19）。min 体积超 120KB 打报警（不失败）。
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import vm from "node:vm";

const pkgRoot = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const esbuildCli = require.resolve("esbuild/bin/esbuild");
const outfile = join(pkgRoot, "dist", "pushhub.js");

execFileSync(
  process.execPath,
  [
    esbuildCli,
    join(pkgRoot, "src", "entry-iife.cts"),
    "--bundle",
    "--minify",
    "--format=iife",
    "--global-name=PushHub",
    `--outfile=${outfile}`,
  ],
  { stdio: "inherit" },
);

const target = resolve(pkgRoot, "../server/public/pushhub.js");
mkdirSync(dirname(target), { recursive: true });
copyFileSync(outfile, target);

const bytes = readFileSync(outfile);
const min = bytes.length;
const gzip = gzipSync(bytes).length;
console.log(`pushhub.js  min ${min} bytes / gzip ${gzip} bytes`);

// 构建冒烟：裸 vm 沙箱（无 window）执行产物——模块级初始化不得触碰 DOM。
const context = vm.createContext({});
vm.runInContext(bytes.toString("utf8"), context, { filename: "pushhub.js" });
if (typeof context.PushHub !== "function") {
  console.error(
    "BUILD SMOKE FAIL: typeof PushHub !== 'function'（IIFE 全局形态错误，Pitfall 1）",
  );
  process.exit(1);
}
if (typeof context.PushHub.renderMarkdown !== "function") {
  console.error("BUILD SMOKE FAIL: PushHub.renderMarkdown 静态方法缺失（D-19）");
  process.exit(1);
}
if (min > 120_000) {
  console.warn(
    `WARNING: pushhub.js min ${min} bytes 超过 120KB 预算报警线（A3）`,
  );
}
console.log("BUILD SMOKE OK: typeof PushHub === 'function'");
