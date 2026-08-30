package app.pushhub.android

import app.pushhub.android.protocol.BY_MAX
import app.pushhub.android.protocol.FrameResult
import app.pushhub.android.protocol.INITIAL_FETCH
import app.pushhub.android.protocol.PROTOCOL_VERSION
import app.pushhub.android.protocol.RETENTION_KEEP
import app.pushhub.android.protocol.ReplyFrame
import app.pushhub.android.protocol.SYNC_LIMIT_DEFAULT
import app.pushhub.android.protocol.SYNC_LIMIT_MAX
import app.pushhub.android.protocol.ServerFrame
import app.pushhub.android.protocol.lenientJson
import app.pushhub.android.protocol.parseServerFrame
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * golden fixtures 契约测试（06-03 Task 1，D-59 四端一致的 Kotlin 侧证据）。
 *
 * 全部 15 个 fixtures 经相对路径 ../../shared/fixtures 跨包直读（05-02 cargo
 * include_str! / 06-01 FixturesProbeTest A7 通路先例）——单一事实源零复制。
 * 断言模式与 packages/desktop/src-tauri/src/protocol/tests.rs 一一对照：
 *  - 正例逐字段冻结值断言（tests.rs:69-93 同款）；
 *  - 负例 Drop(fatal=false) / 无 v 字段例 Fatal；
 *  - _note 元数据字段是"未知字段忽略"（D-07）活体测试；
 *  - 方向说明（tests.rs:8-10）：reply/sync 是客户端 → 服务端帧——
 *    parseServerFrame（服务端 → 客户端方向）视角下均为未知 type → Drop；
 *    reply 正例经 ReplyFrame 反序列化消费（客户端发送侧契约面）。
 *
 * 深校验（JsonObject 层 shape 守卫）本地负例在此回归：v:"1" 字符串混淆 Fatal、
 * message 缺 wid Drop、options 超长 Drop、ack 恰三键、error 未知 code 前向兼容。
 */
class FixturesContractTest {

    private val fixturesDir = File("../../shared/fixtures")

    private fun fixture(name: String): String = File(fixturesDir, name).readText()

    private fun asArray(name: String): List<JsonObject> {
        val parsed = lenientJson.parseToJsonElement(fixture(name))
        assertTrue("$name 必须是 JSON 数组", parsed is JsonArray)
        return (parsed as JsonArray).map { it.jsonObject }
    }

    // ---- A2 实证（本测试族首条）：未知 type 的 SerializationException 行为 ----

    /**
     * A2 假设实证：未知 discriminator 的合法 JSON 交给 sealed decode 抛
     * SerializationException（被 parseServerFrame 捕获归 Drop）。若 kotlinx
     * 行为变化（不抛/抛其他类型），此测试首先变红——届时按计划回退手写
     * type 字符串分流。
     */
    @Test
    fun `a2 unknown type json element throws SerializationException on sealed decode`() {
        val element = lenientJson.parseToJsonElement("""{"v":1,"type":"future-thing","x":1}""")
        var threw = false
        try {
            lenientJson.decodeFromJsonElement(ServerFrame.serializer(), element)
        } catch (e: SerializationException) {
            threw = true
        }
        assertTrue("未知 type 必须 SerializationException（A2 实证）", threw)
        // parseServerFrame 端到端归 Drop（fatal=false）。
        assertEquals(
            FrameResult.Drop("unknown frame type"),
            parseServerFrame("""{"v":1,"type":"future-thing","x":1}"""),
        )
    }

    // ---- 文件清单：恰 15 个 golden fixtures，静态清单与目录一一对应 ----

    private val goldenFiles = listOf(
        "answered-frame.positive.json",
        "error-envelope.invalid-body.json",
        "error-envelope.invalid-key.json",
        "error-envelope.payload-too-large.json",
        "error-envelope.rate-limited.json",
        "history-frame.negative.json",
        "history-frame.positive.json",
        "message-frame.negative.json",
        "message-frame.positive.json",
        "pong-frame.positive.json",
        "reply-frame.negative.json",
        "reply-frame.positive.json",
        "sync-frame.negative.json",
        "sync-frame.positive.json",
        "ws-error-frame.json",
    )

