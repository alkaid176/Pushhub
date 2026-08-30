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
import app.pushhub.android.R
import app.pushhub.android.adapter.ChannelEvents
import app.pushhub.android.adapter.OkHttpChannelAdapter
import app.pushhub.android.config.ConfigStore
import app.pushhub.android.hub.ChannelHub
import app.pushhub.android.machine.Buffer
import app.pushhub.android.machine.ConnectionMachine
import app.pushhub.android.machine.ErrorPayload
import app.pushhub.android.machine.Status
import app.pushhub.android.protocol.AnsweredFrame
import app.pushhub.android.protocol.HistoryFrame
import app.pushhub.android.protocol.MessageFrame
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * PushHub specialUse 前台服务（06-01 骨架 → 06-05 通知接线，AND-01/AND-02）。
 *
 * 架构位（RESEARCH 架构图 / D-59/D-60）：连接归 FGS 进程——UI（Activity）只是
 * 进程内共享状态的观察者，转屏/切走/锁屏不断连接。onCreate 首行（super 之后
 * 立即）startForeground 挂常驻通知（A3 五秒规则）。
 *
 * FGS 启动纪律（Pitfall 3）：只从前台 Activity（MainActivity）调
 * startForegroundService——Android 12+ 后台启动 FGS 被禁止；**无任何开机自启
 * 接收器与作业调度兜底**（D-86 裁决）。
 *
 * 06-05 接线（本文件与 [ChannelWiring] 分工——Android 装配面在本类，两流分离
 * 纯逻辑在 ChannelWiring，JVM 双计数器测试锁定）：
 *  - **ChannelHub 写入方**（06-04 契约面的装配点）：Android 双路权限检查函数
 *    注入 + install 单例；onStatus/onMessage/onAnswered 发布进对应
 *    StateFlow/SharedFlow（Service 写、06-06 UI 读）；
 *  - **通知接线**：onMessage → 权限前置检查 + [NotificationRouter.show]；
 *    onAnswered → cancel(tag=wid)（D-69）；onHistory 零通知（D-61/D-63）；
 *  - **FGS 常驻通知升级**：内容为连接状态汇总文本（单频道「在线/重连中」；
 *    多频道聚合 06-07 接 manager.statuses() 后升级）。
 *
 * tracer 直装配：单频道（配置首个）→ OkHttpChannelAdapter；ChannelManager
 * 泛化（≤8 频道，D-79）归 06-07。
 */
class PushHubService : LifecycleService() {

    private var adapter: OkHttpChannelAdapter? = null
    private lateinit var spikeLog: SpikeLog
    private lateinit var router: NotificationRouter
    private lateinit var hub: ChannelHub

