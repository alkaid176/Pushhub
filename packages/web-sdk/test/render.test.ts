// @vitest-environment jsdom
/**
 * renderMarkdown 消毒回归（02-01，SC3/WEB-05，D-20/D-21）。
 *
 * 首行 docblock 切 jsdom（D-25 偏差落地：消毒断言宿主用 jsdom——RESEARCH
 * Pitfall 3 实证 happy-dom 下 DOMPurify 双向失真：一种配置 <script> 幸存、
 * 另一种配置合法元素被误删；jsdom 下实证输出表全对。真浏览器层断言在
 * e2e/tracer.spec.ts）。
 *
 * 断言双层：
 *  1. 逐条样本输出 === 实证预期输出表（attack-samples.json 固化）；
 *  2. 结构断言（SC3 基线）：输出解析后无 script 元素、无 on* 属性、
 *     无 javascript:/data: 协议 href、A 元素均带 rel=noopener noreferrer
 *     与 target=_blank。
 */
import { describe, it, expect } from "vitest";
import { renderMarkdown } from "../src/render/render-markdown";
import samples from "./fixtures/attack-samples.json";

interface AttackSample {
  name: string;
  input: string;
  expected: string;
}

/** 输出 HTML 解析进容器后的结构审计结果。 */
function audit(html: string): {
  scripts: number;
  onAttrs: string[];
  badHrefs: string[];
  anchors: { href: string | null; target: string | null; rel: string | null }[];
} {
  const container = document.createElement("div");
  container.innerHTML = html;
  const onAttrs: string[] = [];
  const badHrefs: string[] = [];
  for (const el of container.querySelectorAll("*")) {
    for (const attr of el.getAttributeNames()) {
      if (/^on/i.test(attr)) onAttrs.push(`${el.tagName}@${attr}`);
    }
  }
  for (const a of container.querySelectorAll("a")) {
    const href = a.getAttribute("href");
    if (href !== null) {
      const lower = href.trim().toLowerCase();
      if (lower.startsWith("javascript:") || lower.startsWith("data:")) {
        badHrefs.push(href);
      }
    }
  }
  return {
    scripts: container.querySelectorAll("script").length,
    onAttrs,
    badHrefs,
    anchors: [...container.querySelectorAll("a")].map((a) => ({
      href: a.getAttribute("href"),
      target: a.getAttribute("target"),
      rel: a.getAttribute("rel"),
    })),
  };
}

describe("renderMarkdown 消毒（SC3 断言基线，jsdom）", () => {
  for (const sample of samples as AttackSample[]) {
    it(`样本 ${sample.name}：输出逐字匹配实证表且结构无害`, () => {
      const out = renderMarkdown(sample.input);
      expect(out).toBe(sample.expected);

      const a = audit(out);
      expect(a.scripts, `${sample.name}: 不应有 script 元素`).toBe(0);
      expect(a.onAttrs, `${sample.name}: 不应有 on* 属性`).toEqual([]);
      expect(a.badHrefs, `${sample.name}: 不应有 javascript:/data: href`).toEqual([]);
      for (const anchor of a.anchors) {
        expect(anchor.target, `${sample.name}: target=_blank`).toBe("_blank");
        expect(anchor.rel, `${sample.name}: rel 含 noopener noreferrer`).toContain(
          "noopener",
        );
        expect(anchor.rel).toContain("noreferrer");
      }
    });
  }

  it("合法链接保留 href 且属性齐备（消毒不误伤，D-21）", () => {
    const out = renderMarkdown("[docs](https://example.com/a?b=1)");
    const a = audit(out);
    expect(a.anchors.length).toBe(1);
    expect(a.anchors[0].href).toBe("https://example.com/a?b=1");
    expect(a.anchors[0].target).toBe("_blank");
    expect(a.anchors[0].rel).toBe("noopener noreferrer");
  });
});
