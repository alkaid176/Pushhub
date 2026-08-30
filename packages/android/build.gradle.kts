// 根构建脚本：插件以 alias 声明、apply false（应用在 app 模块）。
// 版本全部来自 gradle/libs.versions.toml（版本 catalog 单一事实源）。
//
// Kotlin 编译走 AGP 9 built-in Kotlin（默认启用）——不声明
// org.jetbrains.kotlin.android（与 AGP 9 新 DSL 不兼容，官方迁移指引明文）；
// serialization 为 KGP 编译器插件，正常经 plugins 块应用。

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
