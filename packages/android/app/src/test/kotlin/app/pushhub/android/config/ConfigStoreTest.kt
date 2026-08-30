package app.pushhub.android.config

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import kotlin.io.path.createTempDirectory

/**
 * ConfigStore JVM 测试（06-04 Task 1——七类用例齐备）。
 *
 * 目录注入 + warn 注入（JVM 零 Android 依赖：android.util.Log 不触达，
 * 日志行由捕获 lambda 断言——密钥日志纪律的程序化证据）。
 *
 * JUnit4 断言参数序 (message, condition)。
 */
class ConfigStoreTest {

    private fun newStore(tag: String, logs: MutableList<String>? = null): Pair<ConfigStore, File> {
        val dir = createTempDirectory("pushhub-cfg-$tag").toFile()
        val store = if (logs == null) ConfigStore(dir) else ConfigStore(dir) { logs.add(it) }
        return store to dir
    }

    private fun channel(name: String, key: String = "phc_test_$name") = name to key

    // ---- ① save→load 往返一致 ----

    @Test
    fun saveLoadRoundtripPreservesFullConfig() {
        val (store, _) = newStore("roundtrip")
        val config = Config(
            server = "https://pushhub.dyun.org",
            channels = mutableListOf(
                ChannelConfig("ch1", "告警群", "phc_aaa"),
                ChannelConfig("ch2", "家人", "phc_bbb"),
            ),
            displayName = "我的手机",
        )
        store.save(config)
        assertEquals(config, store.load())
    }

    // ---- ② 损坏 JSON 回退默认不抛 ----

    @Test
    fun corruptedJsonFallsBackToDefaultsWithoutThrowing() {
        val logs = mutableListOf<String>()
        val (store, dir) = newStore("corrupted", logs)
        dir.resolve("config.json").writeText("{ not valid json !!!")
        val loaded = store.load()
        assertEquals(Config(), loaded)
        // 单行静态短句（不含文件内容与异常 message 原文）
        assertEquals(listOf("config file corrupted; using defaults"), logs)
    }

    // ---- ③ 上限 8 超限拒绝 ----

    @Test
    fun ninthChannelRejectedWithChannelLimitReached() {
        val (store, _) = newStore("limit")
        assertEquals(8, ConfigStore.MAX_CHANNELS)
        repeat(8) { i -> store.addChannel("频道$i", "phc_k$i") }
        assertThrows(ConfigError.ChannelLimitReached::class.java) {
            store.addChannel("第九个", "phc_k9")
        }
        assertEquals(8, store.load().channels.size)
    }

    // ---- ④ 重名拒绝 ----

    @Test
    fun duplicateNameRejected() {
        val (store, _) = newStore("dup")
        store.addChannel("告警群", "phc_a")
        assertThrows(ConfigError.DuplicateChannel::class.java) {
            store.addChannel("告警群", "phc_b")
        }
        assertEquals(1, store.load().channels.size)
    }

    @Test
    fun updateToExistingNameRejectedButRenameToSelfAllowed() {
        val (store, _) = newStore("dup-update")
        store.addChannel("甲", "phc_a")
        store.addChannel("乙", "phc_b")
        val id甲 = store.load().channels.first { it.name == "甲" }.id
        // 撞他频道名：拒绝
        assertThrows(ConfigError.DuplicateChannel::class.java) {
            store.updateChannel(id甲, "乙", "phc_a2")
        }
        // 原名更新 Key（名不变）：允许
        store.updateChannel(id甲, "甲", "phc_a2")
        assertEquals("phc_a2", store.load().channels.first { it.id == id甲 }.key)
    }

    // ---- ⑤ 删除不存在 id 报 NotFound ----

    @Test
    fun removeMissingIdThrowsChannelNotFound() {
        val (store, _) = newStore("remove-missing")
        assertThrows(ConfigError.ChannelNotFound::class.java) {
            store.removeChannel("ch404")
        }
        store.addChannel("甲", "phc_a")
        store.removeChannel("ch1")
        assertThrows(ConfigError.ChannelNotFound::class.java) {
            store.removeChannel("ch1")
        }
        assertTrue(store.load().channels.isEmpty())
    }

    // ---- ⑥ displayName 可空缺省 ----

    @Test
    fun displayNameNullableRoundtrip() {
        val (store, _) = newStore("display")
        // 缺省 null（匿名回复——by 键不序列化，D-72）
        assertEquals(null, store.load().displayName)
        store.save(Config(server = "https://s", displayName = null))
        assertEquals(null, store.load().displayName)
        store.save(Config(server = "https://s", displayName = "笔电"))
        assertEquals("笔电", store.load().displayName)
    }

    // ---- ⑦ 密钥日志纪律：损坏文件日志不含 key 子串 ----

    @Test
    fun corruptedFileLogLinesContainNoKeyMaterial() {
        val secret = "phc_SUPER\"SECRET/key%42"
        val logs = mutableListOf<String>()
        val (store, dir) = newStore("secret", logs)
        // 构造含特殊字符 key 的损坏文件（JSON 在 key 处截断——解析必失败）
        dir.resolve("config.json").writeText(
            """{"server":"https://s","channels":[{"id":"ch1","name":"a","key":"$secret""",
        )
        assertEquals(Config(), store.load())
        assertTrue(logs.isNotEmpty())
        // 每条日志行均不得含 key 子串（含 key 的任何片段）
        for (line in logs) {
            assertTrue(
                "log line must not contain key material: <$line>",
                !line.contains(secret) && !line.contains("phc_"),
            )
        }
    }

    // ---- 附：id 单调不复用（D-87 通知通道锚纪律） ----

    @Test
    fun channelIdsNeverReusedAfterRemoval() {
        val (store, _) = newStore("id-reuse")
        val a = store.addChannel("甲", "phc_a")
        val b = store.addChannel("乙", "phc_b")
        assertEquals("ch1", a.id)
        assertEquals("ch2", b.id)
        store.removeChannel(a.id)
        val c = store.addChannel("丙", "phc_c")
        // 删除 ch1 后新频道取 ch3（max+1），绝不复用 ch1
        assertEquals("ch3", c.id)
    }
}
