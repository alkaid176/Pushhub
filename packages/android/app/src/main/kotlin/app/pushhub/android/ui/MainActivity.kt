package app.pushhub.android.ui

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import app.pushhub.android.R
import app.pushhub.android.config.ConfigStore
import app.pushhub.android.hub.ChannelHub
import app.pushhub.android.machine.Status
import app.pushhub.android.service.PushHubService
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * MainActivity 完整化（06-06 Task 2，AND-03/SC2/D-81）——06-01 占位 + 06-04 首启
 * 判定路由之上的消息界面宿主。
 *
 * 架构位（RESEARCH 架构图 / D-59/D-60）：UI 是纯观察层——不持有 WS 连接（连接归
 * PushHubService specialUse FGS 进程）；状态经 ChannelHub 进程内共享流订阅
 * （StateFlow 当前值语义天然无首帧竞态——新订阅者先收当前值，05-01 桌面端
 * frontend-ready 门在 Android 无需对应物）。
 *
 * 职责：
 *  - 首启判定（D-82，06-04 保留）：无配置跳全屏向导不启 FGS；
 *  - 权限被拒常驻横幅（SC2 锁定）：ChannelHub.notificationsBlocked 为真时显示
 *    「消息不会提醒 · 点击开启」，点击跳 ACTION_APP_NOTIFICATION_SETTINGS；
 *  - 顶部连接状态条（D-81）：当前频道 Status 流（在线/重连中+倒计时）；
 *  - 消息区容器：承载单个 MessageFragment（06-07 替换为 ViewPager2——容器 ID
 *    message_container 稳定）。
 *
 * 装配时序（Wave 3 并行现实）：ChannelHub 的写入方（06-05 PushHubService
 * install）与 UI 启动顺序无保证——订阅经 [awaitChannelHub] 轮询等待（未装配
 * 不崩溃、装配后 StateFlow 当前值语义补齐横幅与状态条初值）。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var banner: View
    private lateinit var statusText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val config = ConfigStore(filesDir).load()
        val hasConfig = config.server.isNotBlank() && config.channels.isNotEmpty()
        if (!hasConfig) {
            // 首启无配置：全屏向导（D-82）；向导保存后经 startForegroundService 接入。
            startActivity(Intent(this, WizardActivity::class.java))
            finish()
            return
        }

        setContentView(R.layout.activity_main)
        banner = findViewById(R.id.notification_banner)
        statusText = findViewById(R.id.status_text)
        statusText.text = statusBarText(null)

        // 权限横幅点击 → 系统通知设置（SC2 锁定行为）
        findViewById<Button>(R.id.banner_action).setOnClickListener {
            startActivity(
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, packageName),
            )
        }

        // 消息区：本 plan 单频道承载（配置首个频道）；06-07 替换为 ViewPager2
        val currentChannelId = config.channels.first().id
        if (savedInstanceState == null) {
            supportFragmentManager.beginTransaction()
                .replace(R.id.message_container, MessageFragment.newInstance(currentChannelId))
                .commit()
        }

        // FGS 前台启动（Pitfall 3：Android 12+ 后台启动禁止——只从前台 Activity 调）
        startForegroundService(Intent(this, PushHubService::class.java))

        observeHub(currentChannelId)
    }

    /** 订阅 ChannelHub：横幅（notificationsBlocked）+ 状态条（当前频道 Status）。 */
    private fun observeHub(channelId: String) {
        lifecycleScope.launch {
            val hub = awaitChannelHub() ?: return@launch
            launch {
                hub.notificationsBlocked.collect { blocked ->
                    banner.visibility = if (blocked) View.VISIBLE else View.GONE
                }
            }
            launch {
                hub.channelStatus.collect { statuses ->
                    statusText.text = statusBarText(statuses[channelId])
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // 通知权限可能在系统设置中被用户改动——回到前台即重算（hub 未装配时 no-op；
        // 计算函数由 06-05 PushHubService 装配注入）
        runCatching { ChannelHub.get().refreshNotificationsBlocked() }
    }
}

/**
 * 状态条文案（纯函数——ReplyLogicTest 断言）。
 *
 * Reconnecting 倒计时文本路径：remainingMs 为 Schedule(Reconnect) 的剩余毫秒
 * （ChannelHub 扩展点——写入方 06-05 运行时接线/06-07 ChannelManager 发布；
 * 当前无发布方时 null → 仅显示「重连中」）。null 频道态（hub 无该频道快照）
 * 显示占位符。
 */
internal fun statusBarText(status: Status?, remainingMs: Long? = null): String = when (status) {
    Status.Connecting -> "连接中"
    Status.Online -> "在线"
    Status.Reconnecting ->
        if (remainingMs != null) "重连中 · ${(remainingMs + 999) / 1000}s" else "重连中"
    Status.Offline -> "离线"
    null -> "…"
}

/**
 * 等待 ChannelHub 装配（写入方 06-05 PushHubService install 与 UI 启动顺序无
 * 保证；未装配短轮询等待，超时返回 null——UI 保持占位态不崩溃）。
 */
internal suspend fun awaitChannelHub(): ChannelHub? {
    repeat(HUB_WAIT_ROUNDS) {
        runCatching { ChannelHub.get() }.getOrNull()?.let { return it }
        delay(HUB_WAIT_INTERVAL_MS)
    }
    return null
}

private const val HUB_WAIT_ROUNDS = 100

private const val HUB_WAIT_INTERVAL_MS = 50L
