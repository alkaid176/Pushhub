package app.pushhub.android.service

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import app.pushhub.android.R
import app.pushhub.android.adapter.ChannelEvents
import app.pushhub.android.adapter.ChannelManager
import app.pushhub.android.adapter.ChannelRuntimeFactory
import app.pushhub.android.adapter.OkHttpChannelRuntimeFactory
import app.pushhub.android.config.ConfigStore
import app.pushhub.android.hub.ChannelHub
import app.pushhub.android.machine.Buffer
import app.pushhub.android.machine.ErrorPayload
import app.pushhub.android.machine.Status
import app.pushhub.android.protocol.AnsweredFrame
import app.pushhub.android.protocol.HistoryFrame
import app.pushhub.android.protocol.MessageFrame
import app.pushhub.android.ui.MessageFragment
import kotlinx.coroutines.launch

/**
 * PushHub specialUse 前台服务（06-01 骨架 → 06-05 通知接线 → 06-07 多频道泛化，
 * AND-01/AND-02/D-79）。
 *
 * 架构位（RESEARCH 架构图 / D-59/D-60）：连接归 FGS 进程——UI（Activity）只是
 * 进程内共享状态的观察者，转屏/切走/锁屏不断连接。onCreate 首行（super 之后
 * 立即）startForeground 挂常驻通知（A3 五秒规则）。
 *
 * FGS 启动纪律（Pitfall 3）：只从前台 Activity（MainActivity）调
 * startForegroundService——Android 12+ 后台启动 FGS 被禁止；**无任何开机自启
 * 接收器与作业调度兜底**（D-86 裁决）。
 *
 * 06-07 泛化（D-79 多频道，替换 06-05 单频道直装配）：
 *  - **ChannelManager 装配**：读 ConfigStore 后经 [ChannelManager.syncFromConfig]
 *    装配全部配置频道（每频道独立运行时——一频道断连不影响其他）；
 *  - **配置热更新**：onStartCommand 处理 [ACTION_SYNC_CONFIG]（频道管理页变更后
 *    经 ServiceRestart 投递——**替换 06-04 的重启过渡语义**：不再 stop+start，
 *    syncFromConfig 增量 diff 四分支收敛，未变频道连接保持）；
 *  - **FGS 常驻通知汇总**：statuses() 聚合文本（「在线 N / 重连中 M」——D-81
 *    对齐桌面 tooltip 心智；状态变迁时更新）；
 *  - **探活广播转发**：collect [ChannelHub.appVisibility] → manager.setVisibility
 *    （D-27 第三端——MainActivity onResume/onStop 喂入）;
 *  - **回复出站口路由**：collect [ChannelHub.currentChannelId] → 挂载当前频道
 *    adapter 到 MessageFragment.replyChannelAdapter（06-06 契约的 06-07 接线）。
 */
class PushHubService : LifecycleService() {

    private lateinit var spikeLog: SpikeLog
    private lateinit var router: NotificationRouter
    private lateinit var hub: ChannelHub
    private lateinit var manager: ChannelManager

