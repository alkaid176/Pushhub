package app.pushhub.android.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 通知逻辑 JVM 纯逻辑测试（06-05 Task 1，AND-02）。
 *
 * 覆盖四组断言（计划锁定）：
 *  1. priority → tier 三档映射（含未知值兜底 normal）；
 *  2. 摘要 150 截断边界（chars 计数，CJK 每字 1——桌面 A7 裁决同构）；
 *  3. 通道 ID 组装格式（ph_ 前缀/tier 后缀/含 channelId **不含频道名**——
 *     D-87 不可变纪律：含特殊字符的频道名断言其不出现在通道 ID）；
 *  4. 深链 extra 键值构造（ph_channel/ph_wid——SC2 契约）。
 *
 * 另含源码结构断言（acceptance criteria）：notify/cancel 同 NOTIF_ID 常量与
 * tag=wid 配对、PendingIntent 含 FLAG_IMMUTABLE——lint 型结构锁定（源文件经
 * 测试工作目录相对路径读取，与 FixturesContractTest ../../shared/fixtures
 * 同一 A7 通路先例）。
 */
class NotificationLogicTest {

    // ---- ① priority → tier 三档映射 ----

    @Test
    fun `tier mapping three known priorities`() {
        assertEquals(NotificationRouter.TIER_HIGH, NotificationRouter.tierOf("high"))
        assertEquals(NotificationRouter.TIER_NORMAL, NotificationRouter.tierOf("normal"))
        assertEquals(NotificationRouter.TIER_LOW, NotificationRouter.tierOf("low"))
    }

    @Test
    fun `tier mapping unknown priorities fall back to normal`() {
        // 未知值兜底归 normal（协议层 isMessageShape 已守卫三值——防御纵深）
        assertEquals(NotificationRouter.TIER_NORMAL, NotificationRouter.tierOf("urgent"))
        assertEquals(NotificationRouter.TIER_NORMAL, NotificationRouter.tierOf(""))
        assertEquals(NotificationRouter.TIER_NORMAL, NotificationRouter.tierOf("HIGH"))
    }

    // ---- ② 摘要 150 截断边界 ----

    @Test
    fun `summary boundary at 150 chars`() {
        // 恰 150：原样保留
        val exact = "a".repeat(NotificationRouter.SUMMARY_MAX_CHARS)
        assertEquals(exact, NotificationRouter.summarize(exact))
        // 151 → 截到 150
        val over = "a".repeat(NotificationRouter.SUMMARY_MAX_CHARS + 1)
        assertEquals(
            NotificationRouter.SUMMARY_MAX_CHARS,
            NotificationRouter.summarize(over).length,
        )
        // 短文本原样
        assertEquals("short", NotificationRouter.summarize("short"))
    }

    @Test
    fun `summary counts cjk chars as one each`() {
        // chars 计数（非 UTF-16 code unit / byte）：300 个汉字截到 150
        val long = "推".repeat(300)
        val cut = NotificationRouter.summarize(long)
        assertEquals(NotificationRouter.SUMMARY_MAX_CHARS, cut.length)
        assertEquals("推".repeat(NotificationRouter.SUMMARY_MAX_CHARS), cut)
    }

    @Test
    fun `body prefers title and falls back to text`() {
        // title 优先
        assertEquals("the title", NotificationRouter.bodyOf("the title", "body text"))
        // null / 空白 title 视为缺失（桌面 make_title 同判）
        assertEquals("body text", NotificationRouter.bodyOf(null, "body text"))
        assertEquals("body text", NotificationRouter.bodyOf("   ", "body text"))
        // 正文超限统一截断
        val longText = "x".repeat(200)
        assertEquals(
            NotificationRouter.SUMMARY_MAX_CHARS,
            NotificationRouter.bodyOf(null, longText).length,
        )
    }

    // ---- ③ 通道 ID 组装格式（D-87 不可变纪律） ----

