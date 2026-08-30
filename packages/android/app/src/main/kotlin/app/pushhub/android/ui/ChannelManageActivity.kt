package app.pushhub.android.ui

import android.content.Intent
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import app.pushhub.android.R
import app.pushhub.android.config.ChannelConfig
import app.pushhub.android.config.ConfigError
import app.pushhub.android.config.ConfigStore
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout

/**
 * Channel Key 打码（仅尾 4 位可见——密钥不入明文展示面；短密钥全打码）。
 */
fun maskChannelKey(key: String): String =
    if (key.length <= 4) MASK else MASK + key.takeLast(4)

private const val MASK = "••••"

/**
 * 频道管理页（06-04 Task 3，D-82）。
 *
 *  - 列表（RecyclerView）：频道名 + 服务器摘要 + Key 打码（仅尾 4 位）；
 *  - 编辑：MaterialAlertDialog 双输入（改名/换 Key）确认后更新——id 恒不变
 *    （D-87 通道锚纪律）；
 *  - 删除：逐字确认框（对齐桌面/管理页 03-03 删除确认先例——GitHub 删仓库
 *    模式：输入非空且为频道名前缀才启用确认按钮）。频道删除后其通知通道组
 *    遗留是可接受的系统行为，不做主动删通道（D-87 纪律）；
 *  - 添加：底部按钮以添加模式复用向导表单（WizardActivity MODE_ADD——同一
 *    表单校验逻辑单一来源）；
 *  - 变更落 ConfigStore 后重启 PushHubService 使配置生效（过渡语义——06-07
 *    ChannelManager 落地热更新后替换为增量同步）。
 */
class ChannelManageActivity : AppCompatActivity() {

    private lateinit var listAdapter: ChannelAdapter
    private val configStore: ConfigStore get() = ConfigStore(filesDir)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_channel_manage)

        val list = findViewById<RecyclerView>(R.id.channel_list)
        listAdapter = ChannelAdapter(
            serverProvider = { configStore.load().server },
            onEdit = ::showEditDialog,
            onDelete = ::showDeleteDialog,
        )
        list.layoutManager = LinearLayoutManager(this)
        list.adapter = listAdapter

        findViewById<Button>(R.id.btn_add_channel).setOnClickListener {
            startActivity(
                Intent(this, WizardActivity::class.java)
                    .putExtra(WizardActivity.EXTRA_MODE, WizardActivity.MODE_ADD),
            )
        }

        renderRomGuide(findViewById(R.id.rom_guide_container))
    }

    override fun onResume() {
        super.onResume()
        // 从向导（添加模式）返回时刷新列表。
        listAdapter.submit(configStore.load().channels)
    }

    // ---- 编辑（改名/换 Key——id 不变，D-87） ----

    private fun showEditDialog(channel: ChannelConfig) {
        val nameInput = TextInputEditText(this).apply { setText(channel.name) }
        val keyInput = TextInputEditText(this).apply {
            setText(channel.key)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        val form = dialogForm("频道名", nameInput, "Channel Key", keyInput)
        MaterialAlertDialogBuilder(this)
            .setTitle("编辑频道")
            .setView(form)
            .setPositiveButton("更新") { _, _ ->
                val name = nameInput.text?.toString()?.trim().orEmpty()
                val key = keyInput.text?.toString()?.trim().orEmpty()
                if (name.isEmpty() || key.isEmpty()) return@setPositiveButton
                try {
                    configStore.updateChannel(channel.id, name, key)
                    restartPushHubService(this)
                } catch (e: ConfigError.DuplicateChannel) {
                    // 静态短句反馈（不静默吞——用户需知更新为何未生效）。
                    android.widget.Toast.makeText(this, "已存在同名频道", android.widget.Toast.LENGTH_SHORT).show()
                } catch (e: ConfigError) {
                    // id 不存在（并发删除）——列表刷新回真值。
                }
                listAdapter.submit(configStore.load().channels)
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ---- 删除（逐字确认——03-03 GitHub 删仓库模式前缀联动） ----

    private fun showDeleteDialog(channel: ChannelConfig) {
        val confirmInput = EditText(this).apply { hint = "输入频道名称的开头部分" }
        val dialog = MaterialAlertDialogBuilder(this)
            .setTitle("删除频道「${channel.name}」？")
            .setMessage("删除后本机不再连接该频道；历史消息仍在服务端保留。输入频道名称以确认：")
            .setView(confirmInput)
            .setPositiveButton("删除频道") { _, _ ->
                try {
                    configStore.removeChannel(channel.id)
                    restartPushHubService(this)
                } catch (e: ConfigError) {
                    // id 不存在（并发删除）——静默，列表刷新回真值。
                }
                listAdapter.submit(configStore.load().channels)
            }
            .setNegativeButton("取消", null)
            .show()
        // 前缀联动：输入非空且为频道名前缀才启用确认按钮（对齐管理页 03-03 先例）。
        val positive = dialog.getButton(androidx.appcompat.app.AlertDialog.BUTTON_POSITIVE)
        positive.isEnabled = false
        confirmInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: Editable?) {
                val typed = s?.toString().orEmpty()
                positive.isEnabled = typed.isNotEmpty() && channel.name.startsWith(typed)
            }
        })
    }

    /** 双输入表单（编辑对话框载体——Material TextInputLayout 包裹）。 */
    private fun dialogForm(
        nameHint: String,
        nameInput: TextInputEditText,
        keyHint: String,
        keyInput: TextInputEditText,
    ): View {
        val pad = (16 * resources.displayMetrics.density).toInt()
        return android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            setPadding(pad, pad, pad, 0)
            addView(TextInputLayout(context).apply { hint = nameHint; addView(nameInput) })
            addView(TextInputLayout(context).apply { hint = keyHint; addView(keyInput) })
        }
    }
}

/** 频道列表适配器（Key 打码——仅尾 4 位可见）。 */
private class ChannelAdapter(
    private val serverProvider: () -> String,
    private val onEdit: (ChannelConfig) -> Unit,
    private val onDelete: (ChannelConfig) -> Unit,
) : RecyclerView.Adapter<ChannelAdapter.Holder>() {

    private var channels: List<ChannelConfig> = emptyList()

    fun submit(newChannels: List<ChannelConfig>) {
        channels = newChannels
        notifyDataSetChanged()
    }

    class Holder(view: View) : RecyclerView.ViewHolder(view) {
        val name: TextView = view.findViewById(R.id.item_channel_name)
        val server: TextView = view.findViewById(R.id.item_channel_server)
        val key: TextView = view.findViewById(R.id.item_channel_key)
        val edit: Button = view.findViewById(R.id.btn_edit_channel)
        val delete: Button = view.findViewById(R.id.btn_delete_channel)
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder =
        Holder(LayoutInflater.from(parent.context).inflate(R.layout.item_channel, parent, false))

    override fun getItemCount(): Int = channels.size

    override fun onBindViewHolder(holder: Holder, position: Int) {
        val channel = channels[position]
        holder.name.text = channel.name
        holder.server.text = serverProvider()
        holder.key.text = maskChannelKey(channel.key)
        holder.edit.setOnClickListener { onEdit(channel) }
        holder.delete.setOnClickListener { onDelete(channel) }
    }
}