    override fun onCreate() {
        super.onCreate()
        // A3 五秒规则：super.onCreate 后立即 startForeground——先于任何连接装配。
        ensureChannel()
        startForeground(FGS_NOTIF_ID, buildStatusNotification(initialSummaryText))
        spikeLog = SpikeLog(filesDir.resolve("spike-log"))
        router = NotificationRouter(this)

        // ---- ChannelHub 装配（06-04 Task 4 契约面的写入方接线，Pitfall 4 双路）----
        hub = ChannelHub(
            runtimePermissionGranted = {
                ContextCompat.checkSelfPermission(
                    this,
                    Manifest.permission.POST_NOTIFICATIONS,
                ) == PackageManager.PERMISSION_GRANTED
            },
            notificationsEnabled = { NotificationManagerCompat.from(this).areNotificationsEnabled() },
            sdkInt = { Build.VERSION.SDK_INT },
        )
        ChannelHub.install(hub)
        // FGS 启动时刷新一次（ChannelWiring 在每条消息决策点再刷新——权限变化
        // 无广播可订阅，决策点重算是权限时效的最稳口径）。
        hub.refreshNotificationsBlocked()

        // ---- ChannelManager 多频道装配（06-07，D-79——每频道独立运行时）----
        val configStore = ConfigStore(filesDir)
        manager = ChannelManager(factory = productionFactory(configStore))
        manager.syncFromConfig(configStore.load())
        updateFgsSummary()

        // 探活广播转发（D-27）：UI 可见性请求 → 逐频道 Visibility 事件
        // （StateFlow 当前值语义——service 装配前 UI 已 resume 的请求不丢）。
        lifecycleScope.launch {
            hub.appVisibility.collect { visible -> manager.setVisibility(visible) }
        }

        // 回复出站口路由：当前显示频道变化 → 重挂 MessageFragment.replyChannelAdapter
        // （06-06 声明的挂载契约在多频道下的落位——回复总是发往当前频道的连接）。
        lifecycleScope.launch {
            hub.currentChannelId.collect { id ->
                MessageFragment.replyChannelAdapter = id?.let { manager.replyAdapterOf(it) }
            }
        }
    }

    /**
     * 生产频道运行时工厂：每频道组装 OkHttpChannelRuntime（独立机器 + adapter +
     * 状态单元）+ [ChannelWiring]（通知/Hub/SpikeLog 接线）。channelName 经
     * manager configs 动态查（频道改名轻更新后通知标题/通道 label 即时跟新名）。
     */
    private fun productionFactory(configStore: ConfigStore): ChannelRuntimeFactory =
        OkHttpChannelRuntimeFactory(
            serverUrl = { configStore.load().server },
            onReconnectScheduled = { channelId, delayMs ->
                hub.setReconnectDeadline(channelId, delayMs)
            },
            eventsFor = { channel ->
                ChannelWiring(
                    channelId = channel.id,
                    channelName = {
                        // 动态查名：改名轻更新零重建，但通知标题/通道 label 必须读新名
                        manager.configs().firstOrNull { it.id == channel.id }?.name
                            ?: channel.name
                    },
                    // CR-03 修复：缓冲与 UI 单实例共享（MessageFragment companion 注册表）
                    // ——service 写全量（实时帧 + 首拉/补拉 history），UI 初绘/重渲染
                    // 读 snapshot()。此前 service 侧 Buffer() 的 snapshot() 全仓库无
                    // 消费者，首拉/补拉消息结构性不达 UI（消息列表空/seq 永久缺口）。
                    // 运行时重建（key 变更/server 变更全量重建）时 resetChannelBuffer
                    // 换新实例——旧缓冲丢弃、新连接首拉回填（ChannelManager updateChannel
                    // 「缓冲丢弃后回填」语义保留）。
                    buffer = MessageFragment.resetChannelBuffer(channel.id),
                    notifier = RouterNotifier(router),
                    hub = hub,
                    spikeLog = spikeLog,
                    refreshBlocked = hub::refreshNotificationsBlocked,
                    onStatusChanged = { updateFgsSummary() },
                )
            },
        )

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        if (intent?.action == ACTION_SYNC_CONFIG) {
            // 配置热更新（06-07 替换 06-04 重启过渡语义）：增量 diff——新增建连、
            // 删除断连、key 变更重建、仅改名轻更新；未变频道连接保持。
            manager.syncFromConfig(ConfigStore(filesDir).load())
            updateFgsSummary()
        }
        // START_NOT_STICKY：进程被杀后不自动重启服务（D-86——重启只经用户显式启动）。
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        // 逐频道 Destroy + 有界收敛（manager.rs destroy_all 同构）。
        manager.destroyAll()
        // WR-03：companion 静态回复句柄同步清空——不清空则引用继续持有已销毁
        // adapter（scope 已取消、socket 已断）：阻止 runtime 对象回收，且 UI 后续
        // sendReply 走死句柄表现为「未连接」而非真实的「服务已停止」语义。
        MessageFragment.replyChannelAdapter = null
        super.onDestroy()
    }

    // ---- FGS 常驻通知 ----

    private fun ensureChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID_FGS,
                "PushHub 后台连接",
                NotificationManager.IMPORTANCE_LOW,
            ),
        )
    }

    /** FGS 常驻通知内容升级：manager.statuses() 聚合文本（状态变迁时更新）。 */
    private fun updateFgsSummary() {
        if (!this::manager.isInitialized) return
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(FGS_NOTIF_ID, buildStatusNotification(fgsSummaryText(manager.statuses().map { it.second })))
    }

    private fun buildStatusNotification(summary: String): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID_FGS)
            .setSmallIcon(R.drawable.ic_stat_pushhub)
            .setContentTitle("PushHub")
            .setContentText(summary)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()

    companion object {
        /** FGS 常驻通知专用通道 ID（常量统一来源——NotificationRouter 三档通道组另立 ph_ 前缀，不复用本通道）。 */
        const val CHANNEL_ID_FGS = "ph_fgs"
        const val FGS_NOTIF_ID = 1

        /** 配置变更 action（频道管理页/向导保存后投递——syncFromConfig 热更新入口）。 */
        const val ACTION_SYNC_CONFIG = "app.pushhub.android.SYNC_CONFIG"

        /** 汇总初值（manager 装配前的占位——装配后立即被 updateFgsSummary 覆盖）。 */
        private const val initialSummaryText = "连接中"
    }
}

