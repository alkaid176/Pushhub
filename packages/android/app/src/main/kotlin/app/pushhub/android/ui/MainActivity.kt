package app.pushhub.android.ui

import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * MainActivity 占位（06-01 Task 2）。
 *
 * 架构位（RESEARCH 架构图 / D-59）：UI 是纯观察层——不持有 WS 连接，连接归
 * PushHubService（specialUse FGS）进程；本 plan 阶段仅验证 launcher/编译通路。
 * Task 3 将接入进程内共享状态 StateFlow 显示连接状态文本（connecting/online/
 * reconnecting/offline）；向导本体在 06-04。
 *
 * FGS 启动纪律（Pitfall 3）：startForegroundService 必须从前台 Activity 调起
 * ——PushHubService 类在 Task 3 交付，届时 onCreate 末尾接通：
 *   startForegroundService(Intent(this, PushHubService::class.java))
 */
class MainActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        val label = TextView(this).apply {
            text = "PushHub"
            textSize = 24f
            gravity = android.view.Gravity.CENTER
        }
        setContentView(label)
        // Task 3 接通（时序说明见类注释）：
        // startForegroundService(android.content.Intent(this, app.pushhub.android.service.PushHubService::class.java))
    }
}
