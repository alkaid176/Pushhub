package app.pushhub.android.hub

import app.pushhub.android.machine.Status
import app.pushhub.android.protocol.AnsweredFrame
import app.pushhub.android.protocol.MessageFrame
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * UI 增量渲染订阅口的事件载荷（Service 写入 → UI 读取——06-06 消息界面消费）。
 */
sealed class HubEvent {
    data class Message(val channelId: String, val frame: MessageFrame) : HubEvent()

    data class Answered(val channelId: String, val frame: AnsweredFrame) : HubEvent()
}

/**
 * 进程内共享状态契约面（06-04 Task 4——前移自 06-05，D-85 spike 等待期与 UI
 * 开发并行的结构前提）。
 *
 * 职责边界（对齐桌面 src/state.ts 心智：UI 只观察快照与事件，不持连接）：
 *  - **写入方 = PushHubService（06-05 装配时接线）**：连接事件/通知权限计算
 *    结果写入本单例；
 *  - **读取方 = MainActivity/消息 Fragment（06-06 订阅）**：StateFlow 当前值
 *    语义天然无首帧竞态（新订阅者先收当前值——05-01 frontend-ready 门的
 *    Android 判断，与 06-01 SUMMARY 记录一致），无需就绪门。
 *
 * 本文件**零 android. import**（检查函数经构造注入——纯 JVM 可测）；Android
 * 侧真实检查函数由 06-05 PushHubService 装配时注入安装。
 *
 * 06-01 的 PushHubService.statusFlow 临时共享状态已被 06-05 ChannelHub 写入 +
 * 06-07 manager.statuses() 聚合全面取代（占位订阅随 06-06 移除）。
 */
class ChannelHub(
    private val runtimePermissionGranted: () -> Boolean,
    private val notificationsEnabled: () -> Boolean,
    private val sdkInt: () -> Int,
) {

    /**
     * 通知被阻断（Pitfall 4 双路计算——拒绝时通知静默丢弃但连接照常）：
     *  - API 33+：checkSelfPermission(POST_NOTIFICATIONS) 未授权；
     *  - API 33-：NotificationManager.areNotificationsEnabled() 禁用。
     * 计算函数构造注入（Android 真实实现在 06-05 装配时传入；本类只负责
     * 版本分流语义——三路 JVM 断言锚定）。UI 消费：常驻「消息不会提醒」
     * 横幅（SC2 锁定，拒绝不阻断连接功能）。
     */
    val notificationsBlocked: StateFlow<Boolean>
        get() = _notificationsBlocked.asStateFlow()

    private val _notificationsBlocked =
        MutableStateFlow(computeNotificationsBlocked())

    /** per-channel 连接状态快照（Service 写入；UI 顶部状态条/角标消费，D-81）。 */
    val channelStatus: StateFlow<Map<String, Status>>
        get() = _channelStatus.asStateFlow()

    private val _channelStatus = MutableStateFlow<Map<String, Status>>(emptyMap())

    /** 消息/answered 事件流（UI 增量渲染订阅口——SharedFlow 无当前值语义，
     *  订阅从订阅点起收增量；重建态由 06-06 经 channelStatus + 缓冲快照自取）。 */
    val events: SharedFlow<HubEvent>
        get() = _events.asSharedFlow()

    private val _events = MutableSharedFlow<HubEvent>(extraBufferCapacity = EVENTS_BUFFER)

    /**
     * 未读计数扩展点（06-07 消费契约：未读 = 新到实时帧，补拉批次不计——
     * D-81/D-63 三端统一语义；ChannelManager 落地时接线 bump/clear）。
     * v1 契约面只预留结构，无写入方。
     */
    val unreadCounts: StateFlow<Map<String, Int>>
        get() = _unreadCounts.asStateFlow()

    private val _unreadCounts = MutableStateFlow<Map<String, Int>>(emptyMap())

    /**
     * 当前显示频道（06-07，D-81）：MainActivity tab 切换写入——未读豁免
     * （当前频道实时可见不计）与回复出站口路由（MessageFragment.replyChannelAdapter
     * 挂当前频道 adapter）的共享真值。null = 无频道显示（初始态）。
     */
    val currentChannelId: StateFlow<String?>
        get() = _currentChannelId.asStateFlow()

    private val _currentChannelId = MutableStateFlow<String?>(null)

    /**
     * 应用可见性请求（06-07，D-27 探活第三端落位）：MainActivity onResume
     * → requestVisibility(true) / onStop → requestVisibility(false)；service
     * collect 转发 ChannelManager.setVisibility 逐频道广播。StateFlow 当前值
     * 语义保证 service 装配后读到最新请求（UI 先 resume、service 后装配的
     * 时序下不丢请求——初始 false 与「未见即不可见」语义一致）。
     */
    val appVisibility: StateFlow<Boolean>
        get() = _appVisibility.asStateFlow()

    private val _appVisibility = MutableStateFlow(false)

    // ---- Service 写入口（06-05 接线） ----

    /** 重算通知阻断状态（Service 在权限变化 onResume 等时机调用）。 */
    fun refreshNotificationsBlocked() {
        _notificationsBlocked.value = computeNotificationsBlocked()
    }

    /** 更新频道连接状态（频道移除传 null 清除）。 */
    fun setChannelStatus(channelId: String, status: Status?) {
        _channelStatus.update { current ->
            if (status == null) current - channelId else current + (channelId to status)
        }
    }

    /** 实时消息事件（emitMessage——UI 计未读 + 弹通知路径的事件源）。 */
    fun emitMessage(channelId: String, frame: MessageFrame) {
        _events.tryEmit(HubEvent.Message(channelId, frame))
    }

    /** answered 事件（D-17 原样透传——UI 更新消息态/移除通知）。 */
    fun emitAnswered(channelId: String, frame: AnsweredFrame) {
        _events.tryEmit(HubEvent.Answered(channelId, frame))
    }

    /** 未读 +1（06-07 ChannelManager 消费——非当前频道的实时帧）。 */
    fun bumpUnread(channelId: String) {
        _unreadCounts.update { it + (channelId to (it[channelId] ?: 0) + 1) }
    }

    /** 清除频道未读（06-07 消费——切换到该频道时）。 */
    fun clearUnread(channelId: String) {
        _unreadCounts.update { it - channelId }
    }

    /** 更新当前显示频道（MainActivity tab 切换写入——未读豁免/reply 路由共享真值）。 */
    fun setCurrentChannel(channelId: String?) {
        _currentChannelId.value = channelId
    }

    /** 应用可见性请求（MainActivity onResume/onStop 写入——service 转发探活广播）。 */
    fun requestVisibility(visible: Boolean) {
        _appVisibility.value = visible
    }

    private fun computeNotificationsBlocked(): Boolean =
        if (sdkInt() >= 33) !runtimePermissionGranted() else !notificationsEnabled()

    companion object {
        private const val EVENTS_BUFFER = 64

        @Volatile
        private var instance: ChannelHub? = null

        /** 06-05 PushHubService 装配时安装进程内单例（真实检查函数注入点）。 */
        fun install(hub: ChannelHub) {
            instance = hub
        }

        /** UI 读取口（06-06 消费）——未安装即读为装配时序错误（fail-fast）。 */
        fun get(): ChannelHub =
            requireNotNull(instance) { "ChannelHub not installed (06-05 PushHubService install)" }
    }
}