    @Test
    fun `fixtures directory contains exactly the fifteen golden files`() {
        assertEquals("静态清单恰 15 项", 15, goldenFiles.size)
        val onDisk = fixturesDir.listFiles { f -> f.isFile && f.extension == "json" }
            .orEmpty().map { it.name }.sorted()
        assertEquals("目录与静态清单一一对应（零复制直读单一事实源）", goldenFiles.sorted(), onDisk)
    }

    // ---- 正例：逐字段冻结值断言（tests.rs:69-93 断言模式）----

    @Test
    fun `pong fixture ok with unknown note field ignored`() {
        val result = parseServerFrame(fixture("pong-frame.positive.json"))
        assertTrue("pong 正例必须 Ok: $result", result is FrameResult.Ok)
        assertEquals(ServerFrame.Pong(v = 1), (result as FrameResult.Ok).frame)
    }

    @Test
    fun `message fixture ok with thirteen fields frozen values`() {
        val result = parseServerFrame(fixture("message-frame.positive.json"))
        assertTrue("message 正例必须 Ok: $result", result is FrameResult.Ok)
        val frame = (result as FrameResult.Ok).frame as ServerFrame.Message
        assertEquals("m_2E9fKm3PqR7vXyZa", frame.wid)
        assertEquals(42L, frame.seq)
        assertEquals("Deploy finished", frame.title)
        assertEquals("# Build OK\n\nAll **3** checks passed. See [run log](https://ci.example.com/runs/8123).", frame.text)
        assertEquals(listOf("Acknowledge", "Retry deploy", "Escalate"), frame.options)
        assertEquals("https://ci.example.com/hooks/pushhub-callback", frame.callbackUrl)
        assertEquals("https://ci.example.com/runs/8123", frame.clickUrl)
        assertEquals("high", frame.priority)
        assertEquals(false, frame.answered)
        assertEquals(null, frame.answeredBy)
        assertEquals(null, frame.answeredAt)
        assertEquals(null, frame.answeredContent)
        assertEquals(1756185600000L, frame.createdAt)
    }

    @Test
    fun `history fixture positive both entries ok with frozen metadata`() {
        val arr = asArray("history-frame.positive.json")
        assertEquals("翻页例 + 首拉例", 2, arr.size)
        for (entry in arr) {
            val result = parseServerFrame(entry.toString())
            assertTrue("history 正例必须 Ok: $result", result is FrameResult.Ok)
            val h = (result as FrameResult.Ok).frame as ServerFrame.History
            // 解析条数与 fixture 原文一致；seq 严格升序（服务端契约）。
            val origLen = (entry["messages"] as JsonArray).size
            assertEquals(origLen, h.messages.size)
            val seqs = h.messages.map { it.seq }
            assertTrue("seq 严格升序: $seqs", seqs.zipWithNext().all { (a, b) -> a < b })
        }
        // fixtures 冻结值（双例分断言——TS/Rust 同款）。
        val paging = parseServerFrame(arr[0].toString()) as FrameResult.Ok
        val pagingFrame = paging.frame as ServerFrame.History
        assertEquals(2, pagingFrame.messages.size)
        assertEquals(41L, pagingFrame.oldestKeptSeq)
        assertTrue("翻页例 has_more=true", pagingFrame.hasMore)
        val firstFetch = parseServerFrame(arr[1].toString()) as FrameResult.Ok
        val firstFetchFrame = firstFetch.frame as ServerFrame.History
        assertEquals("首拉例恰 50 条（INITIAL_FETCH）", 50, firstFetchFrame.messages.size)
        assertEquals(1L, firstFetchFrame.oldestKeptSeq)
        assertFalse("首拉例 has_more=false", firstFetchFrame.hasMore)
    }

