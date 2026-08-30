package app.pushhub.android

import app.pushhub.android.protocol.FrameResult
import app.pushhub.android.protocol.PROTOCOL_VERSION
import app.pushhub.android.protocol.ServerFrame
import app.pushhub.android.protocol.SYNC_LIMIT_DEFAULT
import app.pushhub.android.protocol.lenientJson
import app.pushhub.android.protocol.parseServerFrame
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 帧解析 tracer 测试（06-01 Task 3）——golden fixtures 单一事实源直读
 * （A7 通路：FixturesProbeTest 已验证相对路径可达，本测试消费 fixture 内容）。
 *
 * 三档分流对齐 frames.ts:140-185：正例 Ok / v 门 Fatal / 其余 Drop；
 * 未知 type → Drop（D-07 前瞻兼容——error/answered 帧型 06-03 接入后翻转为 Ok）。
 */
class FramesTracerTest {

    private val fixturesDir = File("../../shared/fixtures")

    private fun fixture(name: String): String = File(fixturesDir, name).readText()

    // ---- 正例：golden fixtures 直读 ----

    @Test
    fun `pong fixture parses ok with unknown note field ignored`() {
        val result = parseServerFrame(fixture("pong-frame.positive.json"))
        assertTrue("pong 正例必须 Ok: $result", result is FrameResult.Ok)
        assertEquals(ServerFrame.Pong(v = 1), (result as FrameResult.Ok).frame)
    }

    @Test
    fun `message fixture parses ok with all thirteen fields`() {
        val result = parseServerFrame(fixture("message-frame.positive.json"))
        assertTrue("message 正例必须 Ok: $result", result is FrameResult.Ok)
        val frame = (result as FrameResult.Ok).frame as ServerFrame.Message
        assertEquals("m_2E9fKm3PqR7vXyZa", frame.wid)
        assertEquals(42L, frame.seq)
        assertEquals("Deploy finished", frame.title)
        assertEquals("high", frame.priority)
        assertEquals(false, frame.answered)
        assertEquals(null, frame.answeredBy)
        assertEquals(null, frame.answeredAt)
        assertEquals(null, frame.answeredContent)
        assertEquals(1756185600000L, frame.createdAt)
        assertEquals(3, frame.options?.size)
        assertEquals("https://ci.example.com/hooks/pushhub-callback", frame.callbackUrl)
        assertEquals("https://ci.example.com/runs/8123", frame.clickUrl)
    }

    @Test
    fun `history fixture array all frames parse ok`() {
        // history-frame.positive.json 是数组（多个 history 帧样本）。
        val frames = lenientJson.parseToJsonElement(fixture("history-frame.positive.json"))
        assertTrue(frames is JsonArray)
        var count = 0
        for (element in frames as JsonArray) {
            val result = parseServerFrame(element.toString())
            assertTrue("history 正例必须 Ok: $result", result is FrameResult.Ok)
            assertTrue((result as FrameResult.Ok).frame is ServerFrame.History)
            count++
        }
        assertTrue("history fixtures 至少 1 帧", count >= 1)
    }

    @Test
    fun `history negative fixture frames all drop`() {
        // {_violation, frame} 数组：每个 frame 均为结构违例（缺 oldest_kept_seq/
        // 嵌套元素缺 v 等）→ Drop。v 字段无默认值是嵌套元素缺 v 被拒的关键。
        val cases = lenientJson.parseToJsonElement(fixture("history-frame.negative.json"))
        var count = 0
        for (case in cases as JsonArray) {
            val frame = case.jsonObject["frame"] ?: continue
            val result = parseServerFrame(frame.toString())
            assertTrue("负例必须 Drop: $result", result is FrameResult.Drop)
            count++
        }
        assertTrue("负例至少 1 条", count >= 1)
    }

    // ---- 三档分流：v 门 Fatal / 非 JSON / 非对象 / 未知 type ----

    @Test
    fun `version gate v2 is fatal`() {
        val result = parseServerFrame("""{"v":2,"type":"pong"}""")
        assertTrue("v:2 必须 Fatal（D-07 客户端严格）: $result", result is FrameResult.Fatal)
    }

    @Test
    fun `missing v is fatal`() {
        val result = parseServerFrame("""{"type":"pong"}""")
        assertTrue("v 缺失必须 Fatal: $result", result is FrameResult.Fatal)
    }

    @Test
    fun `unparseable json drops`() {
        assertEquals(FrameResult.Drop("unparseable"), parseServerFrame("not json {"))
    }

    @Test
    fun `non object frame drops`() {
        assertEquals(FrameResult.Drop("non-object"), parseServerFrame("[1,2,3]"))
        assertEquals(FrameResult.Drop("non-object"), parseServerFrame("42"))
    }

    @Test
    fun `unknown frame type drops non fatal`() {
        // A2 实证：未知 discriminator 抛 SerializationException → Drop。
        // ws-error-frame.json 是 type:"error" 数组——06-03 起已接入 error 帧型
        //（FixturesContractTest 消费正例）；此处改用真未知 type 验证前瞻兼容。
        assertTrue(
            parseServerFrame("""{"v":1,"type":"future-thing","x":1}""") is FrameResult.Drop,
        )
        // 内联未知 type 同语义（06-03 起 answered 已接入，换成真未知值）。
        assertTrue(
            parseServerFrame("""{"v":1,"type":"answered2","wid":"m_x"}""") is FrameResult.Drop,
        )
    }

    @Test
    fun `known type structure violation drops`() {
        // message 缺必填 text → 深校验 shape 违例 → Drop（非致命，连接保持）。
        assertTrue(
            parseServerFrame("""{"v":1,"type":"message","wid":"m_x","seq":1,"priority":"normal","answered":false,"created_at":1}""")
                is FrameResult.Drop,
        )
    }

    // ---- fixtures 全量可读性（A7 真值面：全部 15 个 JSON 均可被 Kotlin 侧解析）----

    @Test
    fun `all fifteen golden fixtures are machine readable from kotlin side`() {
        val files = fixturesDir.listFiles { f -> f.isFile && f.extension == "json" }.orEmpty()
        assertEquals(15, files.size)
        for (file in files) {
            // 全部 fixtures 均为合法 JSON（对象或数组）——Kotlin 侧机器可读性契约。
            lenientJson.parseToJsonElement(file.readText())
        }
    }

    // ---- 协议常量锚定 ----

    @Test
    fun `protocol constants match shared source verbatim`() {
        assertEquals(1, PROTOCOL_VERSION)
        assertEquals(200, SYNC_LIMIT_DEFAULT)
    }
}
