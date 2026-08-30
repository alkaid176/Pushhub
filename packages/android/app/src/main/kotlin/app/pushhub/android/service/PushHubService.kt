package app.pushhub.android.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.lifecycle.LifecycleService
import app.pushhub.android.R
import app.pushhub.android.adapter.ChannelEvents
import app.pushhub.android.protocol.AnsweredFrame
import app.pushhub.android.adapter.OkHttpChannelAdapter
import app.pushhub.android.config.ConfigStore
import app.pushhub.android.machine.ConnectionMachine
import app.pushhub.android.machine.ErrorPayload
import app.pushhub.android.machine.Status
import app.pushhub.android.protocol.HistoryFrame
import app.pushhub.android.protocol.MessageFrame
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * PushHub specialUse 前台服务（06-01 Task 3 骨架，AND-01 初证）。
 *
 * 架构位（RESEARCH 架构图 / D-59/D-60）：连接归 FGS 进程——UI（Activity）只是
 * 进程内共享状态的观察者，转屏/切走/锁屏不断连接。onCreate 首行（super 之后
 * 立即）startForeground 挂常驻通知（A3 五秒规则：startForegroundService 后未在
 * ~5s 内 startForeground 系统强制停止）。
 *
 * FGS 启动纪律（Pitfall 3）：只从前台 Activity（MainActivity）调
 * startForegroundService——Android 12+ 后台启动 FGS 被禁止；**无任何开机自启
 * 接收器与作业调度兜底**（D-86 裁决：用户停止应用后不自动重启后台连接，重启
 * 只经用户显式启动）。
 *
 * tracer 直装配：单频道（配置首个）→ OkHttpChannelAdapter；ChannelManager
 * 泛化（≤8 频道，D-79）归 06-07。ChannelEvents 订阅转发 SpikeLog（D-85 数据源）
 * 与进程内共享状态（statusFlow——UI 订阅口）。
 */
class PushHubService : LifecycleService() {

    private var adapter: OkHttpChannelAdapter? = null
    private lateinit var spikeLog: SpikeLog

    override fun onCreate() {
        super.onCreate()
        // A3 五秒规则：super.onCreate 后立即 startForeground——先于任何连接装配
        //（源序断言锚点：本行必须先于 ConfigStore/adapter 相关代码）。
        ensureChannel()
        startForeground(FGS_NOTIF_ID, buildStatusNotification())
        spikeLog = SpikeLog(filesDir.resolve("spike-log"))
        val config = ConfigStore(filesDir).load()
        val firstChannel = config.channels.firstOrNull()
        if (config.server.isNotBlank() && firstChannel != null) {
            val machine = ConnectionMachine()
            adapter = OkHttpChannelAdapter(
                machine = machine,
                serverUrl = config.server,
                channelKey = firstChannel.key,
                events = object : ChannelEvents {
                    override fun onStatus(status: Status) {
                        statusFlow.value = status
                        spikeLog.status(firstChannel.id, status)
                    }

                    override fun onMessage(message: MessageFrame) {
                        spikeLog.messageArrived(firstChannel.id, message)
                    }

                    override fun onHistory(frame: HistoryFrame) {
                        // 首拉/补拉批次：只进缓冲不通知（D-61/D-63）；缓冲接线 06-03+。
                    }

                    override fun onAnswered(frame: AnsweredFrame) {
                        // answered 原位更新通知（D-69）经 ChannelHub 扇出；接线 06-05+。
                    }

                    override fun onError(error: ErrorPayload) {
                        // 静态英文短句（adapter 侧保证不含 URL/密钥）；错误呈现 06-05+。
                    }
                },
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

    /**
     * FGS 常驻通知（裁量区建议形态）：IMPORTANCE_LOW 静默低调、ongoing 不可清除
     *（彻底隐藏不可接受——prohibition：不隐藏后台常驻连接的存在）；状态汇总文本
     *（"3 在线 / 1 重连中"桌面 tooltip 心智）06-05 升级。图标占位用启动器前景
     * vector（06-08 定正式通知图标）。
     */
    private fun buildStatusNotification(): Notification =
        NotificationCompat.Builder(this, CHANNEL_ID_FGS)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("PushHub")
            .setContentText("PushHub 运行中")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()

    companion object {
        /** FGS 常驻通知专用通道 ID（首次占用——06-05 扩展三档通道组时的命名先例）。 */
        const val CHANNEL_ID_FGS = "ph_fgs"
        const val FGS_NOTIF_ID = 1

        /**
         * 进程内共享状态（tracer 单频道；06-07 ChannelManager 泛化为每频道一状态）。
         * StateFlow 当前值语义天然无首帧竞态（新订阅者先收当前值——05-01 的
         * frontend-ready 门在 Android 无需对应物）。
         */
        val statusFlow = MutableStateFlow(Status.Offline)
    }
}
