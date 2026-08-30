package app.pushhub.android.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.core.os.bundleOf
import androidx.core.widget.addTextChangedListener
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import app.pushhub.android.R
import app.pushhub.android.adapter.OkHttpChannelAdapter
import app.pushhub.android.config.ConfigStore
import app.pushhub.android.hub.ChannelHub
import app.pushhub.android.hub.HubEvent
import app.pushhub.android.machine.Buffer
import app.pushhub.android.protocol.BY_MAX
import app.pushhub.android.protocol.AnsweredFrame
import app.pushhub.android.protocol.MessageFrame
import app.pushhub.android.protocol.PROTOCOL_VERSION
import app.pushhub.android.protocol.ReplyFrame
import app.pushhub.android.protocol.lenientJson
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString

/**
 * 单频道消息界面（06-06 Task 2，AND-03/D-60/D-81）——桌面 message-list.ts +
 * state.ts 观察者模式的 Android 对应物：**UI 只观察不持连接**（连接归
 * PushHubService 进程；状态与事件经 ChannelHub 共享流订阅——06-04 契约面）。
 *
 * channelId 构造参数化——**每频道一实例**设计，06-07 ViewPager2 多频道化直接
 * 复用本类（tab 切换销毁重建时经 companion 级每频道缓冲 snapshot() 全量初绘）。
 *
 * 渲染纪律：
 *  - 视图创建时取该频道缓冲 snapshot() 全量初绘（重建态由快照恢复）；
 *  - 订阅 ChannelHub.events 增量——实时帧插入（notifyItemInserted 语义经
 *    ListAdapter wid diff 自动计算）、applyAnswered 命中时原位刷新对应项
 *    （D-17 不新增条目）；
 *  - 滚动策略：新消息到达且已处于底部时自动跟随；用户上滑阅读历史时不打断。
 *
 * 本 plan（Wave 3）：ChannelHub 运行时写入方 PushHubService 由 06-05 同波落地
 * ——本 Fragment 经 [awaitChannelHub] 容忍装配时序（未安装轮询等待，不依赖
 * service 在场即可启动渲染）。
 */
class MessageFragment : Fragment() {

    private val channelId: String
        get() = requireArguments().getString(ARG_CHANNEL_ID) ?: error("MessageFragment requires channelId")

    private lateinit var listView: RecyclerView
    private lateinit var emptyView: TextView
    private lateinit var adapter: MessageListAdapter

    // ---- 回复区视图（Task 3，RPL-05——绑定 selectedWid） ----

    private lateinit var replyArea: View
    private lateinit var replyTarget: TextView
    private lateinit var replyOptions: ViewGroup
    private lateinit var replyInput: EditText
    private lateinit var replySend: Button
    private lateinit var replyNote: TextView

    /** 本频道缓冲（companion 级存储——Fragment 实例外存活）。 */
    private val buffer: Buffer get() = bufferFor(channelId)

    /** 选中消息 wid（回复目标绑定——点击条目切换；Task 3 回复区消费）。 */
    private var selectedWid: String? = null

    /** 已发出回复待 answered 权威帧的 wid 集合（本地乐观置灰——Task 3 写入）。 */
    private val pendingReplies = mutableSetOf<String>()

    /** scrollToWid 定位高亮中的 wid（渐隐动画态）。 */
    private var flashingWid: String? = null

    override fun onCreateView(
        inflater: LayoutInflater,
        container: ViewGroup?,
        savedInstanceState: Bundle?,
    ): View = inflater.inflate(R.layout.fragment_message, container, false)

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        super.onViewCreated(view, savedInstanceState)
        listView = view.findViewById(R.id.message_list)
        emptyView = view.findViewById(R.id.empty_state)
        listView.layoutManager = LinearLayoutManager(requireContext())
        adapter = MessageListAdapter(
            markwonContext = requireContext(),
            onQuickReply = { wid, option -> sendQuickReply(wid, option) },
            onMessageClick = ::onMessageClick,
        )
        listView.adapter = adapter

        bindReplyViews(view)

