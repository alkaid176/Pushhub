package app.pushhub.android.render

import android.app.Application
import android.content.Context
import android.widget.TextView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import app.pushhub.android.protocol.lenientJson
import io.noties.markwon.core.spans.LinkSpan
import io.noties.markwon.ext.tables.TableSpan
import java.io.File
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Markwon 消毒渲染回归（06-06 Task 1，SC3/T-06-06-01/02/03，Robolectric——Markwon
 * 渲染需 Context，断言留在 JVM 快速回路）。
 *
 * 跨端一致性诚实边界（写进测试的既定代价，D-83）：Android 剥离 HTML 与 web 端
 * DOMPurify 消毒输出**不逐字节一致**（web 侧保留无害标签如 img/anchor，Android
 * core 默认整体剥离）——四端逐字节断言（05-06 先例）在 Android 不可复制，本测试
 * 的等价保障口径：**attack 样本逐条断言渲染输出零 HTML 标签文本**（任何标签形态
 * 出现即攻击面直通）。
 *
 * attack 样本集单一事实源直读 `packages/web-sdk/test/fixtures/attack-samples.json`
 * （fixtures 契约测试 ../../shared/fixtures 同款相对路径先例，A7 实证通路）——
 * 样本数与 web-sdk 渲染测试的样本集一致性由同文件构造性保证，测试内显式记录
 * 基线数 15。
 */
@RunWith(org.robolectric.RobolectricTestRunner::class)
@Config(sdk = [33])
class RenderTest {

    private val context: Context = RuntimeEnvironment.getApplication()

    private val markwon = MarkwonProvider.get(context)

    /** attack 样本 (name, input) 对——web-sdk 渲染测试同一事实源。 */
    private fun attackSamples(): List<Pair<String, String>> {
        val file = File("../../web-sdk/test/fixtures/attack-samples.json")
        assertTrue("attack 样本单一事实源可达: ${file.absolutePath}", file.isFile)
        return lenientJson.parseToJsonElement(file.readText()).jsonArray.map { el ->
            val obj = el.jsonObject
            obj["name"]!!.jsonPrimitive.content to obj["input"]!!.jsonPrimitive.content
        }
    }

    // ---- 样本集一致性（acceptance：样本数与 web-sdk 侧一致，测试内记录） ----

    @Test
    fun `attack sample baseline count is 15 matching web-sdk`() {
        assertEquals("web-sdk attack 样本集基线数（样本集扩充即双方同步变更）", 15, attackSamples().size)
    }

    // ---- SC3 主断言：attack 样本逐条渲染输出零 HTML 标签文本（T-06-06-01） ----

    @Test
    fun `every attack sample renders zero html tag text`() {
        val tagPattern = Regex("<[a-zA-Z!/][^>]*>")
        for ((name, input) in attackSamples()) {
            val out = markwon.toMarkdown(input).toString()
            assertFalse(
                "attack 样本 [$name] 渲染输出含 HTML 标签文本（SC3 直通）: [$out]",
                tagPattern.containsMatchIn(out),
            )
        }
    }

    @Test
    fun `script and style blocks render empty not raw passthrough`() {
        // CommonMark type-1 HTML block：整行（含 </script> 同行尾随文本）均属
        // html block → 整块剥离；配合 fallbackToRawInputWhenEmpty(false)（Rule 1
        // 修正——空输出不得回退原始输入）输出为空而非攻击载荷直通。
        assertEquals("", markwon.toMarkdown("<script>alert(1)</script>after").toString().trim())
        assertEquals("", markwon.toMarkdown("<style>body{color:red}</style>after").toString().trim())
    }

    // ---- 普通 Markdown 子集渲染成功非空（消毒不误伤） ----

