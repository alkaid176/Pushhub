package app.pushhub.android.adapter

import app.pushhub.android.config.ChannelConfig
import app.pushhub.android.machine.ConnectionMachine
import app.pushhub.android.machine.Status

/**
 * 单频道运行时契约（06-07 Task 1，D-79）——ChannelManager 的频道装配单元，
 * 桌面端 manager.rs SpawnInputs + ChannelRunner 工厂先例（64-82 行）的 Kotlin 同构。
 *
 * ChannelRuntime 封装单频道全部运行组件：机器 + adapter + Buffer + 状态单元
 * （生产实现 [OkHttpChannelRuntime] 组合既有 [OkHttpChannelAdapter]；测试注入
 * 假实现验证生命周期语义——**不建真连接**，manager.rs fake_runner 同款切面）。
 *
 * 生命周期契约：
 *  - [start]：装配后由 ChannelManager.addChannel 调用（Connect 事件）；
 *  - [setVisibility]：探活广播（D-27——MainActivity onResume/onStop 经
 *    ChannelManager.setVisibility 逐频道转发）；
 *  - [destroy]：终局销毁——Destroy 事件 + 定时器/串行队列有界收敛；**返回时
 *    频道已停机**（OkHttpChannelAdapter.destroy 同步取消 scope，无跨运行时
 *    等待——桌面 detach 有界等待 2s 的简化等价物，单进程内同步取消即收敛）。
 *
 * [status] 是本频道状态共享单元（manager.statuses() 聚合数据源——桌面
 * Arc<Mutex<Status>> 单元对应物）：生产实现经 ChannelEvents.onStatus 装饰器
 * 写入（EmitStatus 动作的唯一数据源，零缓存推断——状态诚实纪律）。
 *
 * [replyAdapter]：回复出站直发口（06-06 MessageFragment.replyChannelAdapter
 * 挂载消费——多频道路由：service 经 ChannelHub.currentChannelId 挂当前频道）。
 * 生产实现返回真 adapter；假实现返回 null（测试不触连接）。
 */
interface ChannelRuntime {
    /** 启动连接（Connect 事件——ChannelManager.addChannel 尾调用）。 */
    fun start()

    /** 探活广播（D-27：visible=true 立即 ping + 探活死线 + 心跳接管；false 取消）。 */
    fun setVisibility(visible: Boolean)

    /** 终局销毁（Destroy + 有界收敛；返回即停机）。 */
    fun destroy()

    /** 回复出站直发（WEB-03 Pattern 7：不进状态机；false = not_connected fail-fast）。 */
    fun sendReply(wid: String, selectedOption: String?, text: String?, by: String?): Boolean

    /** 当前连接状态（statuses() 聚合数据源——EmitStatus 写、manager 读）。 */
    val status: Status

    /** 出站 adapter 暴露（UI reply 挂载消费；假实现 null）。 */
    val replyAdapter: OkHttpChannelAdapter?
}

/**
 * 频道运行时工厂（测试切面注入点——manager.rs ChannelRunner 同构）：生产
 * [OkHttpChannelRuntimeFactory]；测试注入假工厂验证 ChannelManager 生命周期。
 */
interface ChannelRuntimeFactory {
    fun create(channel: ChannelConfig): ChannelRuntime
}

/**
 * 生产运行时（单频道机器 + adapter + 状态单元的完整装配）。
 *
 * 状态单元经 ChannelEvents 装饰器写入：onStatus 先更新 [@Volatile currentStatus]
 * 再转发宿主 events（ChannelWiring——通知/Hub/SpikeLog 路径不变），保证
 * manager.statuses() 与 UI 状态条/FGS 汇总同源（EmitStatus 唯一数据源，
 * 状态诚实纪律 AND-04 prohibition）。
 *
 * @param events 宿主事件接线（service 侧 ChannelWiring——通知两流分离/Hub 写入
 *   均在其中；本类只装饰 onStatus，其余按原样转发）。
 */
class OkHttpChannelRuntime(
    channelKey: String,
    serverUrl: String,
    events: ChannelEvents,
) : ChannelRuntime {

    @Volatile
    private var currentStatus: Status = Status.Offline

    private val wrappedEvents = object : ChannelEvents by events {
        override fun onStatus(status: Status) {
            currentStatus = status
            events.onStatus(status)
        }
    }

    internal val adapter: OkHttpChannelAdapter = OkHttpChannelAdapter(
        machine = ConnectionMachine(),
        serverUrl = serverUrl,
        channelKey = channelKey,
        events = wrappedEvents,
    )

    override fun start() = adapter.connect()

    override fun setVisibility(visible: Boolean) = adapter.setVisibility(visible)

    override fun destroy() = adapter.destroy()

    override fun sendReply(
        wid: String,
        selectedOption: String?,
        text: String?,
        by: String?,
    ): Boolean = adapter.sendReply(
        channelId = "", // 帧本身无 channel 字段（06-06 签名占位参数）
        wid = wid,
        selectedOption = selectedOption,
        text = text,
        by = by,
    )

    override val status: Status
        get() = currentStatus

    override val replyAdapter: OkHttpChannelAdapter
        get() = adapter
}

/**
 * 生产工厂：serverUrl 在 create 时读取（配置热更新路径 server 变更 →
 * ChannelManager.syncFromConfig 全量重建，新 runtime 拿新基址）；
 * eventsFor 由 service 侧提供（ChannelWiring 组装——通知/Hub/SpikeLog 依赖
 * 闭包捕获，adapter 包不依赖 service 包）。
 */
class OkHttpChannelRuntimeFactory(
    private val serverUrl: () -> String,
    private val eventsFor: (ChannelConfig) -> ChannelEvents,
) : ChannelRuntimeFactory {
    override fun create(channel: ChannelConfig): ChannelRuntime =
        OkHttpChannelRuntime(
            channelKey = channel.key,
            serverUrl = serverUrl(),
            events = eventsFor(channel),
        )
}