/**
 * FGS 汇总文本（纯函数——D-81 对齐桌面 tooltip 心智）：
 *  - 单频道：该频道状态原文（在线/重连中/连接中/离线——06-05 语义保留）；
 *  - 多频道：「在线 N / 重连中 M」聚合——仅列出非零项（全在线即「在线 N」）；
 *    connecting 归入连接中、offline 归入离线，缺项不显示（**如实反映机器状态**
 *    ——AND-04 prohibition：断连未恢复期间不得显示在线）。
 */
internal fun fgsSummaryText(statuses: List<Status>): String {
    if (statuses.isEmpty()) return "未配置频道"
    if (statuses.size == 1) {
        return when (statuses.single()) {
            Status.Online -> "在线"
            Status.Reconnecting -> "重连中"
            Status.Connecting -> "连接中"
            Status.Offline -> "离线"
        }
    }
    val online = statuses.count { it == Status.Online }
    val reconnecting = statuses.count { it == Status.Reconnecting }
    val connecting = statuses.count { it == Status.Connecting }
    val offline = statuses.count { it == Status.Offline }
    return buildString {
        append("在线 $online")
        if (reconnecting > 0) append(" / 重连中 $reconnecting")
        if (connecting > 0) append(" / 连接中 $connecting")
        if (offline > 0) append(" / 离线 $offline")
    }
}

/**
 * 通知执行口（06-05 Task 2）：ChannelWiring 依赖此接口而非 Android 绑定的
 * [NotificationRouter]——JVM 双计数器测试注入假实现计数，两流分离不变量
 * 脱真机锁定（adapter/mod.rs:17-100 双计数器先例的 Service 侧对应物）。
 */
interface Notifier {
    fun show(
        channelId: String,
        channelName: String,
        wid: String,
        title: String?,
        text: String,
        priority: String,
        createdAt: Long,
    )

    fun cancel(wid: String)
}

/** [NotificationRouter] → [Notifier] 适配（Android 真实执行面）。 */
private class RouterNotifier(private val router: NotificationRouter) : Notifier {
    override fun show(
        channelId: String,
        channelName: String,
        wid: String,
        title: String?,
        text: String,
        priority: String,
        createdAt: Long,
    ) = router.show(channelId, channelName, wid, title, text, priority, createdAt)

    override fun cancel(wid: String) = router.cancel(wid)
}

