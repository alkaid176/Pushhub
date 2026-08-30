package app.pushhub.android.render

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import io.noties.markwon.AbstractMarkwonPlugin
import io.noties.markwon.LinkResolver
import io.noties.markwon.Markwon
import io.noties.markwon.MarkwonConfiguration
import io.noties.markwon.core.CorePlugin
import io.noties.markwon.ext.strikethrough.StrikethroughPlugin
import io.noties.markwon.ext.tables.TablePlugin
import io.noties.markwon.ext.tasklist.TaskListPlugin

/**
 * Markdown → Spanned 渲染单例（06-06 Task 1，SC3/AND-03，T-06-06-01/02/03）。
 *
 * 消毒纪律（Markwon 无 HTML 配置，RESEARCH Pattern 6 源码验证）：
 *  - **插件清单恰四项**：core + tables + strikethrough + tasklist——对齐 web 端
 *    marked+GFM 能力面（表格/删除线/任务列表）；
 *  - **零 HTML 渲染插件**（不引 markwon-html 即无 jsoup、无 HTML 执行路径）：
 *    core 默认 visit(HtmlInline)/visit(HtmlBlock) 走泛化 children 访问——行内
 *    HTML 标签静默剥离（内容文本保留）、块级 HTML 整块不渲染；
 *  - **零网络图片加载插件**（不引 image-loader/coil/glide 任何桥接）：消息体远程
 *    图片一律渲染为链接文本——用户 IP 与阅读行为不得泄露给消息发送方可控的
 *    第三方主机（must_haves.prohibitions，T-06-06-03），无任何自动网络请求；
 *  - **链接 scheme 白名单**（T-06-06-02）：仅用户点击后 http/https 放行
 *    startActivity(ACTION_VIEW)，其余 scheme（javascript:/intent:/file: 与自定义
 *    scheme 跳转劫持面）静默忽略——白名单制不是黑名单制，未知 scheme 缺省拒绝。
 *
 * 跨端一致性诚实边界（D-83 既定代价，RESEARCH §Pattern 6）：Android 剥离 HTML
 * 与 web/desktop（marked+DOMPurify 消毒安全子集）**不逐字节一致**——等价保障口径
 * 是 attack 样本逐条断言渲染输出不含任何 HTML 标签文本（RenderTest）；canon XSS
 * 复核归 /gsd-secure-phase。
 */
object MarkwonProvider {

    @Volatile
    private var cached: Markwon? = null

    /** 进程级单例（Markwon 构建含插件装配，复用避免每消息重建）。 */
    fun get(context: Context): Markwon =
        cached ?: synchronized(this) {
            cached ?: build(context.applicationContext).also { cached = it }
        }

    /** 构建入口独立可见（RenderTest 经 Robolectric 断言插件装配结果）。 */
    internal fun build(context: Context): Markwon =
        Markwon.builder(context)
            // 插件清单恰四项（源码断言锚点）——SchemeGuardCorePlugin 即 core（仅
            // 追加链接白名单 resolver，不构成第五插件）：
            .usePlugin(SchemeGuardCorePlugin())
            .usePlugin(TablePlugin.create(context))
            .usePlugin(StrikethroughPlugin.create())
            .usePlugin(TaskListPlugin.create(context))
            // 不加 HtmlPlugin —— SC3：不执行原始 HTML（T-06-06-01）
            // 【Rule 1 修正——attack 样本测试抓住的默认陷阱】Markwon builder 的
            // fallbackToRawInputWhenEmpty 缺省为 true：渲染输出为空时把**原始输入
            // 逐字回退为显示文本**——纯 HTML 消息（script/iframe 全剥离后为空）会
            // 把攻击载荷以可见文本形式直通 UI，must_haves 的「渲染输出不含任何
            // HTML 标签文本」口径被静默击穿。必须显式关闭：空输出保持为空
            //（全剥离消息渲染为空消息卡——D-83 既定代价，web 端 iframe 同样为空）。
            .fallbackToRawInputWhenEmpty(false)
            .build()
}

/**
 * 链接 scheme 白名单 resolver（T-06-06-02）——仅用户点击触发（LinkMovementMethod
 * → LinkSpan → 此处），无任何预取/自动请求。
 *
 * 与 LinkResolverDef 的差异（安全面）：Def 会为无 scheme 链接静默补 https:// 并
 * 放行任意 scheme——本实现白名单制：scheme 缺失或不在 {http, https} 一律静默
 * 忽略；startActivity 包 runCatching（无浏览器/无 handler 场景不崩溃）。
 */
internal class SchemeGuardLinkResolver : LinkResolver {

    override fun resolve(view: View, link: String) {
        val uri = Uri.parse(link)
        val scheme = uri.scheme?.lowercase() ?: return // 无 scheme：白名单制缺省拒绝
        if (scheme !in ALLOWED_SCHEMES) return
        val intent = Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        runCatching { view.context.startActivity(intent) }
    }

    companion object {
        /** 白名单恰两项（测试断言锚点——新增 scheme 属威胁面变更，须过 T-06-06-02 复核）。 */
        val ALLOWED_SCHEMES: Set<String> = setOf("http", "https")
    }
}

/**
 * core 插子的链接白名单变体——继承 CorePlugin 全部行为（文本/强调/代码/列表/
 * 链接 span 装配、LinkMovementMethod 隐式应用），仅覆写 configureConfiguration
 * 替换 LinkResolver。保持 usePlugin 清单恰四项的结构载体（非独立第五插件）。
 */
private class SchemeGuardCorePlugin : CorePlugin() {
    override fun configureConfiguration(builder: MarkwonConfiguration.Builder) {
        super.configureConfiguration(builder)
        builder.linkResolver(SchemeGuardLinkResolver())
    }
}
