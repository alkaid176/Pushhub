package app.pushhub.android

import android.Manifest
import android.app.ActivityManager
import android.content.pm.PackageManager
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.pushhub.android.hub.ChannelHub
import app.pushhub.android.hub.HubEvent
import app.pushhub.android.machine.Buffer
import app.pushhub.android.protocol.AnsweredFrame
import app.pushhub.android.protocol.MessageFrame
import app.pushhub.android.service.ChannelWiring
import app.pushhub.android.service.NotificationRouter
import app.pushhub.android.service.Notifier
import app.pushhub.android.service.PushHubService
import app.pushhub.android.service.SpikeLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.junit.AfterClass
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * 通知 instrumentation 测试（06-05 Task 2，真机/spike 设备执行——AND-02）。
 *
 * 三路径（计划锁定）：
 *  ① 实时帧 → activeNotifications 含 tag=wid（tag 配对证真）；
 *  ② answered → 该通知消失（D-69 闭环）；
 *  ③ pm revoke 通知权限 → show 跳过 + notificationsBlocked 为真 + **服务仍在
 *     运行**（Pitfall 4：拒绝=静默丢弃但 FGS 照常——本测试正是该文档行为在
 *     spike 真机上的实证口）。
 *
 * 执行环境说明（「设备不在场时跳过不失败」的实现口径）：androidTest 套件本身
 * 只在 connectedDebugAndroidTest 且有设备连接时执行（gradle 层门槛）；套件内
 * 各用例以 Assume.assumeTrue 守卫环境前置（权限授予失败/通道被系统禁用等），
 * 前置不满足即跳过（SKIP）不失败——spike 装机时补跑即本文件的设计用途。
 *
 * 测试手法：ChannelWiring 直连注入（"经 mock 或直连服务注入 ChannelEvents"的
 * 直连选项）——NotificationRouter/SpikeLog/ChannelHub 用**真实实例**（targetContext
 * 权限检查函数与服务装配同款注入），仅 Notifier 层包计数器观测 show 跳过。
 * 服务启动经 `am start-foreground-service`（shell 通道，不受 Android 12+ 后台
 * 启动 FGS 限制——Pitfall 3 测试侧正解）。
 */