/**
 * 每频道事件接线（纯 JVM——零 android. import，双计数器测试锁定）。
 *
 * 两流分离不变量（D-61/D-63，Pitfall 9——机器动作分型天然分流的消费侧落地）：
 *  - onMessage（EmitMessage 实时帧）→ 缓冲 + SpikeLog + ChannelHub 事件 +
 *    **唯一通知路径**（前置权限检查）+ 未读计数（非当前显示频道 +1——D-81
 *    未读=新到实时帧，当前频道实时可见不计）；
 *  - onHistory（EmitHistory 首拉/补拉批次）→ 仅缓冲 + SpikeLog，**结构性零
 *    notifier 调用、零未读计数**（本回调体内无 show/bump——源码结构断言锁定；
 *    补拉批次不角标爆炸，Pitfall 9）；
 *  - onAnswered（EmitAnswered）→ 缓冲原位更新 + ChannelHub 事件 + D-69 取消。
 *
 * 权限被拒（Pitfall 4）：跳过 notify 但连接侧副作用照常（缓冲/日志/Hub 事件）
 * ——通知静默丢弃不反噬消息链路，状态经 hub.notificationsBlocked 暴露给 UI。
 *
 * @param channelName 频道名 provider（动态查——06-07 改名轻更新后通知标题/
 *   通道 label 读新名；静态值会冻结在装配时点）。
 */
class ChannelWiring(
    private val channelId: String,
    private val channelName: () -> String,
    private val buffer: Buffer,
    private val notifier: Notifier,
    private val hub: ChannelHub,
    private val spikeLog: SpikeLog,
    private val refreshBlocked: () -> Unit,
    private val onStatusChanged: (Status) -> Unit,
) : ChannelEvents {

    override fun onStatus(status: Status) {
        hub.setChannelStatus(channelId, status)
        // 重连倒计时同源清除：离开 Reconnecting 态即失效（Online/Connecting/Offline
        // 均无倒计时语义——状态与倒计时经同一 EmitStatus 源，不漂移）。
        if (status != Status.Reconnecting) hub.clearReconnectDeadline(channelId)
        spikeLog.status(channelId, status)
        onStatusChanged(status)
    }

    override fun onMessage(message: MessageFrame) {
        // 缓冲（D-62：三类消息动作统一写缓冲——实时帧亦进缓冲）。
        buffer.push(message)
        spikeLog.messageArrived(channelId, message)
        hub.emitMessage(channelId, message)
        // 未读计数（D-81）：当前显示频道实时可见不计；切走频道 +1。
        if (hub.currentChannelId.value != channelId) hub.bumpUnread(channelId)
        // 通知前置检查：决策点重算权限状态（权限变化无广播，重算即最新）；
        // 被拒则跳过 notify——状态已在 hub 暴露（Pitfall 4：静默丢弃但连接照常）。
        refreshBlocked()
        if (hub.notificationsBlocked.value) return
        notifier.show(
            channelId = channelId,
            channelName = channelName(),
            wid = message.wid,
            title = message.title,
            text = message.text,
            priority = message.priority,
            createdAt = message.createdAt,
        )
    }

    override fun onHistory(frame: HistoryFrame) {
        // 两流分离（D-61/D-63）：首拉/补拉批次只进缓冲与日志——绝不触发通知、
        // 绝不计未读（Pitfall 9：断线恢复补拉批次不角标爆炸）。
        for (m in frame.messages) buffer.push(m)
        spikeLog.historyBatch(channelId, frame.messages.size)
    }

    override fun onAnswered(frame: AnsweredFrame) {
        // 缓冲原位更新（D-17 answered 独立成帧的对应物；迟到 answered 容忍 false）。
        buffer.applyAnswered(frame)
        hub.emitAnswered(channelId, frame)
        // D-69：按同 tag 取消（幂等——通知不存在即无操作）。
        notifier.cancel(frame.wid)
    }

    override fun onError(error: ErrorPayload) {
        // 静态英文短句（adapter 侧保证不含 URL/密钥）；错误呈现归 06-06/06-07
        // （ChannelHub v1 契约面无 error 流——fatal 族机器已停机，UI 经
        // channelStatus Offline 可见）。
    }
}