    @Test
    fun `answered fixture positive both entries fields verbatim`() {
        val arr = asArray("answered-frame.positive.json")
        assertEquals("自报展示名 + 匿名两形态", 2, arr.size)
        val answeredByValues = mutableListOf<String?>()
        for (entry in arr) {
            val result = parseServerFrame(entry.toString())
            assertTrue("answered 正例必须 Ok: $result", result is FrameResult.Ok)
            val a = (result as FrameResult.Ok).frame as ServerFrame.Answered
            assertEquals(entry["wid"]!!.jsonPrimitive.content, a.wid)
            assertEquals(entry["seq"]!!.jsonPrimitive.content.toLong(), a.seq)
            assertTrue("冻结形态恒 true（D-45）", a.answered)
            assertEquals(entry["answered_at"]!!.jsonPrimitive.content.toLong(), a.answeredAt)
            val expectedContent = entry["answered_content"]?.jsonPrimitive?.content
            assertEquals(expectedContent, a.answeredContent)
            answeredByValues += a.answeredBy
            // _note 字段存在且被忽略（D-07 活体测试）。
            assertTrue("fixtures 带 _note 元数据", entry.containsKey("_note"))
        }
        assertEquals(
            "两形态在位：自报展示名 + 匿名（answered_by null）",
            listOf("运维笔记本", null),
            answeredByValues,
        )
    }

    @Test
    fun `ws error fixture all four codes in frozen order`() {
        val arr = asArray("ws-error-frame.json")
        assertEquals(4, arr.size)
        val codes = mutableListOf<String>()
        for (entry in arr) {
            val result = parseServerFrame(entry.toString())
            assertTrue("error 正例必须 Ok: $result", result is FrameResult.Ok)
            val e = (result as FrameResult.Ok).frame as ServerFrame.Error
            assertEquals(entry["code"]!!.jsonPrimitive.content, e.code)
            assertEquals(entry["message"]!!.jsonPrimitive.content, e.message)
            codes += e.code
        }
        // 04-01 追加 already_replied / not_found 两例的冻结顺序。
        assertEquals(
            listOf("invalid_version", "invalid_frame", "already_replied", "not_found"),
            codes,
        )
    }

    // ---- 负例：Fatal（v 缺失/不匹配）与 Drop（结构违例/未知 type）----

    @Test
    fun `error envelope fixtures fatal version gate first`() {
        // HTTP 信封非帧形态（无 v 字段）→ Fatal（D-07 版本门先行，TS/Rust 同款）。
        for (name in listOf(
            "error-envelope.invalid-body.json",
            "error-envelope.invalid-key.json",
            "error-envelope.payload-too-large.json",
            "error-envelope.rate-limited.json",
        )) {
            assertTrue("$name 无 v 字段必须 Fatal", parseServerFrame(fixture(name)) is FrameResult.Fatal)
        }
    }

    @Test
    fun `message negative fixture bodies all fatal no v field`() {
        val arr = asArray("message-frame.negative.json")
        assertEquals(8, arr.size)
        for (entry in arr) {
            val raw = entry["body"]!!.toString()
            assertTrue(
                "请求体反例无 v 字段 → Fatal, violation=${entry["_violation"]}",
                parseServerFrame(raw) is FrameResult.Fatal,
            )
        }
    }

    @Test
    fun `history negative fixture each violation drops`() {
        val arr = asArray("history-frame.negative.json")
        assertEquals(3, arr.size)
        for (entry in arr) {
            val raw = entry["frame"]!!.toString()
            val result = parseServerFrame(raw)
            assertTrue(
                "负例必须 Drop(fatal=false), violation=${entry["_violation"]}: $result",
                result is FrameResult.Drop,
            )
        }
    }

    @Test
    fun `sync negative fixture v2 fatal others drop`() {
        val arr = asArray("sync-frame.negative.json")
        assertEquals(5, arr.size)
        for (entry in arr) {
            val raw = entry["frame"]!!.toString()
            val isV2 = entry["frame"]!!.jsonObject["v"]?.jsonPrimitive?.content == "2"
            when (val result = parseServerFrame(raw)) {
                is FrameResult.Fatal -> assertTrue(
                    "仅 v:2 例为 fatal, violation=${entry["_violation"]}", isV2,
                )
                is FrameResult.Drop -> assertFalse(
                    "v:2 例必须 fatal, violation=${entry["_violation"]}", isV2,
                )
                is FrameResult.Ok -> throw AssertionError(
                    "sync 是客户端帧——服务端方向未知 type，got Ok(${result.frame}), violation=${entry["_violation"]}",
                )
            }
        }
    }

