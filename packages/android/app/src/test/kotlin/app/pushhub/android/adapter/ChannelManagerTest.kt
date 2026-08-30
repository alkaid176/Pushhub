package app.pushhub.android.adapter

import app.pushhub.android.config.ChannelConfig
import app.pushhub.android.config.Config
import app.pushhub.android.machine.Status
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * ChannelManager 多频道生命周期测试（06-07 Task 1，D-79——JVM 纯逻辑，假 runtime
 * 零真连接；桌面 manager.rs:292-582 假 runner 测试先例的 Kotlin 同构）。
 *
 * 生命周期八类断言 + syncFromConfig diff 四分支全覆盖。
 */
class ChannelManagerTest {

    /** 假运行时：记录调用序列 + 状态单元模拟（start → Online，destroy → Offline）。 */
    private class FakeRuntime(val config: ChannelConfig) : ChannelRuntime {
        val calls = mutableListOf<String>()

        @Volatile
        private var currentStatus: Status = Status.Offline

        override fun start() {
            calls += "start"
            currentStatus = Status.Online
        }

        override fun setVisibility(visible: Boolean) {
            calls += "visibility:$visible"
        }

        override fun destroy() {
            calls += "destroy"
            currentStatus = Status.Offline
        }

        override fun sendReply(
            wid: String,
            selectedOption: String?,
            text: String?,
            by: String?,
        ): Boolean = true

        override val status: Status
            get() = currentStatus

        override val replyAdapter: OkHttpChannelAdapter?
            get() = null
    }

    /** 假工厂：记录 create 调用（配置快照）——断言重建/零重建的数据源。 */
    private class FakeFactory : ChannelRuntimeFactory {
        val created = mutableListOf<ChannelConfig>()
        val runtimes = mutableListOf<FakeRuntime>()

        override fun create(channel: ChannelConfig): ChannelRuntime =
            FakeRuntime(channel).also {
                created += channel
                runtimes += it
            }
    }

    private fun cfg(id: String, name: String = "n-$id", key: String = "phc_$id") =
        ChannelConfig(id = id, name = name, key = key)

    private fun managerWith(factory: FakeFactory = FakeFactory()) =
        factory to ChannelManager(factory)

    // ---- 常量与上限 ----

    /** MAX_CHANNELS 常量（D-79——源码断言对应的行为锚）。 */
    @Test
    fun `max channels constant is 8`() {
        assertEquals(8, MAX_CHANNELS)
    }

    /** 上限边界：第 8 个允许、第 9 个拒绝（ChannelLimitReached）。 */
    @Test
    fun `max channels boundary 8 ok 9 rejected`() {
        val (_, mgr) = managerWith()
        for (i in 1..8) {
            mgr.addChannel(cfg("ch$i"))
        }
        assertEquals(8, mgr.channelCount)
        val err = org.junit.Assert.assertThrows(
            ManagerError.ChannelLimitReached::class.java,
        ) { mgr.addChannel(cfg("ch9")) }
        assertTrue(err is ManagerError.ChannelLimitReached)
        assertEquals(8, mgr.channelCount)
    }

    /** 重名拒绝（DuplicateChannel——按 name 维度，对齐 ConfigStore 语义）。 */
    @Test
    fun `duplicate channel name rejected`() {
        val (_, mgr) = managerWith()
        mgr.addChannel(cfg("ch1", name = "alerts"))
        org.junit.Assert.assertThrows(ManagerError.DuplicateChannel::class.java) {
            mgr.addChannel(cfg("ch2", name = "alerts"))
        }
        assertEquals(1, mgr.channelCount)
    }

    /** 删除不存在频道：ChannelNotFound。 */
    @Test
    fun `remove unknown channel not found`() {
        val (_, mgr) = managerWith()
        val err = org.junit.Assert.assertThrows(ManagerError.ChannelNotFound::class.java) {
            mgr.removeChannel("ghost")
        }
        assertEquals("ghost", err.id)
    }

    /** 更新不存在频道：ChannelNotFound。 */
    @Test
    fun `update unknown channel not found`() {
        val (_, mgr) = managerWith()
        org.junit.Assert.assertThrows(ManagerError.ChannelNotFound::class.java) {
            mgr.updateChannel(cfg("ghost"))
        }
    }

