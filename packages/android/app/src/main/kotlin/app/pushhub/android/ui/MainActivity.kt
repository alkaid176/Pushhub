package app.pushhub.android.ui

import android.content.Intent
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import androidx.viewpager2.adapter.FragmentStateAdapter
import androidx.viewpager2.widget.ViewPager2
import app.pushhub.android.R
import app.pushhub.android.config.ChannelConfig
import app.pushhub.android.config.ConfigStore
import app.pushhub.android.hub.ChannelHub
import app.pushhub.android.machine.Status
import app.pushhub.android.service.PushHubService
import com.google.android.material.tabs.TabLayout
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * MainActivity tab 化（06-07 Task 2，D-80/D-81——06-06 单 Fragment 容器升级为
 * 多频道全景）。
 *
 * 结构（D-80 裁决：顶部 Tab 切换 + 横滑，微信/Slack 心智）：
 *  - TabLayout：每频道一 tab（文本=频道名）+ **末尾固定「+」项** →
 *    ChannelManageActivity（频道管理唯一入口，D-82）；
 *  - ViewPager2：FragmentStateAdapter 承载 [MessageFragment]（channelId 参数化）
 *    per 配置频道——tab 点击与横滑双向联动；
 *  - 配置变更返回后（onResume）重读配置 diff 刷新 adapter 与 tab
 *    （service 侧经 syncFromConfig 热更新连接——UI 侧只刷渲染）。
 *
 * D-81 状态表达：
 *  - 未读角标：切走的频道 tab 显示 BadgeDrawable 计数（未读=新到实时帧——
 *    ChannelWiring 仅 EmitMessage 路径且非当前频道时 bump；补拉批次结构性
 *    零计数，Pitfall 9）；切到该 tab 即清零；
 *  - 状态条：绑定**当前显示频道**的 Status 流（tab 切换联动）。
 *
 * 探活广播（D-27 第三端落位）：onResume → hub.requestVisibility(true)、
 * onStop → hub.requestVisibility(false)——service collect 转发
 * ChannelManager.setVisibility 逐频道广播。
 *
 * 架构位不变（06-06 注释承接）：UI 是纯观察层——不持有 WS 连接（连接归
 * PushHubService FGS 进程），状态经 ChannelHub 进程内共享流订阅。
 */
class MainActivity : AppCompatActivity() {

    private lateinit var banner: View
    private lateinit var statusText: TextView
    private lateinit var tabLayout: TabLayout
    private lateinit var viewPager: ViewPager2
    private lateinit var pagerAdapter: ChannelsPagerAdapter

    /** 当前 tab 集（配置快照——onResume 重读 diff）。 */
    private var channels: List<ChannelConfig> = emptyList()

    /** 当前显示频道 id（状态条/未读豁免/reply 路由的 UI 侧真值）。 */
    private var currentChannelId: String? = null

    /** tab 选择重入抑制（rebuild/弹回路径不发 setCurrentItem——防循环）。 */
    private var suppressTabSync = false

    /** 最近一次可见性意愿（hub 装配晚于 onResume 时补发不丢）。 */
    @Volatile
    private var visibilityWanted = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val config = ConfigStore(filesDir).load()
        val hasConfig = config.server.isNotBlank() && config.channels.isNotEmpty()
        if (!hasConfig) {
            // 首启无配置：全屏向导（D-82）；向导保存后经 startForegroundService 接入。
            startActivity(Intent(this, WizardActivity::class.java))
            finish()
            return
        }

        setContentView(R.layout.activity_main)
        banner = findViewById(R.id.notification_banner)
        statusText = findViewById(R.id.status_text)
        statusText.text = statusBarText(null)
        tabLayout = findViewById(R.id.channel_tabs)
        viewPager = findViewById(R.id.channel_pager)
        pagerAdapter = ChannelsPagerAdapter(this)
        viewPager.adapter = pagerAdapter

        // 权限横幅点击 → 系统通知设置（SC2 锁定行为）
        findViewById<Button>(R.id.banner_action).setOnClickListener {
            startActivity(
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                    .putExtra(Settings.EXTRA_APP_PACKAGE, packageName),
            )
        }

        refreshChannels()
        wireTabs()
        viewPager.registerOnPageChangeCallback(object : ViewPager2.OnPageChangeCallback() {
            override fun onPageSelected(position: Int) {
                if (position < channels.size) {
                    selectTabAt(position)
                    onChannelDisplayed(channels[position].id)
                }
            }
        })