        // 视图创建时缓冲 snapshot() 全量初绘（D-60：快照重建语义）
        renderAll()
        observeHub()
    }

    /** 回复区接线（Task 3）：输入监听（空输入禁用发送）+ 发送按钮。 */
    private fun bindReplyViews(view: View) {
        replyArea = view.findViewById(R.id.reply_area)
        replyTarget = view.findViewById(R.id.reply_target)
        replyOptions = view.findViewById(R.id.reply_options)
        replyInput = view.findViewById(R.id.reply_input)
        replySend = view.findViewById(R.id.btn_send)
        replyNote = view.findViewById(R.id.reply_note)

        replyInput.addTextChangedListener { text ->
            replySend.isEnabled = !text.isNullOrBlank()
        }
        replySend.setOnClickListener {
            val wid = selectedWid ?: return@setOnClickListener
            val text = replyInput.text.trim()
            sendCustomReply(wid, text.toString())
        }
    }

    /** 订阅 ChannelHub 事件流（实时帧/answered 增量渲染）。 */
    private fun observeHub() {
        viewLifecycleOwner.lifecycleScope.launch {
            // 装配时序容忍：写入方（06-05 PushHubService install）可能晚于 UI 启动
            val hub = awaitChannelHub() ?: return@launch
            launch {
                hub.events.collect { event ->
                    when (event) {
                        is HubEvent.Message ->
                            if (event.channelId == channelId) onNewMessage(event.frame)

                        is HubEvent.Answered ->
                            if (event.channelId == channelId) onAnswered(event.frame)
                    }
                }
            }
        }
    }

    private fun onNewMessage(frame: MessageFrame) {
        buffer.push(frame)
        renderAll(autoFollow = true)
    }

    private fun onAnswered(frame: AnsweredFrame) {
        // 迟到 answered 容忍（消息可能不在缓冲窗口——applyAnswered false 即无动作）
        if (buffer.applyAnswered(frame)) {
            pendingReplies.remove(frame.wid)
            renderAll()
        }
    }

    /** 条目点击 → 切换选中（回复目标绑定；再次点击取消）。 */
    private fun onMessageClick(wid: String) {
        selectedWid = if (selectedWid == wid) null else wid
        renderAll()
    }

    /** 全量重建提交（ListAdapter 按 wid diff 计算最小更新集）。 */
    private fun renderAll(autoFollow: Boolean = false) {
        // 滚动策略：仅在「已处于底部」时新消息自动跟随（上滑阅读历史不打断）
        val follow = autoFollow && !listView.canScrollVertically(1)
        adapter.submitList(buildItems()) {
            emptyView.visibility = if (adapter.itemCount == 0) View.VISIBLE else View.GONE
            if (follow && adapter.itemCount > 0) {
                listView.scrollToPosition(adapter.itemCount - 1)
            }
            updateReplyArea()
        }
    }

    /**
     * 回复区整体重渲染（桌面 reply-box.ts update() 同构）——依据 selectedWid
     * 对应消息当前态（未答可交互 / pending 置灰 / answered 冻结——RPL-05）。
     */
    private fun updateReplyArea() {
        val wid = selectedWid
        val message = wid?.let { w -> buffer.snapshot().messages.firstOrNull { it.wid == w } }
        if (wid == null || message == null) {
            replyArea.visibility = View.GONE
            return
        }
        replyArea.visibility = View.VISIBLE
        val target = message.title ?: message.text.lines().firstOrNull { it.isNotBlank() } ?: message.wid
        replyTarget.text = "回复：${target.take(REPLY_TARGET_MAX)}"

        val state = quickReplyState(answered = message.answered, pendingReply = wid in pendingReplies)
        val frozen = state != QuickReplyState.ACTIVE
        bindReplyOptions(message, enabled = !frozen)
        replyInput.isEnabled = !frozen
        replySend.isEnabled = !frozen && replyInput.text?.isNotBlank() == true
        replyNote.visibility = if (message.answered) View.VISIBLE else View.GONE
    }

    /** 回复区快捷选项横排（选中消息 options ≤4；快捷点击即清空输入框——恰一互斥）。 */
    private fun bindReplyOptions(message: MessageFrame, enabled: Boolean) {
        val options = (message.options ?: emptyList())
            .filter { it.isNotBlank() }
            .take(MessageListAdapter.QUICK_OPTION_LIMIT)
        replyOptions.removeAllViews()
        if (options.isEmpty()) {
            replyOptions.visibility = View.GONE
            return
        }
        replyOptions.visibility = View.VISIBLE
        val ctx = replyOptions.context
        for (option in options) {
            val btn = Button(ctx, null, android.R.attr.borderlessButtonStyle).apply {
                text = option
                isAllCaps = false
                isEnabled = enabled
                setOnClickListener {
                    if (selectedWid != null) sendQuickReply(selectedWid!!, option)
                }
            }
            val lp = android.widget.LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                1f,
            ).apply { marginEnd = (4 * ctx.resources.displayMetrics.density).toInt() }
            replyOptions.addView(btn, lp)
        }
    }

    private fun buildItems(): List<MessageItem> =
        buffer.snapshot().messages.map { m ->
            MessageItem(
                frame = m,
                selected = m.wid == selectedWid,
                pendingReply = m.wid in pendingReplies,
                flash = m.wid == flashingWid,
            )
        }

    // ---- 回复出站链（Task 3，RPL-05/WEB-03 Pattern 7——outbox 直发，不进状态机） ----

    /**
     * 快捷选项回复（条目按钮与回复区按钮共用入口）。
     * 互斥纪律：快捷点击即清空输入框内容（载荷恰一在 UI 层保证）。
     */
    private fun sendQuickReply(wid: String, option: String) {
        replyInput.setText("")
        dispatchReply(wid, selectedOption = option, text = null)
    }

    /** 自定义文本回复（输入框发送按钮）。 */
    private fun sendCustomReply(wid: String, text: String) {
        dispatchReply(wid, selectedOption = null, text = text)
    }

    /**
     * 出站编排：恰一校验（本地防御——正常 UI 路径不可达 Invalid）→ 展示名裁剪
     * （BY_MAX/REPLY_TEXT_MAX，服务端权威之外省一次往返）→ sendReply 直发。
     * not_connected：Toast「未连接，稍后重试」fail-fast——不排队不重试
     * （pushhub.ts:164-176 语义对齐：用户重试语义属 UI 业务层）。
     */
    private fun dispatchReply(wid: String, selectedOption: String?, text: String?) {
        when (val payload = buildReplyPayload(selectedOption, text)) {
            is ReplyPayload.Invalid -> {
                Toast.makeText(requireContext(), "回复内容无效——恰填一项", Toast.LENGTH_SHORT).show()
                return
            }
            is ReplyPayload.Option -> sendReplyFrame(wid, payload.option, null)
            is ReplyPayload.Text -> {
                if (payload.text.length > REPLY_TEXT_MAX) {
                    Toast.makeText(requireContext(), "回复超出长度上限", Toast.LENGTH_SHORT).show()
                    return
                }
                sendReplyFrame(wid, null, payload.text)
            }
        }
    }

    /** 发帧 + 本地乐观态（成功出站即置灰按钮区，等待 answered 权威帧确认）。 */
    private fun sendReplyFrame(wid: String, selectedOption: String?, text: String?) {
        // D-72：by 由 UI 层从 ConfigStore.displayName 自动携带；缺省（null/空白）
        // 不序列化即匿名回复；BY_MAX 裁剪（UTF-16 码元口径与 shared 一致）
        val displayName = ConfigStore(requireContext().filesDir).load().displayName
            ?.trim()?.take(BY_MAX)
        val channelAdapter = replyChannelAdapter
        val sent = channelAdapter?.sendReply(
            channelId = channelId,
            wid = wid,
            selectedOption = selectedOption,
            text = text,
            by = displayName,
        ) ?: false

        if (replySendOutcome(sent) == ReplySendOutcome.NotConnected) {
            Toast.makeText(requireContext(), "未连接，稍后重试", Toast.LENGTH_SHORT).show()
            return
        }
        // 本地乐观置灰——不做本地假 answered（服务端恰一锁定语义是权威源；
        // answered 帧经 ChannelHub.events 扇出后 applyAnswered 权威覆写）
        pendingReplies.add(wid)
        renderAll()
    }

    // ---- 06-07 深链消费契约（SC2 定位链第三级——桌面 05-06 D-67 locate 同构） ----

    /**
     * 滚动定位到 wid 并高亮渐隐（公开 API——06-07 通知深链消费：onNewIntent →
     * 切频道 → 本方法定位）。
     *
     * @return true 定位成功（wid 在当前缓冲中）；false 未命中（消息不在窗口——
     * 调用方决定是否提示）。
     */
    fun scrollToWid(wid: String): Boolean {
        val idx = adapter.currentList.indexOfFirst { it.frame.wid == wid }
        if (idx < 0) return false
        selectedWid = wid // 定位即选中（回复区随之绑定——桌面 locate+select 联动）
        flashingWid = wid
        adapter.submitList(buildItems()) {
            emptyView.visibility = View.GONE
            listView.scrollToPosition(idx)
            updateReplyArea()
        }
        viewLifecycleOwner.lifecycleScope.launch {
            delay(FLASH_DURATION_MS)
            if (flashingWid == wid) {
                flashingWid = null
                renderAll()
            }
        }
        return true
    }

    companion object {
        private const val ARG_CHANNEL_ID = "channelId"

        /** 定位高亮渐隐时长（桌面 locate-flash 动画时长同量级）。 */
        internal const val FLASH_DURATION_MS = 1_500L

        /**
         * 每频道缓冲存储（companion 级——Fragment 实例外存活）：06-07 ViewPager2
         * tab 切换销毁重建 Fragment 时，同频道缓冲连续积累，初绘经 snapshot() 恢复。
         */
        private val channelBuffers = mutableMapOf<String, Buffer>()

        /** 回复目标行截断长度（桌面 reply-target 60 同量级）。 */
        internal const val REPLY_TARGET_MAX = 60

        /**
         * 自定义回复长度上限（shared LIMITS.TEXT_MAX=32768 对齐——UI 层先验省
         * 一次服务端往返；协议常量未入 protocol/Frames.kt，UI 校验属地内声明）。
         */
        internal const val REPLY_TEXT_MAX = 32_768

        /**
         * outbox 通道接线点（06-06 声明契约）：06-05 PushHubService / 06-07
         * ChannelManager 装配 OkHttpChannelAdapter 后挂载；Wave 3 现实：service
         * 写入方同波落地，挂载前回复按 not_connected fail-fast（Toast）——不排队
         * 不重试。@Volatile：UI 线程读、service 线程写。
         */
        @Volatile
        var replyChannelAdapter: OkHttpChannelAdapter? = null

        internal fun bufferFor(channelId: String): Buffer =
            channelBuffers.getOrPut(channelId) { Buffer() }

        /** 测试隔离：清空缓冲存储与 outbox 挂载（测试间互不污染）。 */
        internal fun resetForTest() {
            channelBuffers.clear()
            replyChannelAdapter = null
        }

        fun newInstance(channelId: String): MessageFragment =
            MessageFragment().apply { arguments = bundleOf(ARG_CHANNEL_ID to channelId) }
    }
}

