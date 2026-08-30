// app 模块：PushHub 安卓客户端（单模块起步，RESEARCH §Recommended Project Structure）。
//
// applicationId 经 06-01 Task 0 checkpoint 用户决策锁定为 app.pushhub.android
// （one-way：与桌面端 AUMID app.pushhub.desktop 同源命名；真机安装 + 通知通道
// 锚建立后改名 = 卸载重装 + 全部用户设置丢失——此后所有 plan 不再触碰）。

plugins {
    alias(libs.plugins.android.application)
    // Kotlin：AGP 9 built-in Kotlin（默认）——不 apply org.jetbrains.kotlin.android
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "app.pushhub.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "app.pushhub.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        // D-77：安卓端独立版本线（对齐桌面 0.1.x 先例）
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            // v1 自分发不启 minify（Pitfall 10：R8 裁剪 kotlinx.serialization
            // serializer 的风险直接绕开；spike 包与 UAT 包与发布配置同构）
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // built-in Kotlin 下 jvmTarget 缺省取 compileOptions.targetCompatibility（=17），
    // 无需 kotlinOptions DSL（AGP 9 迁移指引：该 DSL 已废弃）。
}

dependencies {
    // 本 plan 所需最小集（UI 库 material/viewpager2/recyclerview/markwon 与
    // instrumentation 三件留消费 plan 引入——catalog 已备位）
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.lifecycle.service)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)

    // JVM 测试：机器/协议纯逻辑 + fixtures 契约 + mockwebserver3 真实 WS 模拟
    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.mockwebserver3)

    // instrumentation（真机 connected 测试：通知/FGS——06-02+/spike 消费）
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.rules)
}
