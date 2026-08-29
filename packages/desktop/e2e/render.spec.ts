/**
 * 渲染消毒 E2E（05-06 Task 3，T-05-06-01/T-05-06-02）：消费 web-sdk 的
 * attack-samples.json 基线——跨包同基线断言（@pushhub/web-sdk/render 的
 * renderMarkdown 被桌面端 import，同一管道在真 WebView 上产出与 web-sdk
 * 单测逐字节相同的消毒输出——「四端消毒逻辑不漂移」的执行侧证据）。
 *
 * 断言面：
 *  - 逐样本：.msg-body innerHTML === fixture expected（跨包一致，verbatim）；
 *  - 全局 DOM 审计：无 script/iframe 元素、无 on* 内联属性、全部链接
 *    target=_blank 且 rel 含 noopener、无 javascript:/data: href（D-21）；
 *  - Markdown 基本形态：标题/粗体/行内代码/代码块渲染为对应元素。
 */
import { test, expect } from "@playwright/test";
import { BASE, createChannel, launchDesktop, rmTempConfig, sendMessage, writeTempConfig } from "./helpers";
// 类型注：工作区未装 @types/node（02-05 既定取舍——行级 @ts-expect-error 压制）。
// @ts-expect-error -- 工作区未装 @types/node
import { readFileSync } from "node:fs";
// @ts-expect-error -- 工作区未装 @types/node
import { dirname, join, resolve } from "node:path";
// @ts-expect-error -- 工作区未装 @types/node
import { fileURLToPath } from "node:url";

interface AttackSample {
  name: string;
  input: string;
  expected: string;
}

/** 跨包基线：web-sdk 消毒断言 fixture（同文件驱动 web-sdk 单测与桌面端 E2E）。 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const samples: AttackSample[] = JSON.parse(
  readFileSync(join(repoRoot, "packages", "web-sdk", "test", "fixtures", "attack-samples.json"), "utf8"),
) as AttackSample[];

const MARKDOWN_BASIC = "# md-h1-check\n\n**bold-check** 与 `code-inline-check`\n\n```\ncode-block-check\n```";

test("render: attack-samples 跨包同基线 + Markdown 基本形态 + 链接加固", async ({ request }) => {
  const channel = await createChannel(request);
  const configPath = writeTempConfig(BASE, [
    { id: channel.channelId, name: "render-e2e", key: channel.channelKey },
  ]);
  const cdpPort = 20000 + Math.floor(Math.random() * 20000);
  const desktop = await launchDesktop(cdpPort, { PH_CONFIG_PATH: configPath });

  try {
    await desktop.page.waitForFunction(
      () => document.getElementById("status")?.textContent === "online",
      null,
      { timeout: 30_000 },
    );

    // Markdown 基本形态消息 + 全部攻击样本（限流 30/min 内：1 + 15 = 16 条）。
    const md = await sendMessage(request, channel.sendKey, {
      title: "md-basics",
      text: MARKDOWN_BASIC,
    });
    const sent: { id: string; name: string }[] = [];
    for (const sample of samples) {
      const r = await sendMessage(request, channel.sendKey, {
        title: sample.name,
        text: sample.input,
      });
      sent.push({ id: r.id, name: sample.name });
    }

    // 全部消息渲染到位（逐 wid 等待——扇出经 Rust 连接到达窗口）。
    for (const s of sent) {
      await desktop.page
        .locator(`#messages .msg[data-wid="${s.id}"]`)
        .waitFor({ timeout: 10_000 });
    }
    await desktop.page.locator(`#messages .msg[data-wid="${md.id}"]`).waitFor({ timeout: 10_000 });

    // 逐样本 verbatim 断言：消毒输出与 web-sdk 基线逐字节一致（跨包不漂移）。
    const mismatches = await desktop.page.evaluate(
      ({ samples: ss, sent: ids }: { samples: AttackSample[]; sent: { id: string }[] }) => {
        const out: { name: string; got: string; want: string }[] = [];
        for (let i = 0; i < ss.length; i += 1) {
          const el = document.querySelector(`.msg[data-wid="${ids[i].id}"] .msg-body`);
          const got = el?.innerHTML ?? "(missing)";
          if (got !== ss[i].expected) {
            out.push({ name: ss[i].name, got, want: ss[i].expected });
          }
        }
        return out;
      },
      { samples, sent },
    );
    expect(mismatches).toEqual([]);

    // Markdown 基本形态：标题/粗体/行内代码/代码块为对应元素。
    const basics = await desktop.page.evaluate((wid: string) => {
      const body = document.querySelector(`.msg[data-wid="${wid}"] .msg-body`);
      return {
        h1: body?.querySelector("h1")?.textContent ?? null,
        strong: body?.querySelector("strong")?.textContent ?? null,
        inlineCode: body?.querySelector("p code")?.textContent ?? null,
        codeBlock: body?.querySelector("pre code")?.textContent ?? null,
      };
    }, md.id);
    expect(basics).toEqual({
      h1: "md-h1-check",
      strong: "bold-check",
      inlineCode: "code-inline-check",
      codeBlock: "code-block-check\n",
    });

    // 全局 DOM 审计：消毒后无可执行元素/事件属性/危险链接（D-21 加固在位）。
    const audit = await desktop.page.evaluate(() => {
      const root = document.getElementById("messages");
      if (root === null) throw new Error("#messages missing");
      const onAttrs: string[] = [];
      const badLinks: string[] = [];
      root.querySelectorAll("*").forEach((el) => {
        for (const a of el.getAttributeNames()) {
          if (/^on/i.test(a)) onAttrs.push(`${el.tagName}@${a}`);
        }
      });
      root.querySelectorAll("a").forEach((a) => {
        const href = a.getAttribute("href");
        if (href !== null && (href.startsWith("javascript:") || href.startsWith("data:"))) {
          badLinks.push(`dangerous-href:${href}`);
        }
        if (a.getAttribute("target") !== "_blank") badLinks.push(`no-target:${href ?? ""}`);
        if (!(a.getAttribute("rel") ?? "").includes("noopener")) {
          badLinks.push(`no-noopener:${href ?? ""}`);
        }
      });
      return {
        scripts: root.querySelectorAll("script").length,
        iframes: root.querySelectorAll("iframe").length,
        onAttrs,
        badLinks,
      };
    });
    expect(audit.scripts).toBe(0);
    expect(audit.iframes).toBe(0);
    expect(audit.onAttrs).toEqual([]);
    expect(audit.badLinks).toEqual([]);
  } finally {
    await desktop.cleanup();
    rmTempConfig(configPath);
  }
});