// ---- 回复纯逻辑（JVM 直测——ReplyLogicTest；零 Android 依赖） ----

/** 载荷恰一校验结果（pushhub.ts:153-163 三步防御第一步的 UI 层对应物）。 */
sealed interface ReplyPayload {
    data class Option(val option: String) : ReplyPayload
    data class Text(val text: String) : ReplyPayload
    data object Invalid : ReplyPayload
}

/**
 * 载荷恰一校验（纯函数）：selectedOption 与 text 同真或同假 → Invalid（服务端
 * invalid_frame 结构层校验的 UI 层前置——同时存在或全空在 UI 层禁止）。空白视同
 * 未提供（与服务端「null 视为未提供」truthiness 判定同源）。
 */
fun buildReplyPayload(selectedOption: String?, text: String?): ReplyPayload {
    val hasOption = !selectedOption.isNullOrBlank()
    val hasText = !text.isNullOrBlank()
    if (hasOption == hasText) return ReplyPayload.Invalid
    return if (hasOption) {
        ReplyPayload.Option(selectedOption!!.trim())
    } else {
        ReplyPayload.Text(text!!.trim())
    }
}

/** 出站结果映射（fail-fast 语义载体——无排队/重试字段即语义本身）。 */
enum class ReplySendOutcome { Sent, NotConnected }