    // ---- update 语义（key 变更重建 / 仅改名轻更新） ----

    /** key 变更 = remove + add 重建：旧 runtime destroy 恰一次 + 新 runtime create 恰一次。 */
    @Test
    fun `update with key change rebuilds runtime`() {
        val (factory, mgr) = managerWith()
        mgr.addChannel(cfg("ch1", key = "old_key"))
        assertEquals(1, factory.created.size)

        mgr.updateChannel(cfg("ch1", key = "new_key"))

        assertEquals("新 runtime create 恰一次（重建）", 2, factory.created.size)
        assertEquals("旧 runtime destroy 恰一次（重建）", 1, factory.runtimes[0].calls.count { it == "destroy" })
        assertEquals("新 runtime start 恰一次", 1, factory.runtimes[1].calls.count { it == "start" })
        assertEquals(1, mgr.channelCount)
    }

    /** 仅改名：name 元数据轻更新，零重建（create/destroy 均零次）。 */
    @Test
    fun `update rename only zero rebuild`() {
        val (factory, mgr) = managerWith()
        mgr.addChannel(cfg("ch1", name = "old-name"))

        mgr.updateChannel(cfg("ch1", name = "new-name", key = "phc_ch1"))

        assertEquals("仅改名零 create", 1, factory.created.size)
        assertEquals("仅改名零 destroy", 0, factory.runtimes[0].calls.count { it == "destroy" })
        assertEquals("configs 读到新名", "new-name", mgr.configs().single().name)
    }

    /** update 撞他人频道名：DuplicateChannel 且零副作用。 */
    @Test
    fun `update colliding name rejected`() {
        val (factory, mgr) = managerWith()
        mgr.addChannel(cfg("ch1", name = "one"))
        mgr.addChannel(cfg("ch2", name = "two"))
        org.junit.Assert.assertThrows(ManagerError.DuplicateChannel::class.java) {
            mgr.updateChannel(cfg("ch2", name = "one"))
        }
        assertEquals("拒绝路径零重建", 2, factory.created.size)
    }

    // ---- 聚合与广播 ----

    /** statuses 聚合：自运行时状态单元读、按 id 排序（FGS 汇总数据源语义）。 */
    @Test
    fun `statuses aggregate from runtimes sorted by id`() {
        val (_, mgr) = managerWith()
        mgr.addChannel(cfg("ch2"))
        mgr.addChannel(cfg("ch1"))
        assertEquals(
            listOf("ch1" to Status.Online, "ch2" to Status.Online),
            mgr.statuses(),
        )
    }

    /** remove 后 statuses 即时不可见（句柄出表语义）。 */
    @Test
    fun `remove drops from statuses immediately`() {
        val (_, mgr) = managerWith()
        mgr.addChannel(cfg("ch1"))
        mgr.addChannel(cfg("ch2"))
        mgr.removeChannel("ch1")
        assertEquals(listOf("ch2" to Status.Online), mgr.statuses())
    }

    /** setVisibility 逐频道广播（D-27——两频道均收到 visibility 事件）。 */
    @Test
    fun `visibility broadcasts to all channels`() {
        val (factory, mgr) = managerWith()
        mgr.addChannel(cfg("ch1"))
        mgr.addChannel(cfg("ch2"))
        mgr.setVisibility(true)
        mgr.setVisibility(false)
        for (runtime in factory.runtimes) {
            assertTrue(runtime.calls.contains("visibility:true"))
            assertTrue(runtime.calls.contains("visibility:false"))
        }
    }

    /** destroyAll 收敛：全部 destroy + 表清空。 */
    @Test
    fun `destroyAll converges all runtimes`() {
        val (factory, mgr) = managerWith()
        mgr.addChannel(cfg("ch1"))
        mgr.addChannel(cfg("ch2"))
        mgr.destroyAll()
        assertEquals(0, mgr.channelCount)
        assertTrue(mgr.statuses().isEmpty())
        for (runtime in factory.runtimes) {
            assertTrue(runtime.calls.contains("destroy"))
        }
    }

