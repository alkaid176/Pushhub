package app.pushhub.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * A7 校准探测：golden fixtures 单一事实源直读通路（05-02 cargo 先例同款）。
 *
 * Gradle test 工作目录默认为 module 目录（packages/android/app），相对路径
 * `../../shared/fixtures` 指向 packages/shared/fixtures（15 个 golden JSON）。
 * 探测失败则退绝对路径拼接或构建期拷贝任务（SUMMARY 记录最终方案）——
 * 本测试通过即证明直读方案成立，后续 06-03 fixtures 契约测试同路径消费。
 */
class FixturesProbeTest {

    private val fixturesDir = File("../../shared/fixtures")

    @Test
    fun `fixtures directory reachable via relative path with exactly 15 json files`() {
        // JUnit4 断言参数序：(message, condition)——与 kotlin.test 相反
        assertTrue("fixtures 目录可达（A7 直读通路）: ${fixturesDir.absolutePath}", fixturesDir.isDirectory)
        val jsonFiles = fixturesDir.listFiles { f -> f.isFile && f.extension == "json" }.orEmpty()
        assertEquals("golden fixtures 恰 15 个 JSON（当前: ${jsonFiles.map { it.name }}）", 15, jsonFiles.size)
    }
}