    @Test
    fun `channel id assembly format`() {
        // 通道 ID：ph_<channelId>_<tier>
        assertEquals("ph_ch1_high", NotificationRouter.notificationChannelIdOf("ch1", "high"))
        assertEquals("ph_ch1_normal", NotificationRouter.notificationChannelIdOf("ch1", "normal"))
        assertEquals("ph_ch1_low", NotificationRouter.notificationChannelIdOf("ch1", "low"))
        // 通道组 ID：phg_<channelId>
        assertEquals("phg_ch1", NotificationRouter.groupIdOf("ch1"))
    }

    @Test
    fun `channel ids never contain channel name`() {
        // D-87 不可变纪律：含特殊字符的频道名绝不出现在通道 ID（改名不换通道）
        val nastyName = "告警/频道 & <x> \"引号\" ch1"
        for (tier in listOf("high", "normal", "low")) {
            val id = NotificationRouter.notificationChannelIdOf("ch3", tier)
            assertFalse("通道 ID 不含频道名字面: $id", id.contains(nastyName))
            assertFalse("通道 ID 不含频道名任一片段", id.contains("告警"))
            assertTrue("通道 ID 含内部 channelId", id.contains("ch3"))
        }
        assertFalse(NotificationRouter.groupIdOf("ch3").contains("告警"))
    }

    @Test
    fun `channel label is user readable`() {
        // 系统设置用户可辨识：「频道名 · 高/中/低」
        assertEquals("alerts · 高", NotificationRouter.channelLabel("alerts", "high"))
        assertEquals("alerts · 中", NotificationRouter.channelLabel("alerts", "normal"))
        assertEquals("alerts · 低", NotificationRouter.channelLabel("alerts", "low"))
    }

    // ---- ④ 深链 extra 枮值构造（SC2 契约） ----

    @Test
    fun `deep link extras keys and values`() {
        val extras = NotificationRouter.deepLinkExtras("ch2", "m_abc123")
        // 键恰 ph_channel/ph_wid（06-07 onNewIntent 消费契约）
        assertEquals(setOf("ph_channel", "ph_wid"), extras.keys)
        assertEquals("ch2", extras[NotificationRouter.EXTRA_CHANNEL])
        assertEquals("m_abc123", extras[NotificationRouter.EXTRA_WID])
        // 常量即字面键（Intent.putExtra 与消费方 getStringExtra 同源）
        assertEquals("ph_channel", NotificationRouter.EXTRA_CHANNEL)
        assertEquals("ph_wid", NotificationRouter.EXTRA_WID)
    }

    // ---- 源码结构断言（acceptance criteria：notify/cancel 配对 + IMMUTABLE） ----

    /** 源文件定位：测试工作目录 = app 模块目录（FixturesContractTest 同一通路）。 */
    private fun routerSource(): String {
        val file = File("src/main/kotlin/app/pushhub/android/service/NotificationRouter.kt")
        assertTrue("源文件应存在（测试工作目录 = packages/android/app）: ${file.absolutePath}", file.isFile)
        return file.readText()
    }

    @Test
    fun `notify and cancel pair on same tag and notif id`() {
        val src = routerSource()
        // notify(tag=wid, NOTIF_ID) 与 cancel(tag=wid, NOTIF_ID) 同常量配对（D-69）
        assertTrue("notify 必须使用 nm.notify(wid, NOTIF_ID", src.contains("nm.notify(wid, NOTIF_ID"))
        assertTrue("cancel 必须使用 nm.cancel(wid, NOTIF_ID", src.contains("nm.cancel(wid, NOTIF_ID"))
        // 禁 hash 转 Int 作通知 id（Pitfall 5）：wid.hashCode() 仅允许出现在
        // PendingIntent requestCode 一处
        val hashCodeUses = Regex("wid\\.hashCode\\(\\)").findAll(src).count()
        assertEquals("wid.hashCode() 仅 PendingIntent requestCode 一处", 1, hashCodeUses)
    }

    @Test
    fun `pending intent flags include immutable`() {
        val src = routerSource()
        // targetSdk 31+ 强制 IMMUTABLE（T-06-05-02）
        assertTrue(
            "PendingIntent 标志须含 FLAG_IMMUTABLE",
            src.contains("PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE"),
        )
    }
}