    @Test
    fun `normal markdown subset renders non-empty`() {
        // 注：table 不在此循环——Markwon 表格的 toString 只余 NBSP/\n 分隔符
        //（Kotlin isBlank 判空白），文本进 TableRowSpan，由下方专测承载。
        val cases = mapOf(
            "bold" to "**加粗**文本",
            "code" to "行内 `code` 代码",
            "task-list" to "- [x] 已完成\n- [ ] 待办",
            "strikethrough" to "~~删除~~保留",
        )
        for ((name, md) in cases) {
            val out = markwon.toMarkdown(md).toString()
            assertTrue("普通 Markdown [$name] 渲染输出非空", out.isNotBlank())
        }
        // 任务列表与删除线文本保留（toString 可见）
        val tasks = markwon.toMarkdown("- [x] 已完成\n- [ ] 待办").toString()
        assertTrue("任务列表文本保留", tasks.contains("已完成") && tasks.contains("待办"))
        val strike = markwon.toMarkdown("~~删除~~保留").toString()
        assertTrue("删除线文本保留", strike.contains("删除") && strike.contains("保留"))
    }

    @Test
    fun `table renders as table span with rows`() {
        // D-83 诚实边界（flagged assumption）：Markwon 表格的单元格文本经
        // removeFromEnd 移入 TableRowSpan（canvas 绘制）——Spanned.toString() 只余
        // 行分隔符（NBSP/\n），与 web 端 marked 表格 DOM 结构不同构。等价保障
        // 口径：TableSpan 与多行结构存在（表格被解析渲染，非纯文本管道）。
        val spanned = markwon.toMarkdown("| 列A | 列B |\n| --- | --- |\n| 1 | 2 |")
        val spans = spanned.getSpans(0, spanned.length, TableSpan::class.java)
        assertTrue("表格渲染为 TableSpan（GFM 表格能力对齐）", spans.isNotEmpty())
        assertTrue("表格行结构存在（表头+数据行）", spanned.count { it == ' ' } >= 2)
    }

    // ---- 链接渲染为可点击 Spanned（用户点击入口存在） ----

    @Test
    fun `markdown links render as clickable spans`() {
        val spanned = markwon.toMarkdown("[docs](https://example.com/a?b=1)")
        val spans = spanned.getSpans(0, spanned.length, LinkSpan::class.java)
        assertTrue("合法链接渲染为 LinkSpan（点击入口）", spans.isNotEmpty())
        assertEquals("https://example.com/a?b=1", spans.first().link)
    }

    // ---- LinkResolver scheme 白名单（T-06-06-02） ----

    @Test
    fun `whitelisted http https links open via startActivity`() {
        val resolver = SchemeGuardLinkResolver()
        val view = TextView(context)
        val app: Application = RuntimeEnvironment.getApplication()

        resolver.resolve(view, "https://example.com/secure")
        val first = shadowOf(app).nextStartedActivity
        assertNotNull("https 放行", first)
        assertEquals("https://example.com/secure", first!!.data.toString())

        resolver.resolve(view, "http://example.com/plain")
        val second = shadowOf(app).nextStartedActivity
        assertNotNull("http 放行", second)
        assertEquals("http://example.com/plain", second!!.data.toString())
    }

    @Test
    fun `non whitelisted schemes never start activity`() {
        val resolver = SchemeGuardLinkResolver()
        val view = TextView(context)
        val app: Application = RuntimeEnvironment.getApplication()

        resolver.resolve(view, "javascript:alert(1)")
        resolver.resolve(view, "intent://evil.example/#Intent;end")
        resolver.resolve(view, "file:///data/data/secret")
        resolver.resolve(view, "content://provider/leak")
        resolver.resolve(view, "market://details?id=evil") // 自定义 scheme 跳转劫持面
        resolver.resolve(view, "example.com/no-scheme") // 无 scheme：白名单缺省拒绝

        assertNull("非白名单/无 scheme 零 startActivity 调用", shadowOf(app).nextStartedActivity)
    }

    @Test
    fun `whitelist is exactly http and https`() {
        assertEquals(setOf("http", "https"), SchemeGuardLinkResolver.ALLOWED_SCHEMES)
    }
}