    override fun onCreate() {
        super.onCreate()
        // A3 五秒规则：super.onCreate 后立即 startForeground——先于任何连接装配。
        ensureChannel()
        startForeground(FGS_NOTIF_ID, buildStatusNotification(statusSummaryText(Status.Connecting)))
        spikeLog = SpikeLog(filesDir.resolve("spike-log"))
        router = NotificationRouter(this)

        // ---- ChannelHub 装配（06-04 Task 4 契约面的写入方接线，Pitfall 4 双路）----
        // 计算语义（版本分流）在 ChannelHub 内；Android 真实检查函数在此注入：
        //  - API 33+：checkSelfPermission(POST_NOTIFICATIONS)；
        //  - API 33-：areNotificationsEnabled() 系统总开关。
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

        val config = ConfigStore(filesDir).load()
        val firstChannel = config.channels.firstOrNull()
        if (config.server.isNotBlank() && firstChannel != null) {
            // 通道组预建（D-87：同 ID 重建即改名更新 label——幂等）。
            router.ensureChannelGroup(firstChannel.name, firstChannel.id)
            val machine = ConnectionMachine()
            adapter = OkHttpChannelAdapter(
                machine = machine,
                serverUrl = config.server,
                channelKey = firstChannel.key,
                events = ChannelWiring(
                    channelId = firstChannel.id,
                    channelName = firstChannel.name,
                    buffer = Buffer(),
                    notifier = RouterNotifier(router),
                    hub = hub,
                    spikeLog = spikeLog,
                    refreshBlocked = hub::refreshNotificationsBlocked,
                    onStatusChanged = { status ->
                        // 06-01 占位订阅口（MainActivity 仍消费；06-06 替换为
                        // ChannelHub.channelStatus——跨 plan 文件所有权纪律）。
                        statusFlow.value = status
                        updateFgsSummary(status)
                    },
                ),
            ).also { it.connect() }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        // START_NOT_STICKY：进程被杀后不自动重启服务（D-86——重启只经用户显式启动）。
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        // 经 Destroy 事件收连接（终局销毁——定时器/串行队列一并收敛）。
        adapter?.destroy()
        adapter = null
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

    /** FGS 常驻通知内容升级：连接状态汇总文本（同 ID notify 更新，前台位不降级）。 */
    private fun updateFgsSummary(status: Status) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(FGS_NOTIF_ID, buildStatusNotification(statusSummaryText(status)))
    }

    private fun statusSummaryText(status: Status): String = when (status) {
        Status.Online -> "在线"
        Status.Reconnecting -> "重连中"
        Status.Connecting -> "连接中"
        Status.Offline -> "离线"
    }

    /**
     * FGS 常驻通知（裁量区建议形态）：IMPORTANCE_LOW 静默低调、ongoing 不可清除
     * （prohibition：不隐藏后台常驻连接的存在）；内容为状态汇总文本（对齐桌面
     * tooltip 心智，D-81 同源）。
     */
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

        /**
         * 进程内共享状态（06-01 tracer 占位；06-06 起由 ChannelHub.channelStatus
         * 取代——过渡期双写保持占位 UI 可用）。
         */
        val statusFlow = MutableStateFlow(Status.Offline)
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
 *    **唯一通知路径**（前置权限检查）；
 *  - onHistory（EmitHistory 首拉/补拉批次）→ 仅缓冲 + SpikeLog，**结构性零
 *    notifier 调用**（本回调体内无 show——源码结构断言锁定）；
 *  - onAnswered（EmitAnswered）→ 缓冲原位更新 + ChannelHub 事件 + D-69 取消。
 *
 * 权限被拒（Pitfall 4）：跳过 notify 但连接侧副作用照常（缓冲/日志/Hub 事件）
 * ——通知静默丢弃不反噬消息链路，状态经 hub.notificationsBlocked 暴露给 UI。
 */
class ChannelWiring(
    private val channelId: String,
    private val channelName: String,
    private val buffer: Buffer,
    private val notifier: Notifier,
    private val hub: ChannelHub,
    private val spikeLog: SpikeLog,
    private val refreshBlocked: () -> Unit,
    private val onStatusChanged: (Status) -> Unit,
) : ChannelEvents {

    override fun onStatus(status: Status) {
        hub.setChannelStatus(channelId, status)
        spikeLog.status(channelId, status)
        onStatusChanged(status)
    }

    override fun onMessage(message: MessageFrame) {
        // 缓冲（D-62：三类消息动作统一写缓冲——实时帧亦进缓冲）。
        buffer.push(message)
        spikeLog.messageArrived(channelId, message)
        hub.emitMessage(channelId, message)
        // 通知前置检查：决策点重算权限状态（权限变化无广播，重算即最新）；
        // 被拒则跳过 notify——状态已在 hub 暴露（Pitfall 4：静默丢弃但连接照常）。
        refreshBlocked()
        if (hub.notificationsBlocked.value) return
        notifier.show(
            channelId = channelId,
            channelName = channelName,
            wid = message.wid,
            title = message.title,
            text = message.text,
            priority = message.priority,
            createdAt = message.createdAt,
        )
    }

    override fun onHistory(frame: HistoryFrame) {
        // 两流分离（D-61/D-63）：首拉/补拉批次只进缓冲与日志——绝不触发通知。
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
