package app.pushhub.android.ui

import app.pushhub.android.machine.Status
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 回复纯逻辑测试（06-06 Task 3，RPL-05/WEB-03 Pattern 7——JVM 直测，零 Android
 * 依赖：被测函数为 MessageFragment.kt / MainActivity.kt 顶层纯函数）。
 *
 * 四组（acceptance）：
 *  ① 载荷恰一校验矩阵（option 单选 / text 单发 / 互斥全空拒绝——pushhub.ts:153-163
 *     三步防御第一步的 UI 层对应）；
 *  ② not_connected fail-fast 路径返回值（不排队不重试——枚举无排队语义即语义）；
 *  ③ by 序列化双路（displayName null → 输出无 by 键；非 null → 自动携带 D-72）；
 *  ④ answered 冻结状态转移（权威帧覆盖本地乐观态——他人回复同样冻结本端按钮）。
 */
class ReplyLogicTest {

    // ---- ① 恰一校验矩阵 ----

    @Test
    fun `payload exactly one - option single path`() {
        assertEquals(ReplyPayload.Option("是"), buildReplyPayload("是", null))
        // 空白 text 视同未提供（与「null 视为未提供」truthiness 同源）
        assertEquals(ReplyPayload.Option("是"), buildReplyPayload("是", ""))
        assertEquals(ReplyPayload.Option("已处理"), buildReplyPayload(" 已处理 ", null))
    }

    @Test
    fun `payload exactly one - text single path`() {
        assertEquals(ReplyPayload.Text("已重启服务"), buildReplyPayload(null, "已重启服务"))
        assertEquals(ReplyPayload.Text("已重启服务"), buildReplyPayload("", " 已重启服务 "))
    }

    @Test
    fun `payload exactly one - mutual exclusion rejects both-or-none`() {
        // 同真（同时存在——UI 层禁止：快捷点击即清空输入框/反之亦然）
        assertEquals(ReplyPayload.Invalid, buildReplyPayload("是", "自定义内容"))
        // 全空
        assertEquals(ReplyPayload.Invalid, buildReplyPayload(null, null))
        assertEquals(ReplyPayload.Invalid, buildReplyPayload("", ""))
        // 空白视同未提供 → 两「空」同假
        assertEquals(ReplyPayload.Invalid, buildReplyPayload("  ", "   "))
    }

    // ---- ② not_connected fail-fast ----

    @Test
    fun `not connected outcome maps send result and never queues`() {
        // sendReply 返回 false（未建连）→ NotConnected：fail-fast，不排队不重试
        //（pushhub.ts:164-176 语义——用户重试属 UI 业务层，Toast 提示）
        assertEquals(ReplySendOutcome.NotConnected, replySendOutcome(sendOk = false))
        assertEquals(ReplySendOutcome.Sent, replySendOutcome(sendOk = true))
    }

    // ---- ③ by 序列化双路（D-72/D-53） ----

    @Test
    fun `by key omitted when displayName is null`() {
        val json = encodeReplyFrameJson(wid = "m_1", selectedOption = "是", text = null, displayName = null)
        assertFalse("displayName 为 null 时输出无 by 键（匿名回复）", json.contains("\"by\""))
        // 结构锚：v/type/wid/selected_option 恰在；null text 省略（explicitNulls=false）
        assertTrue(json.contains("\"v\":1"))
        assertTrue(json.contains("\"type\":\"reply\""))
        assertTrue(json.contains("\"wid\":\"m_1\""))
        assertTrue(json.contains("\"selected_option\":\"是\""))
        assertFalse(json.contains("\"text\""))
    }

    @Test
    fun `by key carried when displayName present`() {
        val json = encodeReplyFrameJson(wid = "m_2", selectedOption = null, text = "文本回复", displayName = "运维甲")
        assertTrue("displayName 非空自动携带", json.contains("\"by\":\"运维甲\""))
        assertTrue(json.contains("\"text\":\"文本回复\""))
        // 空白展示名与 null 同效（缺省匿名）
        assertFalse(
            "空白 displayName 同匿名",
            encodeReplyFrameJson("m_3", "是", null, displayName = "   ").contains("\"by\""),
        )
    }

    // ---- ④ answered 冻结状态转移（RPL-05） ----

    @Test
    fun `answered freeze transitions`() {
        // 未答未发：可交互
        assertEquals(QuickReplyState.ACTIVE, quickReplyState(answered = false, pendingReply = false))
        // 未答 + 本地乐观（已发出待权威帧）：置灰等待
        assertEquals(QuickReplyState.PENDING, quickReplyState(answered = false, pendingReply = true))
        // 已答：冻结（服务端恰一锁定语义是权威源）
        assertEquals(QuickReplyState.FROZEN, quickReplyState(answered = true, pendingReply = false))
        // answered 权威帧覆盖本地乐观态——他人回复同样冻结本端按钮（防重复处置）
        assertEquals(QuickReplyState.FROZEN, quickReplyState(answered = true, pendingReply = true))
    }

    // ---- 状态条文案（Task 2 纯函数——Reconnecting 倒计时文本路径） ----

    @Test
    fun `status bar text branches with reconnect countdown path`() {
        assertEquals("在线", statusBarText(Status.Online))
        assertEquals("连接中", statusBarText(Status.Connecting))
        assertEquals("离线", statusBarText(Status.Offline))
        assertEquals("重连中", statusBarText(Status.Reconnecting))
        // 倒计时文本路径（ceil 秒）：Schedule(Reconnect) 剩余毫秒 → 文本
        assertEquals("重连中 · 2s", statusBarText(Status.Reconnecting, remainingMs = 1_500))
        assertEquals("重连中 · 1s", statusBarText(Status.Reconnecting, remainingMs = 1_000))
        // 无频道快照（hub 未发布该频道状态）：占位符
        assertEquals("…", statusBarText(null))
    }
}
