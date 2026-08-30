package app.pushhub.android.ui

import android.content.Context
import android.content.Intent
import app.pushhub.android.service.PushHubService

/**
 * 配置变更后通知 service 热更新（06-07 起替换 06-04 的重启过渡语义——
 * ChannelManager.syncFromConfig 增量 diff：新增建连/删除断连/key 变更重建/
 * 仅改名轻更新，**未变频道连接保持**，不再 stop+start 全量重启）。
 *
 * 函数名保留 restartPushHubService（调用方 ChannelManageActivity/WizardActivity
 * 不变——06-07 文件边界内的最小侵入；语义见本注释）。
 *
 * 调用方必须在前台（Pitfall 3：Android 12+ 后台禁启 FGS——本函数只从
 * 向导/频道管理 Activity 调用）。服务已运行时这只是向 onStartCommand 投递
 * [PushHubService.ACTION_SYNC_CONFIG]；未运行时（向导首启保存路径）
 * onCreate 装配后 onStartCommand 再 sync 一次（幂等零动作）。
 */
internal fun restartPushHubService(context: Context) {
    val intent = Intent(context, PushHubService::class.java)
        .setAction(PushHubService.ACTION_SYNC_CONFIG)
    context.startForegroundService(intent)
}
