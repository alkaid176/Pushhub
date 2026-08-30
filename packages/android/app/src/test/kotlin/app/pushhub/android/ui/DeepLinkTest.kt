package app.pushhub.android.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Test

/**
 * 深链解析纯函数测试（06-07 Task 3，SC2——JVM 零 Robolectric：被测
 * [parseDeepLinkArgs] 零 Android 调用，纯函数结构性保证「解析失败无任何
 * startActivity 副作用」；extra 契约 ph_channel/ph_wid 由 06-05
 * NotificationRouter.deepLinkExtras 构造，桌面 notify/mod.rs parse_launch
 * 124-130 畸形丢弃纪律同构——T-06-07-01 mitigate）。
 *
 * 五路断言：合法目标 / 未知频道 / 畸形 wid / extra 缺失 / wid 空串。
 */
class DeepLinkTest {

    private val knownIds = setOf("ch1", "ch2")

    /** 合法目标：四要素齐备（channel 在白名单 + wid m_ 前缀非空）→ 返回目标。 */
    @Test
    fun `valid target parses to channel and wid`() {
        val link = parseDeepLinkArgs(channel = "ch1", wid = "m_abc123def4567890", knownChannelIds = knownIds)
        assertNotNull(link)
        assertEquals("ch1", link!!.channelId)
        assertEquals("m_abc123def4567890", link.wid)
    }

    /** channel 不在配置集（白名单拒绝——伪造/过时频道 id）。 */
    @Test
    fun `unknown channel returns null`() {
        assertNull(parseDeepLinkArgs(channel = "ch9", wid = "m_abc", knownChannelIds = knownIds))
        assertNull(parseDeepLinkArgs(channel = "", wid = "m_abc", knownChannelIds = knownIds))
    }

    /** wid 缺 m_ 前缀（畸形格式）→ null。 */
    @Test
    fun `wid without prefix returns null`() {
        assertNull(parseDeepLinkArgs(channel = "ch1", wid = "abc123def4567890", knownChannelIds = knownIds))
        assertNull(parseDeepLinkArgs(channel = "ch1", wid = "x_m_abc", knownChannelIds = knownIds))
    }

    /** extra 缺失（channel 或 wid 任一 null）→ null。 */
    @Test
    fun `missing extras return null`() {
        assertNull(parseDeepLinkArgs(channel = null, wid = "m_abc", knownChannelIds = knownIds))
        assertNull(parseDeepLinkArgs(channel = "ch1", wid = null, knownChannelIds = knownIds))
        assertNull(parseDeepLinkArgs(channel = null, wid = null, knownChannelIds = knownIds))
    }

    /** channel 合法但 wid 为空串 / 仅前缀串 → null（前缀后必须非空）。 */
    @Test
    fun `blank or prefix-only wid returns null`() {
        assertNull(parseDeepLinkArgs(channel = "ch1", wid = "", knownChannelIds = knownIds))
        assertNull(parseDeepLinkArgs(channel = "ch1", wid = "m_", knownChannelIds = knownIds))
    }

    /** WID_PREFIX 常量锚（D-05——与 shared/src/index.ts 逐字面一致）。 */
    @Test
    fun `wid prefix constant is m underscore`() {
        assertEquals("m_", WID_PREFIX)
    }
}