        // FGS 前台启动（Pitfall 3：Android 12+ 后台启动禁止——只从前台 Activity 调）
        startForegroundService(Intent(this, PushHubService::class.java))

        observeHub()
    }

    // ---- 频道 tab 集（配置 diff 刷新） ----

    /** 重读配置刷新 tab 集/adapter（onCreate 初建 + onResume 从频道管理页返回）。 */
    private fun refreshChannels() {
        val newChannels = ConfigStore(filesDir).load().channels
        val idsChanged = newChannels.map { it.id } != channels.map { it.id }
        channels = newChannels
        pagerAdapter.submit(newChannels)
        rebuildTabs()
        if (idsChanged) {
            // 频道集变化：保持当前频道若仍存在，否则回第一个
            val keep = currentChannelId?.let { id -> newChannels.indexOfFirst { it.id == id } } ?: -1
            val target = if (keep >= 0) keep else 0
            if (newChannels.isEmpty()) {
                onChannelDisplayed(null)
            } else {
                // 初建/回退时 setCurrentItem 可能是 no-op（不派发回调）——显式同步
                viewPager.setCurrentItem(target, false)
                selectTabAt(target)
                onChannelDisplayed(newChannels[target].id)
            }
        }
    }

    /** 重建 tab 集（频道名 tab + 末尾固定「+」——D-80）。 */
    private fun rebuildTabs() {
        suppressTabSync = true
        tabLayout.removeAllTabs()
        for (channel in channels) {
            tabLayout.addTab(tabLayout.newTab().setText(channel.name), false)
        }
        tabLayout.addTab(tabLayout.newTab().setText(ADD_TAB_TEXT), false)
        currentTabIndex()?.let { idx -> tabLayout.getTabAt(idx)?.select() }
        suppressTabSync = false
    }

    private fun selectTabAt(position: Int) {
        suppressTabSync = true
        tabLayout.getTabAt(position)?.select()
        suppressTabSync = false
    }

    private fun currentTabIndex(): Int? {
        val id = currentChannelId ?: return channels.firstOrNull()?.let { 0 }
        val idx = channels.indexOfFirst { it.id == id }
        return if (idx >= 0) idx else null
    }

    /** tab 点击接线：「+」项进频道管理页（选择弹回当前频道）；频道项切 pager。 */
    private fun wireTabs() {
        tabLayout.addOnTabSelectedListener(object : TabLayout.OnTabSelectedListener {
            override fun onTabSelected(tab: TabLayout.Tab) {
                if (tab.position >= channels.size) {
                    // 「+」项：频道管理唯一入口（D-82）；选择弹回当前频道 tab
                    startActivity(Intent(this@MainActivity, ChannelManageActivity::class.java))
                    currentTabIndex()?.let { idx -> selectTabAt(idx) }
                } else if (!suppressTabSync) {
                    viewPager.setCurrentItem(tab.position, true)
                }
            }

            override fun onTabUnselected(tab: TabLayout.Tab) {}

            override fun onTabReselected(tab: TabLayout.Tab) {
                if (tab.position >= channels.size) {
                    startActivity(Intent(this@MainActivity, ChannelManageActivity::class.java))
                }
            }
        })
    }

    /** 当前显示频道切换：hub 真值同步 + 未读清零 + 状态条刷新。 */
    private fun onChannelDisplayed(channelId: String?) {
        currentChannelId = channelId
        val hub = installedHub()
        hub?.setCurrentChannel(channelId)
        if (channelId != null) hub?.clearUnread(channelId)
        refreshStatusText()
    }

    // ---- ChannelHub 订阅（06-06 结构 + 角标/探活扩展） ----

    private fun observeHub() {
        lifecycleScope.launch {
            val hub = awaitChannelHub() ?: return@launch
            // 探活补发：hub 装配晚于 onResume 时按最近意愿请求（StateFlow 当前值
            // 语义——service 装配后 collect 即读到）。
            hub.requestVisibility(visibilityWanted)
            launch {
                hub.notificationsBlocked.collect { blocked ->
                    banner.visibility = if (blocked) View.VISIBLE else View.GONE
                }
            }
            launch {
                hub.channelStatus.collect { refreshStatusText() }
            }
            launch {
                hub.unreadCounts.collect { counts -> renderBadges(counts) }
            }
        }
    }

    /** 状态条刷新（当前显示频道的 Status——tab 切换/状态变迁双路径触发）。 */
    private fun refreshStatusText() {
        val id = currentChannelId
        if (id == null) {
            statusText.text = statusBarText(null)
            return
        }
        val hub = installedHub() ?: return
        statusText.text = statusBarText(hub.channelStatus.value[id])
    }

    /** 未读角标渲染（D-81：BadgeDrawable per 频道 tab；零计数移除）。 */
    private fun renderBadges(counts: Map<String, Int>) {
        channels.forEachIndexed { index, channel ->
            val tab = tabLayout.getTabAt(index) ?: return@forEachIndexed
            val unread = counts[channel.id] ?: 0
            if (unread > 0) {
                val badge = tab.orCreateBadge
                badge.isVisible = true
                badge.number = unread
            } else {
                tab.removeBadge()
            }
        }
    }

    private fun installedHub(): ChannelHub? =
        runCatching { ChannelHub.get() }.getOrNull()

    override fun onResume() {
        super.onResume()
        visibilityWanted = true
        // 通知权限可能在系统设置中被用户改动——回到前台即重算；探活请求同步
        //（hub 未装配时 no-op，observeHub 装配后补发）。
        installedHub()?.let { hub ->
            hub.refreshNotificationsBlocked()
            hub.requestVisibility(true)
        }
        // 从频道管理页返回：diff 刷新 tab 集（service 侧已热更新连接）。
        if (this::pagerAdapter.isInitialized) refreshChannels()
    }

    override fun onStop() {
        super.onStop()
        visibilityWanted = false
        installedHub()?.requestVisibility(false)
    }

    /** ViewPager2 适配器（每频道一 MessageFragment——itemId=channelId 稳定，增删频道不复用错实例）。 */
    private class ChannelsPagerAdapter(activity: FragmentActivity) :
        FragmentStateAdapter(activity) {

        private var items: List<ChannelConfig> = emptyList()

        fun submit(newChannels: List<ChannelConfig>) {
            items = newChannels
            notifyDataSetChanged()
        }

        override fun getItemCount(): Int = items.size

        override fun createFragment(position: Int): Fragment =
            MessageFragment.newInstance(items[position].id)

        /** itemId 稳定锚：频道删除/插入引起 position 移位时，Fragment 仍按频道身份复用。 */
        override fun getItemId(position: Int): Long = items[position].id.hashCode().toLong()

        override fun containsItem(itemId: Long): Boolean =
            items.any { it.id.hashCode().toLong() == itemId }
    }

    private companion object {
        /** tab 栏末尾固定项文本（D-80——频道管理入口）。 */
        const val ADD_TAB_TEXT = "+"
    }
}

