package app.pushhub.android.adapter

import app.pushhub.android.config.ChannelConfig
import app.pushhub.android.config.Config
import app.pushhub.android.machine.Status

/**
 * 多频道频道数上限（D-79——对齐桌面端 D-64 心智统一；第 9 个 add 抛
 * [ManagerError.ChannelLimitReached]）。与 ConfigStore.MAX_CHANNELS 同值
 * （配置层先限，运行时层防御性再限——双保险）。
 */
const val MAX_CHANNELS: Int = 8

/**
 * manager 错误面（桌面 manager.rs:38-46 ManagerError 同构——sealed 三变体，
 * UI/Service 层按类型分流处理）。
 */
sealed class ManagerError : Exception() {
    /** 超出 [MAX_CHANNELS] 上限（D-79）。 */
    class ChannelLimitReached : ManagerError()

    /** 频道名已存在（add/update 拒绝——对齐 ConfigStore 重名校验语义）。 */
    class DuplicateChannel(val name: String) : ManagerError()

    /** 频道不存在（remove/update 未命中）。 */
    class ChannelNotFound(val id: String) : ManagerError()
}

/**
 * 多频道生命周期管理器（06-07 Task 1，D-79——桌面 adapter/manager.rs 同构，
 * 第三端）：每频道独立运行时（机器 + adapter + 缓冲 + 状态单元），一频道断连/
 * 重建不影响其他频道。
 *
 * 本类只做生命周期控制面：add/remove/update/状态聚合/探活广播/配置 diff 同步；
 * 连接语义全部在 [ChannelRuntime]（生产 = OkHttpChannelRuntime）内。
 *
 * 并发模型（桌面「&self + 内部 Mutex」同构）：所有方法经 [lock] 串行；runtime
 * 的 destroy/启动在锁外调用（destroy 内部同步收敛，无跨调用等待——Android 单
 * 进程内无需桌面 detach 有界等待的异步化）。
 *
 * 写入方 = PushHubService（装配/syncFromConfig/setVisibility/destroyAll）；
 * 读取方 = FGS 汇总通知（statuses）+ MainActivity tab 渲染（configs）。
 */
class ChannelManager(private val factory: ChannelRuntimeFactory) {

    private val lock = Any()

    /** 服务端基址（syncFromConfig 记忆——server 变更即全量重建判定）。 */
    private var server: String = ""

    /** 频道表（id → 运行时项；插入序即 tab 序）。 */
    private val entries = LinkedHashMap<String, Entry>()

    private class Entry(
        val id: String,
        var name: String,
        var key: String,
        val runtime: ChannelRuntime,
    )

    /** 当前频道数（UI 上限提示数据源）。 */
    val channelCount: Int
        get() = synchronized(lock) { entries.size }

    /** 当前频道配置快照（按加入序——MainActivity tab 渲染数据源）。 */
    fun configs(): List<ChannelConfig> = synchronized(lock) {
        entries.values.map { ChannelConfig(id = it.id, name = it.name, key = it.key) }
    }

    /**
     * 新增频道并启动连接（重名拒绝；超 [MAX_CHANNELS] 拒绝——D-79）。
     * 重名校验按 name（对齐 ConfigStore.addChannel 语义——id 由配置层单调生成
     * 恒不重复，name 是用户可撞的维度）。
     */
    fun addChannel(config: ChannelConfig) {
        val runtime = synchronized(lock) {
            if (entries.values.any { it.name == config.name }) {
                throw ManagerError.DuplicateChannel(config.name)
            }
            if (entries.size >= MAX_CHANNELS) {
                throw ManagerError.ChannelLimitReached()
            }
            val r = factory.create(config)
            entries[config.id] = Entry(config.id, config.name, config.key, r)
            r
        }
        runtime.start()
    }

    /**
     * 移除频道：句柄出表（statuses/configs 即时不可见）+ runtime 销毁
     * （Destroy 有界收敛——缓冲随 runtime 丢弃）。不存在抛 [ManagerError.ChannelNotFound]。
     */
    fun removeChannel(id: String) {
        val entry = synchronized(lock) {
            entries.remove(id) ?: throw ManagerError.ChannelNotFound(id)
        }
        entry.runtime.destroy()
    }

