package app.pushhub.android.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import app.pushhub.android.R
import app.pushhub.android.ui.MainActivity

/**
 * 通知路由层（06-05 Task 1，AND-02/D-87/D-88/D-69/SC2）——桌面 notify/mod.rs 的
 * Android 同构（第三端通知面）。
 *
 * 职责（决策矩阵同构先例 notify/mod.rs:66-82）：
 *  - **通道组预建（D-87 costly 不可变纪律）**：组 phg_<channelId> + 三通道
 *    ph_<channelId>_{high,normal,low}（名称「频道名 · 高/中/低」，importance
 *    HIGH/DEFAULT/LOW，锁屏 VISIBILITY_PUBLIC（D-88）。通道 ID 一律用内部
 *    channelId（ConfigStore ch1..ch8 单调序）**永不含频道名**——频道改名经
 *    createNotificationChannel 同 ID 重建更新 name（label 可变 ID 不可变，
 *    用户系统设置锚不丢）。ensureChannelGroup 幂等：同参重调零效果，改名重调
 *    仅更新 label。
 *  - **priority 三档路由**：high→HIGH（声+横幅）、normal→DEFAULT（系统默认声）、
 *    low→LOW（静默）；未知值归 normal（研究定稿建议：DEFAULT 档保留系统默认
 *    声——关声需自定义音频流操作反而复杂化，用户嫌吵走系统设置降档，正是
 *    D-70 系统级落点）。
 *  - **tag=wid 通知与取消（D-69）**：notify(tag=wid, NOTIF_ID) / cancel(tag=wid,
 *    NOTIF_ID) 同常量配对——wid 是 m_ 前缀字符串，**禁 hash 转 Int**（Pitfall 5：
 *    碰撞 + answered 取消失配风险）；cancel 幂等（通知不存在即无操作）。
 *  - **深链 PendingIntent（SC2，06-07 onNewIntent 消费）**：Intent(MainActivity)
 *    ACTION_VIEW + NEW_TASK|SINGLE_TOP + extra ph_channel/ph_wid；FLAG_IMMUTABLE
 *    （targetSdk 31+ 强制）+ FLAG_UPDATE_CURRENT（同 wid 重发通知时 extra 刷新）。
 *
 * 安全输入面（notify/mod.rs:18-21 同构，T-06-05-03 mitigate）：show 入参仅
 * channelId/channelName/title/text/priority/wid/created_at——**Channel Key、
 * options、callback_url 一律不进通知路径**（结构上 show 无该参数）；通知文本经
 * NotificationCompat 纯文本设置（无 HTML 渲染面），摘要截断 [SUMMARY_MAX_CHARS]。
 *
 * 纯逻辑（tierOf/channelIdOf/groupIdOf/channelLabel/summarize/bodyOf/
 * deepLinkExtras）在 companion——零 android. 调用，JVM 可测
 * （NotificationLogicTest）。
 */
class NotificationRouter(private val context: Context) {

    private val nm: NotificationManager =
        context.getSystemService(NotificationManager::class.java)

    /**
     * 通道组预建（D-87）。Service 装配时对每个已配置频道调用；show 亦幂等重调
     * （自愈：配置外部变更/改名场景 label 更新，代价一次 binder 调用——告警
     * 消息频率下可忽略）。
     */
    fun ensureChannelGroup(channelName: String, channelId: String) {
        nm.createNotificationChannelGroup(
            NotificationChannelGroup(groupIdOf(channelId), channelName),
        )
        for (spec in TIER_SPECS) {
            nm.createNotificationChannel(
                NotificationChannel(
                    notificationChannelIdOf(channelId, spec.tier),
                    channelLabel(channelName, spec.tier),
                    spec.importance,
                ).apply {
                    group = groupIdOf(channelId)
                    // D-88：锁屏公开显示内容（用户裁决；用户可随时经系统通道设置改私）。
                    lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                },
            )
        }
    }

