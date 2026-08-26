/**
 * IIFE 打包入口（02-01，RESEARCH Pattern 1 实证唯一正确形态）。
 *
 * esbuild --global-name=PushHub 的全局 = 入口模块 exports：
 *  - ESM `export default PushHub` → 全局为 { default: class }，new 失败（Pitfall 1）；
 *  - type:module 包内 .ts 写 module.exports → 运行时抛 module is not defined（Pitfall 2）；
 *  - 唯一正确：.cts 扩展名显式 CommonJS + module.exports = PushHub（类本身，
 *    含静态方法 renderMarkdown）。
 *
 * 本地 `declare const module` 仅供 tsc（types:[] 无 @types/node 的 module 声明）
 * 通过——esbuild 剥离全部类型行，产物不受影响。
 */
import { PushHub } from "./pushhub";

declare const module: { exports: unknown };

module.exports = PushHub;
