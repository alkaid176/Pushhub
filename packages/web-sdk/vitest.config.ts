// web-sdk 单测配置（02-01，D-25 偏差落地）：
// 默认 node 环境（frames/dedup 等纯逻辑测试快，无 DOM 需求）；
// render 消毒测试文件首行 docblock `// @vitest-environment jsdom` 单独切环境
// （RESEARCH Pitfall 3 实证：happy-dom 下 DOMPurify 双向失真，消毒断言只跑
//   jsdom 与真浏览器两层；本包 devDependencies 无 happy-dom）。
// 不复制 server 包的 --max-workers=1 --no-isolate——那是 server 池 WS+DO 隔离需求。
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // 单测只吃 test/ 下的 .test.ts——e2e/*.spec.ts 归 Playwright（默认 include
    // 的 **/*.spec.ts 会误捞 e2e 文件，import @playwright/test 即崩）。
    include: ["test/**/*.test.ts"],
  },
});
