/**
 * 便携版整理脚本（05-07 Task 3，D-77）：tauri build 产物 → dist/portable/。
 *  - 拷贝裸 exe（src-tauri/target/release/pushhub-desktop.exe——单文件自足，
 *    WebView2 由系统提供，无随包 DLL）；
 *  - 生成 README-portable.txt（解压即用 / WebView2 依赖 / AUMID 注意事项）。
 *
 * 用法：在 packages/desktop 下、`tauri build` 成功后运行
 *   node scripts/make-portable.mjs
 */
// 类型注：脚本经 node 直跑（不入 tsc 范围）；node: 导入无需 @types。
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const exePath = join(desktopRoot, "src-tauri", "target", "release", "pushhub-desktop.exe");
const outDir = join(desktopRoot, "dist", "portable");

if (!existsSync(exePath)) {
  console.error(`[make-portable] 未找到 ${exePath}——请先运行 pnpm exec tauri build`);
  process.exit(1);
}

const version = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8")).version;

mkdirSync(outDir, { recursive: true });
copyFileSync(exePath, join(outDir, "pushhub-desktop.exe"));

const readme = `PushHub 桌面版（便携版） v${version}
=====================================

【解压即用】
直接双击 pushhub-desktop.exe 运行，无需安装、不写程序目录。
配置保存在 %APPDATA%\\PushHub\\config.json（与安装版同一路径——安装版与
便携版不要同时使用，避免读写同一配置文件）。

【运行依赖】
Windows 10/11 需已安装 Microsoft Edge WebView2 运行时（多数系统自带）。
若双击后无窗口或提示初始化失败，请从微软官网安装
"WebView2 Evergreen Runtime" 后重试。

【系统通知说明】
- 安装版：NSIS 安装器完成 AUMID 登记，通知开箱可用。
- 便携版：首次运行时应用会自行注册 AUMID（app.pushhub.desktop，写入
  当前用户注册表，无需管理员）；如通知未弹出，重启应用一次即可。
- 通知点击将定位到对应消息（弹出窗口 + 切换频道 + 滚动高亮）。

【其他】
- 应用为单实例：第二次启动会唤起已有窗口而不是新开进程。
- 退出请经托盘图标右键菜单「退出」——点窗口 X 只是隐藏到托盘（连接保持）。
- 版本 ${version} 属桌面端版本线，与服务端部署版本（root package.json）相互独立。
`;

writeFileSync(join(outDir, "README-portable.txt"), readme, "utf8");
console.log(`[make-portable] 便携版就绪: dist/portable/（pushhub-desktop.exe + README-portable.txt, v${version}）`);