/**
 * 状态条文案（纯函数——ReplyLogicTest 断言）。
 *
 * Reconnecting 倒计时文本路径：remainingMs 为 Schedule(Reconnect) 的剩余毫秒
 * （ChannelHub 扩展点——写入方 06-05 运行时接线/06-07 ChannelManager 发布；
 * 当前无发布方时 null → 仅显示「重连中」）。null 频道态（hub 无该频道快照）
 * 显示占位符。
 */
internal fun statusBarText(status: Status?, remainingMs: Long? = null): String = when (status) {
    Status.Connecting -> "连接中"
    Status.Online -> "在线"
    Status.Reconnecting ->
        if (remainingMs != null) "重连中 · ${(remainingMs + 999) / 1000}s" else "重连中"
    Status.Offline -> "离线"
    null -> "…"
}

/**
 * 等待 ChannelHub 装配（写入方 06-05 PushHubService install 与 UI 启动顺序无
 * 保证；未装配短轮询等待，超时返回 null——UI 保持占位态不崩溃）。
 */
internal suspend fun awaitChannelHub(): ChannelHub? {
    repeat(HUB_WAIT_ROUNDS) {
        runCatching { ChannelHub.get() }.getOrNull()?.let { return it }
        delay(HUB_WAIT_INTERVAL_MS)
    }
    return null
}

private const val HUB_WAIT_ROUNDS = 100

private const val HUB_WAIT_INTERVAL_MS = 50L