    /**
     * 弹通知（仅实时帧路径调用——两流分离 D-61/D-63 由 PushHubService 接线保证，
     * 本类不感知事件来源）。六要素见类注释安全输入面。
     */
    fun show(
        channelId: String,
        channelName: String,
        wid: String,
        title: String?,
        text: String,
        priority: String,
        createdAt: Long,
    ) {
        ensureChannelGroup(channelName, channelId)
        val intent = Intent(context, MainActivity::class.java).apply {
            // ACTION_VIEW + singleTask（manifest）→ 已运行时走 onNewIntent（06-07 消费）
            action = Intent.ACTION_VIEW
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            for ((key, value) in deepLinkExtras(channelId, wid)) putExtra(key, value)
        }
        val contentIntent = PendingIntent.getActivity(
            context,
            // requestCode 按 wid 区分（不同消息不同 PendingIntent——extra 不串台）
            wid.hashCode(),
            intent,
            // IMMUTABLE：targetSdk 31+ 强制（T-06-05-02 mitigate）；UPDATE_CURRENT：
            // 同 wid 重发时刷新 extra
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(
            context,
            notificationChannelIdOf(channelId, tierOf(priority)),
        )
            .setSmallIcon(R.drawable.ic_stat_pushhub)
            .setContentTitle(channelName)
            .setContentText(bodyOf(title, text))
            .setAutoCancel(true)
            // created_at 秒（协议帧）→ 毫秒（Android when 口径）
            .setWhen(createdAt * 1000)
            .setContentIntent(contentIntent)
            .build()
        // tag=wid + 固定 NOTIF_ID（Pitfall 5：wid 字符串 tag，禁 hash 转 Int）
        nm.notify(wid, NOTIF_ID, notification)
    }

    /** D-69：answered 后按同 tag 取消（幂等——不存在即无操作）。 */
    fun cancel(wid: String) {
        nm.cancel(wid, NOTIF_ID)
    }

    /** 三档通道规格（importance 是 android 常量——实例侧；tier/label 纯逻辑在 companion）。 */
    private data class TierSpec(val tier: String, val importance: Int)

    private val TIER_SPECS = listOf(
        TierSpec(TIER_HIGH, NotificationManager.IMPORTANCE_HIGH),
        TierSpec(TIER_NORMAL, NotificationManager.IMPORTANCE_DEFAULT),
        TierSpec(TIER_LOW, NotificationManager.IMPORTANCE_LOW),
    )

    companion object {
        /** 消息通知固定 id（与 tag=wid 配对区分——同一 tag 空间内唯一即可）。 */
        const val NOTIF_ID = 100

        /** FGS 常驻通知通道 ph_fgs 的常量统一来源在 PushHubService.CHANNEL_ID_FGS（06-01 首占，本文件不重复声明）。 */

        /** 深链 extra 键（SC2 契约——06-07 onNewIntent 消费；06-05 定义）。 */
        const val EXTRA_CHANNEL = "ph_channel"
        const val EXTRA_WID = "ph_wid"

        /** 通知正文摘要上限（桌面 notify SUMMARY_MAX_CHARS=150 同构——chars 计数近似）。 */
        const val SUMMARY_MAX_CHARS = 150

        /** 三档 tier 字面量（通道 ID 后缀 + priority 路由目标）。 */
        const val TIER_HIGH = "high"
        const val TIER_NORMAL = "normal"
        const val TIER_LOW = "low"

        /**
         * priority → tier 路由（纯逻辑）：high/normal/low 直映射，未知值归 normal
         * （协议层 isMessageShape 已守卫三值——此处兜底防御纵深）。
         */
        fun tierOf(priority: String): String = when (priority) {
            TIER_HIGH -> TIER_HIGH
            TIER_LOW -> TIER_LOW
            else -> TIER_NORMAL
        }

        /** 通道组 ID：phg_<channelId>（不含频道名——D-87 不可变纪律）。 */
        fun groupIdOf(channelId: String): String = "phg_$channelId"

        /** 通道 ID：ph_<channelId>_<tier>（不含频道名——D-87 不可变纪律）。 */
        fun notificationChannelIdOf(channelId: String, tier: String): String =
            "ph_${channelId}_$tier"

        /** 通道显示名：「频道名 · 高/中/低」（系统设置用户可辨识——D-87）。 */
        fun channelLabel(channelName: String, tier: String): String {
            val suffix = when (tier) {
                TIER_HIGH -> "高"
                TIER_LOW -> "低"
                else -> "中"
            }
            return "$channelName · $suffix"
        }

        /**
         * 通知正文（纯逻辑）：title 优先（空白视为缺失——桌面 make_title 同判），
         * 缺失取 text；统一截断 [SUMMARY_MAX_CHARS]（chars 计数，CJK 每字 1——
         * A7 裁决同构，不逐字节对齐 UTF-16）。
         */
        fun bodyOf(title: String?, text: String): String =
            summarize(title?.takeIf { it.isNotBlank() } ?: text)

        /** 按 chars 截断（不追加省略号——长度语义由调用侧常量控制，桌面同款）。 */
        fun summarize(text: String, maxChars: Int = SUMMARY_MAX_CHARS): String =
            if (text.length <= maxChars) text else text.take(maxChars)

        /**
         * 深链 extra 构造（纯逻辑）：键 ph_channel/ph_wid——06-07 onNewIntent 消费
         * 契约（严格校验：channel 存在于配置、wid m_ 前缀，畸形丢弃——T-06-05-02
         * mitigate 的消费侧落地）。
         */
        fun deepLinkExtras(channelId: String, wid: String): Map<String, String> =
            mapOf(EXTRA_CHANNEL to channelId, EXTRA_WID to wid)
    }
}