@RunWith(AndroidJUnit4::class)
class NotificationInstrumentTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private val nm = context.getSystemService(android.app.NotificationManager::class.java)

    // ---- 装配（与服务同款的真实依赖面）----

    /** 计数包装（③ 路径证明 show 被**跳过**而非被系统丢弃）。 */
    private class CountingNotifier(private val router: NotificationRouter) : Notifier {
        var shown = 0
            private set

        override fun show(
            channelId: String,
            channelName: String,
            wid: String,
            title: String?,
            text: String,
            priority: String,
            createdAt: Long,
        ) {
            shown += 1
            router.show(channelId, channelName, wid, title, text, priority, createdAt)
        }

        override fun cancel(wid: String) = router.cancel(wid)
    }

    private fun msg(seq: Long): MessageFrame = MessageFrame(
        v = 1,
        wid = "m_itest$seq",
        seq = seq,
        title = "instrument $seq",
        text = "instrumentation test message $seq",
        priority = "high",
        answered = false,
        createdAt = 1_700_000_000 + seq,
    )

    private fun answered(wid: String): AnsweredFrame = AnsweredFrame(
        v = 1,
        wid = wid,
        seq = 0,
        answered = true,
        answeredAt = 1_700_000_100,
    )

    /** 真实依赖装配：权限检查函数与 PushHubService 装配逐字同款（双路注入）。 */
    private fun newWiring(events: MutableList<HubEvent>): Pair<ChannelWiring, CountingNotifier> {
        val router = NotificationRouter(context)
        val hub = ChannelHub(
            runtimePermissionGranted = {
                ContextCompat.checkSelfPermission(
                    context,
                    Manifest.permission.POST_NOTIFICATIONS,
                ) == PackageManager.PERMISSION_GRANTED
            },
            notificationsEnabled = { NotificationManagerCompat.from(context).areNotificationsEnabled() },
            sdkInt = { Build.VERSION.SDK_INT },
        )
        val counting = CountingNotifier(router)
        val wiring = ChannelWiring(
            channelId = "ch_itest",
            channelName = { "instrument-test" },
            buffer = Buffer(),
            notifier = counting,
            hub = hub,
            spikeLog = SpikeLog(File(context.filesDir, "instrument-spike-log")),
            refreshBlocked = hub::refreshNotificationsBlocked,
            onStatusChanged = {},
        )
        CoroutineScope(Dispatchers.Unconfined).launch { hub.events.collect { events += it } }
        return wiring to counting
    }

    private fun notificationsGranted(): Boolean {
        val runtime = Build.VERSION.SDK_INT < 33 ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        return runtime && NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /** 通知前置可用性守卫（grant 失败/系统禁用 → SKIP 不失败）。 */
    private fun assumeNotificationsUsable() {
        assumeTrue("通知权限/开关不可用——环境前置不满足，SKIP", notificationsGranted())
    }

    // ---- 轮询等待（通知投递异步）----

    private inline fun awaitTrue(timeoutMs: Long = 5_000, crossinline probe: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (probe()) return true
            Thread.sleep(100)
        }
        return probe()
    }

    private fun activeTag(wid: String) = nm.activeNotifications.any { it.tag == wid }

    // ---- ① 实时帧 → tag=wid 通知出现 ----

    @Test
    fun messageShowsNotificationWithTagWid() {
        assumeNotificationsUsable()
        val (wiring, counting) = newWiring(mutableListOf())
        wiring.onMessage(msg(101))
        assertTrue(
            "activeNotifications 应含 tag=m_itest101",
            awaitTrue { activeTag("m_itest101") },
        )
        assertEquals("show 恰一次", 1, counting.shown)
    }

    // ---- ② answered → 通知消失（D-69）----

    @Test
    fun answeredCancelsNotificationWithSameTag() {
        assumeNotificationsUsable()
        val (wiring, _) = newWiring(mutableListOf())
        wiring.onMessage(msg(102))
        assertTrue("通知先出现", awaitTrue { activeTag("m_itest102") })
        wiring.onAnswered(answered("m_itest102"))
        assertTrue(
            "answered 后通知消失（cancel 同 tag 配对）",
            awaitTrue { !activeTag("m_itest102") },
        )
    }

    // ---- ③ 权限被拒 → show 跳过 + blocked 状态 + 服务仍在运行 ----

    @Test
    fun revokedPermissionSkipsShowButServiceKeepsRunning() {
        // pm revoke 走运行时权限通道——API 33+ 才有 POST_NOTIFICATIONS 可撤。
        assumeTrue("③ 需 API 33+（revoke 运行时通知权限）", Build.VERSION.SDK_INT >= 33)
        val ui = InstrumentationRegistry.getInstrumentation().uiAutomation

        // 服务启动（shell 通道 am start-foreground-service——不受后台启动限制）。
        ui.executeShellCommand(
            "am start-foreground-service -n ${context.packageName}/${PushHubService::class.java.name}",
        )
        assumeTrue("服务应进入运行态", awaitTrue(timeoutMs = 10_000) { isServiceRunning() })

        val events = mutableListOf<HubEvent>()
        val (wiring, counting) = newWiring(events)
        try {
            ui.executeShellCommand("pm revoke ${context.packageName} android.permission.POST_NOTIFICATIONS")
            // revoke 生效有窗口——轮询到权限口径确实翻转为未授权再触发消息。
            assumeTrue(
                "revoke 后运行时权限应翻转为未授权",
                awaitTrue(timeoutMs = 10_000) {
                    ContextCompat.checkSelfPermission(
                        context,
                        Manifest.permission.POST_NOTIFICATIONS,
                    ) != PackageManager.PERMISSION_GRANTED
                },
            )
            wiring.onMessage(msg(103))
            assertFalse("show 被跳过（前置检查拦截，非系统丢弃）", counting.shown > 0)
            assertTrue(
                "通知不出现",
                awaitTrue { !activeTag("m_itest103") },
            )
            assertEquals("连接侧副作用照常（Pitfall 4：Hub 事件仍发）", 1, events.size)
            assertTrue("服务仍在运行（FGS 不因通知权限被拒而死）", isServiceRunning())
        } finally {
            // 还原权限与停止服务——不污染 spike 装机态。
            ui.executeShellCommand("pm grant ${context.packageName} android.permission.POST_NOTIFICATIONS")
            ui.executeShellCommand(
                "am stopservice -n ${context.packageName}/${PushHubService::class.java.name}",
            )
        }
    }

    /** 服务运行断言：getRunningServices 现行口径仅返回调用方自身服务——正是所需。 */
    @Suppress("DEPRECATION")
    private fun isServiceRunning(): Boolean = try {
        val am = context.getSystemService(ActivityManager::class.java)
        am.getRunningServices(Int.MAX_VALUE).any {
            it.service.className == PushHubService::class.java.name
        }
    } catch (e: Exception) {
        false
    }

    companion object {
        @BeforeClass
        @JvmStatic
        fun grantNotificationPermission() {
            // 测试自身不持有权限授予能力——shell 通道预授（API 33+；33- 无运行时权限）。
            if (Build.VERSION.SDK_INT >= 33) {
                InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(
                    "pm grant app.pushhub.android android.permission.POST_NOTIFICATIONS",
                )
            }
        }

        @AfterClass
        @JvmStatic
        fun cleanup() {
            nmStatic?.cancelAll()
        }

        private val nmStatic: android.app.NotificationManager? by lazy {
            InstrumentationRegistry.getInstrumentation().targetContext
                .getSystemService(android.app.NotificationManager::class.java)
        }
    }
}
