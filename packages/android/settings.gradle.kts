// PushHub Android（packages/android）——独立 Gradle 工程，不进 pnpm workspace
// （对齐 packages/desktop 独立构建体系先例）。
//
// 仓库：AGP 与 androidx 栈在 google()；Kotlin/OkHttp/serialization 在 mavenCentral()；
// 插件解析额外开放 gradlePluginPortal()（RESEARCH §Standard Stack 既定布局）。

pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "pushhub-android"
include(":app")
