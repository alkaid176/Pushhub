package app.pushhub.android.ui

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import app.pushhub.android.R
import app.pushhub.android.protocol.ServerFrame
import app.pushhub.android.render.CardFriendlyLinkMovement
import app.pushhub.android.render.MarkwonProvider
import com.google.android.material.card.MaterialCardView
import io.noties.markwon.Markwon
import java.util.Locale

/**
 * 列表项视图模型：消息帧 + UI 态覆盖（选中/本地乐观置灰/定位高亮）。
 *
 * data class 等值承载 DiffUtil areContentsTheSame——任一覆盖态变化即原位刷新。
 */
data class MessageItem(
    val frame: ServerFrame.Message,
    val selected: Boolean = false,
    /** 本地乐观态：已发出回复等待 answered 权威帧——按钮区置灰（不做本地假 answered）。 */
    val pendingReply: Boolean = false,
    /** scrollToWid 定位高亮（渐隐动画中）。 */
    val flash: Boolean = false,
)

/**
 * 消息列表 Adapter（06-06 Task 2，AND-03/RPL-05）——桌面 message-list.ts 的
 * Android 对应物（D-60 观察者渲染：增量插入与 answered 原位更新经 ListAdapter
 * 的 wid diff 自动计算）。
 *
 * 渲染纪律（SC3）：title/text/answered_content 三处富文本一律经 MarkwonProvider
 * 的消毒管道（Markwon.setMarkdown）；任何消息文本不经管道不得进 TextView。
 *
 * viewType 两态（acceptance 源码断言锚点）：
 *  - TYPE_NORMAL（未答）：快捷选项按钮横排可点（最多 [QUICK_OPTION_LIMIT]）；
 *  - TYPE_ANSWERED（已答）：快捷按钮区冻结移除 + answered 展示区出现
 *    （RPL-05 防重复处置——他人回复同样冻结本端按钮）。
 */