    /** configs 快照：按加入序 + name 动态（改名后读到新名——tab 渲染语义）。 */
    @Test
    fun `configs snapshot reflects renames`() {
        val (_, mgr) = managerWith()
        mgr.addChannel(cfg("ch1", name = "alerts"))
        mgr.addChannel(cfg("ch2", name = "family"))
        mgr.updateChannel(cfg("ch1", name = "ops", key = "phc_ch1"))
        assertEquals(listOf("ops", "family"), mgr.configs().map { it.name })
    }

    // ---- syncFromConfig diff 四分支 ----

    /** 分支 1 新增：配置新频道 → create + start（建连接）。 */
    @Test
    fun `sync adds new channels`() {
        val (factory, mgr) = managerWith()
        mgr.syncFromConfig(Config(server = "https://s", channels = mutableListOf(cfg("ch1"))))
        assertEquals(1, factory.created.size)
        assertTrue(factory.runtimes[0].calls.contains("start"))
        assertEquals(1, mgr.channelCount)
    }

    /** 分支 2 删除：配置移除频道 → destroy（断连接）。 */
    @Test
    fun `sync removes deleted channels`() {
        val (factory, mgr) = managerWith()
        mgr.syncFromConfig(
            Config(server = "https://s", channels = mutableListOf(cfg("ch1"), cfg("ch2"))),
        )
        mgr.syncFromConfig(Config(server = "https://s", channels = mutableListOf(cfg("ch1"))))
        assertEquals(1, mgr.channelCount)
        assertTrue("被删频道 runtime 收到 destroy", factory.runtimes[1].calls.contains("destroy"))
        assertFalse("保留频道零 destroy", factory.runtimes[0].calls.contains("destroy"))
    }

    /** 分支 3 key 变更：重建（destroy 旧 + create 新）。 */
    @Test
    fun `sync rebuilds on key change`() {
        val (factory, mgr) = managerWith()
        mgr.syncFromConfig(
            Config(server = "https://s", channels = mutableListOf(cfg("ch1", key = "k1"))),
        )
        mgr.syncFromConfig(
            Config(server = "https://s", channels = mutableListOf(cfg("ch1", key = "k2"))),
        )
        assertEquals("重建恰一次新 create", 2, factory.created.size)
        assertTrue(factory.runtimes[0].calls.contains("destroy"))
    }

    /** 分支 4 仅改名：轻更新零重建。 */
    @Test
    fun `sync rename only lightweight`() {
        val (factory, mgr) = managerWith()
        mgr.syncFromConfig(
            Config(server = "https://s", channels = mutableListOf(cfg("ch1", name = "a"))),
        )
        mgr.syncFromConfig(
            Config(server = "https://s", channels = mutableListOf(cfg("ch1", name = "b"))),
        )
        assertEquals("改名零重建", 1, factory.created.size)
        assertFalse(factory.runtimes[0].calls.contains("destroy"))
        assertEquals("b", mgr.configs().single().name)
    }

    /** 幂等：配置与运行时一致时零动作（重复 sync 安全）。 */
    @Test
    fun `sync idempotent when unchanged`() {
        val (factory, mgr) = managerWith()
        val config = Config(server = "https://s", channels = mutableListOf(cfg("ch1")))
        mgr.syncFromConfig(config)
        mgr.syncFromConfig(config.copy())
        assertEquals(1, factory.created.size)
        assertFalse(factory.runtimes[0].calls.contains("destroy"))
    }

    /** server 基址变更：全量重建（旧 runtime 全 destroy）。 */
    @Test
    fun `sync server change rebuilds all`() {
        val (factory, mgr) = managerWith()
        mgr.syncFromConfig(
            Config(server = "https://old", channels = mutableListOf(cfg("ch1"), cfg("ch2"))),
        )
        mgr.syncFromConfig(
            Config(server = "https://new", channels = mutableListOf(cfg("ch1"), cfg("ch2"))),
        )
        assertEquals("全量重建 create 恰两次", 4, factory.created.size)
        assertTrue(factory.runtimes[0].calls.contains("destroy"))
        assertTrue(factory.runtimes[1].calls.contains("destroy"))
    }
}
