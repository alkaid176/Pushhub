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
    // Rule 3 偏差修复：计划的 compileSdk 35 与冻结库版本内部矛盾——androidx
    // 1.19.0/1.13.0 与 okhttp-android 5.5.0 的 AAR metadata 均要求 compileSdk
    // 36-37+。compileSdk 只是构建期 API 面；targetSdk 35（specialUse FGS 策略
    // 锚点，CLAUDE.md 锁定）与 minSdk 26 均不变——组合合法且是标准做法。
    compileSdk = 37

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

    // 06-04：Robolectric 向导测试（Activity/布局/SharedPreferences 真实资源）
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
        }
    }
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

    // 06-04：向导/频道管理 UI（D-83 View 体系 + Material Components——TextInputLayout/
    // MaterialAlertDialog 需 Material 主题与 material 库；recyclerview 频道列表）
    implementation(libs.material)
    implementation(libs.androidx.recyclerview)

    // 06-06 Task 1：Markwon 四件（SC3——core 默认剥离 HtmlInline/HtmlBlock，不引
    // markwon-html 即无 jsoup 无 HTML 执行路径，T-06-06-01；不引任何图片加载插件
    // ——消息体远程图片渲染为链接文本，零自动第三方请求，T-06-06-03）
    implementation(libs.markwon.core)
    implementation(libs.markwon.ext.tables)
    implementation(libs.markwon.ext.strikethrough)
    implementation(libs.markwon.ext.tasklist)

    // 06-06 Task 2：消息界面（MessageFragment——fragment-ktx viewLifecycleOwner/
    // lifecycleScope；catalog 备位转消费）
    implementation(libs.androidx.fragment)

    // 06-07 Task 2：多频道 tab 化（D-80——ViewPager2 每频道一 MessageFragment；
    // catalog 备位转消费）
    implementation(libs.androidx.viewpager2)

    // JVM 测试：机器/协议纯逻辑 + fixtures 契约 + mockwebserver3 真实 WS 模拟
    testImplementation(libs.junit)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.mockwebserver3)
    // 06-04：向导表单/权限路径状态机（Activity + 布局真实资源）
    testImplementation(libs.robolectric)

    // instrumentation（真机 connected 测试：通知/FGS——06-02+/spike 消费）
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.rules)
}
