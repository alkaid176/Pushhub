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
 * MainActivity 占位（06-04 Task 2 首启判定接入；正式消息界面 06-06）。
 *
 * 架构位（RESEARCH 架构图 / D-59/D-60）：UI 是纯观察层——不持有 WS 连接，
 * 连接归 PushHubService（specialUse FGS）进程；状态经进程内共享 StateFlow 订阅
 * （StateFlow 当前值语义天然无首帧竞态——新订阅者先收当前值再收更新，05-01
 * 桌面端的 frontend-ready 门在 Android 无需对应物，此为平台语义差异的既定判断）。
 *
 * 首启判定（D-82）：ConfigStore.load 无频道 → 跳转 WizardActivity 全屏向导
 * （不启动 FGS——无配置无可连）；有配置 → 停留主界面占位 + 前台启动 FGS
 * （Pitfall 3：Android 12+ 后台启动禁止——只从前台 Activity 调）。
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
            // 首启无配置：全屏向导（D-82）；向导保存后经 startForegroundService 接入。
            startActivity(Intent(this, WizardActivity::class.java))
            finish()
            return
        }

        statusText.text = "offline"
        lifecycleScope.launch {
            PushHubService.statusFlow.collect { status ->
                statusText.text = status.name.lowercase()
            }
        }

        startForegroundService(Intent(this, PushHubService::class.java))
    }
}