    @Test
    fun `sync positive fixture drops as client direction frame`() {
        for (entry in asArray("sync-frame.positive.json")) {
            assertTrue(
                "sync 是客户端帧：服务端方向未知 type → Drop, entry=$entry",
                parseServerFrame(entry.toString()) is FrameResult.Drop,
            )
        }
    }

    @Test
    fun `reply negative fixture all drop in server direction`() {
        val arr = asArray("reply-frame.negative.json")
        assertEquals(9, arr.size)
        for (entry in arr) {
            val raw = entry["frame"]!!.toString()
            assertTrue(
                "reply 反例必须 Drop（v:1 为未知 type 分支；v 缺失/违例同理）, violation=${entry["_violation"]}",
                parseServerFrame(raw) is FrameResult.Drop,
            )
        }
    }

    @Test
    fun `reply positive fixture parses as client frame exactly one of option or text`() {
        val arr = asArray("reply-frame.positive.json")
        assertEquals(4, arr.size)
        var sawBy = false
        for (entry in arr) {
            // parseServerFrame 视角：客户端方向帧 → 未知 type Drop（方向说明）。
            assertTrue(
                "reply 是客户端帧：服务端方向未知 type",
                parseServerFrame(entry.toString()) is FrameResult.Drop,
            )
            // 客户端发送侧契约面：ReplyFrame 反序列化消费（tests.rs:285-309 同款）。
            val frame = lenientJson.decodeFromString<ReplyFrame>(entry.toString())
            assertEquals(1, frame.v)
            assertEquals("reply", frame.type)
            assertEquals("m_2E9fKm3PqR7vXyZa", frame.wid)
            // 恰一形态（selected_option XOR text——fixture 冻结）。
            val hasOpt = entry.containsKey("selected_option")
            val hasText = entry.containsKey("text")
            assertTrue("恰一形态: $entry", hasOpt != hasText)
            assertEquals(hasOpt, frame.selectedOption != null)
            assertEquals(hasText, frame.text != null)
            if (frame.by != null) sawBy = true
        }
        assertTrue("4 例中恰一带 by（自报展示名形态）", sawBy)
    }

    @Test
    fun `reply serialization omits absent optional fields`() {
        // D-72：by 缺省不序列化（键不出现即匿名回复）；encodeDefaults=false 省略语义。
        val frame = ReplyFrame(v = 1, type = "reply", wid = "m_2E9fKm3PqR7vXyZa", text = "done")
        val json = lenientJson.encodeToString(frame)
        assertFalse("by 缺省不序列化: $json", json.contains("by"))
        assertFalse("selected_option 缺省同省略: $json", json.contains("selected_option"))
        assertTrue(json.contains("\"text\":\"done\""))
        val withBy = frame.copy(by = "运维笔记本")
        val jsonBy = lenientJson.encodeToString(withBy)
        assertTrue("by 提供时序列化: $jsonBy", jsonBy.contains("\"by\":\"运维笔记本\""))
    }

    // ---- 本地负例（不改动 shared/fixtures；深校验守卫回归）----

    @Test
    fun `local negative v2 frame is fatal`() {
        assertTrue(parseServerFrame("""{"v":2,"type":"pong"}""") is FrameResult.Fatal)
    }

    @Test
    fun `local negative message missing wid drops`() {
        assertTrue(
            parseServerFrame(
                """{"v":1,"type":"message","seq":1,"text":"x","priority":"normal","answered":false,"answered_by":null,"answered_at":null,"answered_content":null,"created_at":1}""",
            ) is FrameResult.Drop,
        )
    }

    @Test
    fun `local negative options five items drops`() {
        assertTrue(
            parseServerFrame(
                """{"v":1,"type":"message","wid":"m_a","seq":1,"text":"x","options":["a","b","c","d","e"],"priority":"normal","answered":false,"answered_by":null,"answered_at":null,"answered_content":null,"created_at":1}""",
            ) is FrameResult.Drop,
        )
    }

    @Test
    fun `local negative string version digits fatal`() {
        // v 类型混淆（字符串 "1"）→ fatal——对齐 TS `parsed.v !== 1` 与 Rust 用例
        //（kotlinx intOrNull 会解析带引号数字，strictInt 先验 isString 拦截）。
        assertTrue(parseServerFrame("""{"v":"1","type":"pong"}""") is FrameResult.Fatal)
    }