    /**
     * 更新频道（桌面 05-05 update_channel 同构语义）：
     *  - **key 变更 = remove + add 重建**（连接身份变化——旧 runtime destroy、
     *    新 runtime create，机器/缓冲全新）；缓冲丢弃后由首拉 50 条回填
     *    （D-63 服务端 accept 即推——重建即恢复最近窗口）；
     *  - **仅改名 = name 元数据轻更新**（零重建零断连——连接照旧，通知标题与
     *    tab 文本经 configs() 读到新名；通道 ID 用 id 不受改名影响，D-87）。
     *
     * 不存在抛 [ManagerError.ChannelNotFound]；新名与其他频道撞名抛
     * [ManagerError.DuplicateChannel]。
     */
    fun updateChannel(config: ChannelConfig) {
        val oldRuntime: ChannelRuntime?
        synchronized(lock) {
            val entry = entries[config.id] ?: throw ManagerError.ChannelNotFound(config.id)
            if (entries.values.any { it.id != config.id && it.name == config.name }) {
                throw ManagerError.DuplicateChannel(config.name)
            }
            if (entry.key == config.key) {
                entry.name = config.name // 仅改名：轻更新零重建
                return
            }
            entries.remove(config.id) // key 变更：出表，锁外销毁后重建
            oldRuntime = entry.runtime
        }
        oldRuntime?.destroy()
        addChannel(config)
    }

    /** 状态聚合（FGS 常驻通知汇总文本数据源；按 id 排序稳定输出——manager.rs:249-257）。 */
    fun statuses(): List<Pair<String, Status>> = synchronized(lock) {
        entries.values.map { it.id to it.runtime.status }.sortedBy { it.first }
    }

    /** 探活广播（D-27）：逐频道 Visibility 事件（连接保持，仅心跳/探活策略切换）。 */
    fun setVisibility(visible: Boolean) {
        val runtimes = synchronized(lock) { entries.values.map { it.runtime } }
        runtimes.forEach { it.setVisibility(visible) }
    }

    /** 回复出站口查询（service 经 ChannelHub.currentChannelId 挂载当前频道——06-06 契约）。 */
    fun replyAdapterOf(id: String): OkHttpChannelAdapter? = synchronized(lock) {
        entries[id]?.runtime?.replyAdapter
    }

    /**
     * 全部频道停机（service onDestroy 调用）：逐频道 Destroy + 有界收敛
     * （manager.rs:269-280 destroy_all 同构——表清空即逻辑停机完成）。
     */
    fun destroyAll() {
        val drained = synchronized(lock) {
            val list = entries.values.toList()
            entries.clear()
            list
        }
        drained.forEach { it.runtime.destroy() }
    }

    /**
     * 配置同步（频道管理页变更后的唯一入口——替换 06-04 重启过渡语义）：
     * diff 配置与运行时，四分支增量收敛：
     *  1. **新增**（配置有、运行时无）→ addChannel（建连接）；
     *  2. **删除**（运行时有、配置无）→ removeChannel（断连接）；
     *  3. **key 变更** → updateChannel 重建（destroy 旧 + create 新）；
     *  4. **仅改名** → updateChannel 轻更新（零重建）；
     *  另：server 基址变更（配置层连带场景）→ 全量重建（连接基址变化，
     *  增量 diff 无意义）。
     *
     * 幂等：配置与运行时一致时零动作（重复调用安全）。
     */
    fun syncFromConfig(config: Config) {
        val serverChanged = synchronized(lock) {
            val changed = server != config.server
            server = config.server
            changed
        }
        // server 基址变更：全量重建（连接基址变化，增量 diff 无意义；空表时清空为 no-op）
        if (serverChanged) destroyAll()

        val currentIds: Set<String> = synchronized(lock) { entries.keys.toSet() }
        val targetIds = config.channels.map { it.id }.toSet()

        // 分支 2：删除
        for (id in currentIds - targetIds) removeChannel(id)

        // 分支 1/3/4：新增与更新
        for (channel in config.channels) {
            if (channel.id !in currentIds) {
                addChannel(channel)
                continue
            }
            val changed = synchronized(lock) {
                val entry = entries[channel.id] ?: return@synchronized false
                entry.key != channel.key || entry.name != channel.name
            }
            if (changed) updateChannel(channel)
        }
    }
}
