package app.pushhub.android.ui

import android.content.Context
import android.content.Intent
import app.pushhub.android.service.PushHubService

/**
 * 配置变更后重启 FGS 使新配置生效（06-04 过渡语义——06-07 ChannelManager 落地
 * 热更新后替换为增量同步，见计划 Task 3 注释要求）。
 *
 * tracer 版 PushHubService 只在 onCreate 装配连接，运行中重投 onStartCommand
 * 不重读配置——故变更后必须 stop + start（stopService 对未运行服务是 no-op，
 * 首启保存路径同样安全）。调用方必须在前台（Pitfall 3：Android 12+ 后台
 * 禁启 FGS——本函数只从向导/频道管理 Activity 调用）。
 */
internal fun restartPushHubService(context: Context) {
    val intent = Intent(context, PushHubService::class.java)
    context.stopService(intent)
    context.startForegroundService(intent)
}