    @Test
    fun `local negative seq zero and bad priority drop`() {
        // seq 非正整数 / priority 越界枚举 → Drop（深校验域守卫）。
        assertTrue(
            parseServerFrame(
                """{"v":1,"type":"message","wid":"m_a","seq":0,"text":"x","priority":"normal","answered":false,"answered_by":null,"answered_at":null,"answered_content":null,"created_at":1}""",
            ) is FrameResult.Drop,
        )
        assertTrue(
            parseServerFrame(
                """{"v":1,"type":"message","wid":"m_a","seq":1,"text":"x","priority":"urgent","answered":false,"answered_by":null,"answered_at":null,"answered_content":null,"created_at":1}""",
            ) is FrameResult.Drop,
        )
    }

    @Test
    fun `ack three key frame ok malformed wid drops`() {
        // 恰 v/type/wid 三键（未知字段照 D-07 忽略——_note 放行）。
        val ok = parseServerFrame("""{"v":1,"type":"ack","wid":"m_2E9fKm3PqR7vXyZa","_note":"x"}""")
        assertTrue("ack 正例必须 Ok: $ok", ok is FrameResult.Ok)
        assertEquals(
            "m_2E9fKm3PqR7vXyZa",
            ((ok as FrameResult.Ok).frame as ServerFrame.Ack).wid,
        )
        // wid 缺失 / 非字符串 → Drop。
        assertTrue(parseServerFrame("""{"v":1,"type":"ack"}""") is FrameResult.Drop)
        assertTrue(parseServerFrame("""{"v":1,"type":"ack","wid":42}""") is FrameResult.Drop)
    }

    @Test
    fun `error frame unknown code is forward compatible ok`() {
        // WsErrorFrame code 白名单外宽松兼容（D-07 前瞻兼容——服务端新增错误码
        // 不破坏旧客户端）。
        val result = parseServerFrame("""{"v":1,"type":"error","code":"future_code","message":"x"}""")
        assertTrue("未知 code 必须 Ok: $result", result is FrameResult.Ok)
        assertEquals("future_code", ((result as FrameResult.Ok).frame as ServerFrame.Error).code)
    }

    @Test
    fun `answered local deep guard violations drop`() {
        // answered_by 数字 → Drop（类型层）。
        assertTrue(
            parseServerFrame(
                """{"v":1,"type":"answered","wid":"m_x","seq":1,"answered":true,"answered_by":42,"answered_at":1756185660000,"answered_content":"x"}""",
            ) is FrameResult.Drop,
        )
        // answered_content 键缺失（键必须存在，值可 null）→ Drop。
        assertTrue(
            parseServerFrame(
                """{"v":1,"type":"answered","wid":"m_x","seq":1,"answered":true,"answered_by":null,"answered_at":1756185660000}""",
            ) is FrameResult.Drop,
        )
        // seq 负数（answered 守卫允许 0，拒绝负）→ Drop。
        assertTrue(
            parseServerFrame(
                """{"v":1,"type":"answered","wid":"m_x","seq":-1,"answered":true,"answered_by":null,"answered_at":1756185660000,"answered_content":"x"}""",
            ) is FrameResult.Drop,
        )
        // message 帧可空三字段键缺失（answered_by 等）→ Drop（键存在性守卫）。
        assertTrue(
            parseServerFrame(
                """{"v":1,"type":"message","wid":"m_a","seq":1,"text":"x","priority":"normal","answered":false,"answered_at":null,"answered_content":null,"created_at":1}""",
            ) is FrameResult.Drop,
        )
    }

    // ---- 协议常量锚定（shared/src/index.ts verbatim——数值变更即协议事件）----

    @Test
    fun `protocol constants match shared source verbatim`() {
        assertEquals(1, PROTOCOL_VERSION)
        assertEquals(200, SYNC_LIMIT_DEFAULT)
        assertEquals(500, SYNC_LIMIT_MAX)
        assertEquals(500, RETENTION_KEEP)
        assertEquals(50, INITIAL_FETCH)
        assertEquals(64, BY_MAX)
    }
}