fun replySendOutcome(sendOk: Boolean): ReplySendOutcome =
    if (sendOk) ReplySendOutcome.Sent else ReplySendOutcome.NotConnected

/** 回复区交互态（answered 冻结状态转移——RPL-05 防重复处置）。 */
enum class QuickReplyState { ACTIVE, PENDING, FROZEN }

/**
 * 冻结状态转移函数（纯）：answered 恒 FROZEN（他人回复同样冻结本端按钮）；
 * 未答 + pending（本地乐观置灰）→ PENDING；否则 ACTIVE。
 */
fun quickReplyState(answered: Boolean, pendingReply: Boolean): QuickReplyState = when {
    answered -> QuickReplyState.FROZEN
    pendingReply -> QuickReplyState.PENDING
    else -> QuickReplyState.ACTIVE
}

/**
 * reply 帧序列化（纯函数——ReplyLogicTest 的 by 序列化双路断言载体；运行时
 * 出站经 adapter.sendReply 同构序列化）。by 缺省（null/空白）不序列化——
 * explicitNulls=false 省略语义，键不出现即匿名回复（D-72/D-53）。
 */
fun encodeReplyFrameJson(wid: String, selectedOption: String?, text: String?, displayName: String?): String =
    lenientJson.encodeToString(
        ReplyFrame(
            v = PROTOCOL_VERSION,
            type = "reply",
            wid = wid,
            selectedOption = selectedOption,
            text = text,
            by = displayName?.takeIf { it.isNotBlank() },
        ),
    )
