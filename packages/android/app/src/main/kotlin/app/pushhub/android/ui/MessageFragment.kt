package app.pushhub.android.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.core.os.bundleOf
import androidx.fragment.app.Fragment
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import app.pushhub.android.R
import app.pushhub.android.hub.ChannelHub
import app.pushhub.android.hub.HubEvent
import app.pushhub.android.machine.Buffer
import app.pushhub.android.protocol.AnsweredFrame
import app.pushhub.android.protocol.MessageFrame
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

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

        // 视图创建时缓冲 snapshot() 全量初绘（D-60：快照重建语义）
        renderAll()
        observeHub()
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

    /** 快捷选项回复入口（Task 3 接 outbox 出站）。 */
    private fun sendQuickReply(wid: String, option: String) {
        // Task 3：构造恰一载荷 → adapter.sendReply 直发（outbox 语义，不进状态机）
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

        internal fun bufferFor(channelId: String): Buffer =
            channelBuffers.getOrPut(channelId) { Buffer() }

        /** 测试隔离：清空缓冲存储（JVM/Robolectric 测试间互不污染）。 */
        internal fun resetBuffersForTest() {
            channelBuffers.clear()
        }

        fun newInstance(channelId: String): MessageFragment =
            MessageFragment().apply { arguments = bundleOf(ARG_CHANNEL_ID to channelId) }
    }
}
