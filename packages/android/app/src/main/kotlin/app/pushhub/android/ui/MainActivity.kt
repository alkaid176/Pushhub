package app.pushhub.android.ui

import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import app.pushhub.android.config.ConfigStore
import app.pushhub.android.service.PushHubService
import kotlinx.coroutines.launch

/**
 * MainActivity 占位（06-01 Task 3 微调）。
 *
 * 架构位（RESEARCH 架构图 / D-59/D-60）：UI 是纯观察层——不持有 WS 连接，
 * 连接归 PushHubService（specialUse FGS）进程；状态经进程内共享 StateFlow 订阅
 * （StateFlow 当前值语义天然无首帧竞态——新订阅者先收当前值再收更新，05-01
 * 桌面端的 frontend-ready 门在 Android 无需对应物，此为平台语义差异的既定判断）。
 *
 * FGS 启动（Pitfall 3）：从前台 Activity 调 startForegroundService（Android 12+
 * 后台启动禁止）；Service 幂等（已运行时仅重投 onStartCommand）。
 * 无配置时显示向导占位文案（向导本体 06-04，D-82）。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var statusText: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        statusText = TextView(this).apply {
            textSize = 24f
            gravity = Gravity.CENTER
        }
        setContentView(statusText)

        val config = ConfigStore(filesDir).load()
        val hasConfig = config.server.isNotBlank() && config.channels.isNotEmpty()
        if (!hasConfig) {
            statusText.text = "PushHub\n\n未配置频道\n（配置向导 06-04 接入）"
        } else {
            statusText.text = "offline"
        }

        lifecycleScope.launch {
            PushHubService.statusFlow.collect { status ->
                if (hasConfig) statusText.text = status.name.lowercase()
            }
        }

        startForegroundService(Intent(this, PushHubService::class.java))
    }
}