class MessageListAdapter(
    markwonContext: android.content.Context,
    private val onQuickReply: (wid: String, option: String) -> Unit,
    private val onMessageClick: (wid: String) -> Unit,
) : ListAdapter<MessageItem, MessageListAdapter.Holder>(ItemCallback) {

    private val markwon: Markwon = MarkwonProvider.get(markwonContext)

    /** viewType 两态（未答/已答）。 */
    override fun getItemViewType(position: Int): Int =
        if (getItem(position).frame.answered) TYPE_ANSWERED else TYPE_NORMAL

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder =
        Holder(LayoutInflater.from(parent.context).inflate(R.layout.item_message, parent, false))

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val item = getItem(position)
        val frame = item.frame

        // 标题行（无 title 隐藏——协议省略语义）
        if (frame.title.isNullOrBlank()) {
            holder.title.visibility = View.GONE
        } else {
            holder.title.visibility = View.VISIBLE
            renderMarkdown(holder.title, frame.title)
        }

        // 正文——消毒管道唯一入口（SC3）
        renderMarkdown(holder.body, frame.text)

        // seq/时间戳辅助行
        holder.meta.text = "#${frame.seq} · ${formatTime(frame.createdAt)}"

        // viewType 分型绑定（acceptance：answered 态冻结快捷按钮区）
        if (frame.answered) {
            holder.answeredPrefix.visibility = View.VISIBLE
            holder.answeredPrefix.text = answeredPrefixText(frame.answeredBy)
            if (frame.answeredContent.isNullOrBlank()) {
                holder.answeredContent.visibility = View.GONE
            } else {
                holder.answeredContent.visibility = View.VISIBLE
                renderMarkdown(holder.answeredContent, frame.answeredContent)
            }
            holder.quickOptions.removeAllViews()
            holder.quickOptions.visibility = View.GONE
        } else {
            holder.answeredPrefix.visibility = View.GONE
            holder.answeredContent.visibility = View.GONE
            bindQuickOptions(holder, item)
        }

        // 选中态/定位高亮视觉（stroke 描边：选中 2dp 蓝、定位高亮 3dp 橙渐隐）
        val dp = holder.card.resources.displayMetrics.density
        when {
            item.flash -> {
                holder.card.strokeWidth = (3 * dp).toInt()
                holder.card.strokeColor = 0xFFFF9800.toInt()
            }
            item.selected -> {
                holder.card.strokeWidth = (2 * dp).toInt()
                holder.card.strokeColor = 0xFF1E6BFF.toInt()
            }
            else -> holder.card.strokeWidth = 0
        }
        // 本地乐观置灰（已发回复待 answered 权威帧——RPL-05）
        holder.card.alpha = if (item.pendingReply) 0.55f else 1f

        holder.itemView.setOnClickListener { onMessageClick(frame.wid) }
    }

    /**
     * 渲染 + movementMethod 覆写（真机 UAT 实证修复 Bug C）：Markwon 每次渲染
     * 隐式设 LinkMovementMethod（吞掉正文区全部触摸 → 卡片选中点击永不触发），
     * 渲染后统一覆写为 [CardFriendlyLinkMovement]——链接白名单点击照常，空白区
     * 放行冒泡到 itemView 选中。
     */
    private fun renderMarkdown(view: TextView, text: String) {
        markwon.setMarkdown(view, text)
        view.movementMethod = CardFriendlyLinkMovement
    }

    /** 快捷选项横排（未答消息；options 空/全空白不渲染——空态纪律）。 */
    private fun bindQuickOptions(holder: Holder, item: MessageItem) {
        val options = (item.frame.options ?: emptyList())
            .filter { it.isNotBlank() }
            .take(QUICK_OPTION_LIMIT)
        holder.quickOptions.removeAllViews()
        if (options.isEmpty()) {
            holder.quickOptions.visibility = View.GONE
            return
        }
        holder.quickOptions.visibility = View.VISIBLE
        val ctx = holder.quickOptions.context
        for (option in options) {
            val btn = Button(ctx, null, android.R.attr.borderlessButtonStyle).apply {
                text = option
                isAllCaps = false
                // pendingReply 置灰（本地乐观态——RPL-05 等待权威帧）
                isEnabled = !item.pendingReply
                setOnClickListener { onQuickReply(item.frame.wid, option) }
            }
            val lp = android.widget.LinearLayout.LayoutParams(
                0,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                1f,
            ).apply { marginEnd = (4 * ctx.resources.displayMetrics.density).toInt() }
            holder.quickOptions.addView(btn, lp)
        }
    }

    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val card: MaterialCardView = view.findViewById(R.id.msg_card)
        val title: TextView = view.findViewById(R.id.msg_title)
        val body: TextView = view.findViewById(R.id.msg_text)
        val meta: TextView = view.findViewById(R.id.msg_meta)
        val answeredPrefix: TextView = view.findViewById(R.id.answered_prefix)
        val answeredContent: TextView = view.findViewById(R.id.answered_content)
        val quickOptions: ViewGroup = view.findViewById(R.id.quick_options)
    }

    companion object {
        /** viewType 两态常量（源码断言锚点）。 */
        const val TYPE_NORMAL = 0
        const val TYPE_ANSWERED = 1

        /** 快捷选项渲染上限（OPTIONS_MAX_COUNT 同量级裁剪——随帧 options 超出忽略）。 */
        const val QUICK_OPTION_LIMIT = 4

        /** answered 前缀行（RPL-05：answered_by 缺省匿名形态）。 */
        fun answeredPrefixText(answeredBy: String?): String =
            if (answeredBy.isNullOrBlank()) "✓ 已回复：" else "✓ 已由 $answeredBy 回复："

        fun formatTime(epochMs: Long): String {
            // created_at 为毫秒 epoch（golden fixtures 冻结值：1756185600000 量级）
            val cal = java.util.Calendar.getInstance().apply { timeInMillis = epochMs }
            return String.format(
                Locale.getDefault(),
                "%02d:%02d",
                cal.get(java.util.Calendar.HOUR_OF_DAY),
                cal.get(java.util.Calendar.MINUTE),
            )
        }

        /** wid 定位 diff（等值 wid 即同项；内容含 UI 覆盖态全量比较）。 */
        val ItemCallback = object : DiffUtil.ItemCallback<MessageItem>() {
            override fun areItemsTheSame(oldItem: MessageItem, newItem: MessageItem): Boolean =
                oldItem.frame.wid == newItem.frame.wid

            override fun areContentsTheSame(oldItem: MessageItem, newItem: MessageItem): Boolean =
                oldItem == newItem
        }
    }
}
