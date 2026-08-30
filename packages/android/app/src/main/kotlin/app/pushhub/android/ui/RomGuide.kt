package app.pushhub.android.ui

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.widget.Button
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationManagerCompat

// ---- 纯逻辑（JVM 可测——RomGuideLogicTest 直消） ----

/** ROM 品牌归类（D-86：按品牌动态展示引导纵深；探测结果仅本地用于展示，不外传）。 */
enum class RomKind { XIAOMI, HUAWEI, OTHER }

/** 品牌探测：Build.MANUFACTURER 小写精确匹配（xiaomi / huawei|honor / 其他）。 */
fun detectRomKind(manufacturer: String): RomKind = when (manufacturer.trim().lowercase()) {
    "xiaomi" -> RomKind.XIAOMI
    "huawei", "honor" -> RomKind.HUAWEI
    else -> RomKind.OTHER
}

/** P11 核对清单条目（id 供测试锚定，label 为展示文案）。 */
data class GuideChecklistItem(val id: String, val label: String)

/**
 * 品牌专属开关清单（P11 ③④——spike 锁屏前逐项核对项）：
 * 小米三项（自启动/省电策略/锁屏后台运行）；华为系三项（启动管理三开关/
 * 显示锁屏通知/后台弹出界面——P11 华为独立开关并入清单）；其他品牌仅通用
 * 后台设置项（白名单条目由引导区单独渲染，不在本清单）。
 */
fun romChecklistFor(kind: RomKind): List<GuideChecklistItem> = when (kind) {
    RomKind.XIAOMI -> listOf(
        GuideChecklistItem("xiaomi_autostart", RomGuideCopy.XIAOMI_AUTOSTART),
        GuideChecklistItem("xiaomi_battery", RomGuideCopy.XIAOMI_BATTERY),
        GuideChecklistItem("xiaomi_lockscreen", RomGuideCopy.XIAOMI_LOCKSCREEN),
    )
    RomKind.HUAWEI -> listOf(
        GuideChecklistItem("huawei_startup", RomGuideCopy.HUAWEI_STARTUP),
        GuideChecklistItem("huawei_lockscreen_notify", RomGuideCopy.HUAWEI_LOCKSCREEN_NOTIFY),
        GuideChecklistItem("huawei_bg_popup", RomGuideCopy.HUAWEI_BG_POPUP),
    )
    RomKind.OTHER -> listOf(
        GuideChecklistItem("generic_background", RomGuideCopy.GENERIC_BACKGROUND),
    )
}

/**
 * 厂商专属设置页（[ASSUMED] A1 组件名——训练知识，spike 真机实证后修订；
 * 集中常量声明便于一次性替换，T-06-04-01 mitigate）。
 */
data class VendorPage(
    val pkg: String,
    val cls: String,
    val label: String,
)

fun vendorPageFor(kind: RomKind): VendorPage? = when (kind) {
    RomKind.XIAOMI -> VendorPage(
        pkg = "com.miui.securitycenter",
        cls = "com.miui.permcenter.autostart.AutoStartManagementActivity",
        label = "自启动权限",
    )
    RomKind.HUAWEI -> VendorPage(
        pkg = "com.huawei.systemmanager",
        cls = "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
        label = "启动管理",
    )
    RomKind.OTHER -> null
}

/** 跳转项 UI 决策（纯函数——注入 resolveActivity 预检结果双路断言降级文案选择）。 */
sealed class VendorJumpUi {
    /** 预检可达：展示直达跳转按钮。 */
    data class JumpButton(val page: VendorPage) : VendorJumpUi()

    /** 预检失败/无厂商页/构造异常：降级为手动设置文案（结构性要求，非可选容错）。 */
    object ManualFallback : VendorJumpUi()
}

fun vendorJumpUi(page: VendorPage?, resolvable: Boolean): VendorJumpUi =
    if (page != null && resolvable) VendorJumpUi.JumpButton(page) else VendorJumpUi.ManualFallback

/** 电池白名单引导状态（官方 Pattern 7——已加白显示已就绪，未加白提供去设置按钮）。 */
sealed class BatteryGuideUi {
    object Whitelisted : BatteryGuideUi()
    data class NeedWhitelist(val packageName: String) : BatteryGuideUi()
}

fun batteryGuideUi(isIgnoringBatteryOptimizations: Boolean, packageName: String): BatteryGuideUi =
    if (isIgnoringBatteryOptimizations) BatteryGuideUi.Whitelisted
    else BatteryGuideUi.NeedWhitelist(packageName)

// ---- 引导文案常量表（集中声明便于审阅——文案纪律：如实陈述系统行为，
// 禁用恐吓式措辞；prohibition AND-06 违例词由 RomGuideLogicTest 反射断言） ----

object RomGuideCopy {
    const val SECTION_TITLE = "后台存活引导"
    const val SECTION_SUBTITLE = "按下方清单配置后，锁屏期间后台连接可持续收到通知"

    /** P11 ①：通知权限状态（areNotificationsEnabled 实读渲染）。 */
    const val NOTIFY_ENABLED = "通知权限：已授权"
    const val NOTIFY_DISABLED = "通知权限：未授权——系统会静默丢弃通知，消息界面仍可正常使用"

    /** P11 ②：电池白名单（如实陈述系统行为，不夸大）。 */
    const val BATTERY_WHITELISTED = "电池优化白名单：已加入"
    const val BATTERY_NEED = "电池优化白名单：未加入——系统可能在锁屏后清理后台，导致收不到通知"
    const val BATTERY_BUTTON = "去设置"

    /** 厂商页跳转降级文案（预检失败/跳转异常共用）。 */
    const val MANUAL_FALLBACK = "无法直达该设置页——请在系统设置中手动开启"
    const val JUMP_PREFIX = "去开启："

    /** 小米三项（P11 ③）。 */
    const val XIAOMI_AUTOSTART = "自启动权限：允许（安全中心 → 应用管理 → PushHub）"
    const val XIAOMI_BATTERY = "省电策略：无限制（安全中心 → 省电与电池 → 应用智能省电）"
    const val XIAOMI_LOCKSCREEN = "锁屏后台运行：允许"

    /** 华为系三项（P11 ④——启动管理三开关 + 两个独立开关并入清单）。 */
    const val HUAWEI_STARTUP = "启动管理：三开关全开（自启动/关联启动/后台活动）"
    const val HUAWEI_LOCKSCREEN_NOTIFY = "显示锁屏通知：开（通知设置独立开关）"
    const val HUAWEI_BG_POPUP = "后台弹出界面：允许（应用启动管理独立开关）"

    /** 其他品牌通用项。 */
    const val GENERIC_BACKGROUND = "应用后台运行：允许（系统设置 → 应用 → PushHub → 电池/流量）"

    /** P11 ⑤：FGS 常驻核对（spike 装机前置）。 */
    const val FGS_CHECK = "通知栏可见 PushHub 常驻通知（常驻通知消失即后台连接被停止）"

    /** 清单区标题（checkbox 逐项核对——spike 前逐项核对与截图）。 */
    const val CHECKLIST_TITLE = "锁屏前逐项核对："
}

// ---- Android 绑定层（Intent 构造/预检/渲染——runCatching + resolveActivity 为结构性要求） ----

object RomGuideAndroid {

    /** 电池白名单直达请求 Intent（官方 Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS）。 */
    fun batteryWhitelistRequestIntent(packageName: String): Intent =
        Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:$packageName"),
        )

    fun isIgnoringBatteryOptimizations(context: Context): Boolean =
        context.getSystemService(PowerManager::class.java)
            .isIgnoringBatteryOptimizations(context.packageName)

    /** 通知总开关（P11 ①——areNotificationsEnabled 实读）。 */
    fun notificationsEnabled(context: Context): Boolean =
        NotificationManagerCompat.from(context).areNotificationsEnabled()

    /** 厂商页 Intent 构造（runCatching 包裹——组件不存在/ROM 改版抛异常收口为 null）。 */
    fun vendorPageIntent(page: VendorPage): Intent? = runCatching {
        Intent().setComponent(ComponentName(page.pkg, page.cls))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }.getOrNull()

    /**
     * 厂商页跳转决策：构造（runCatching）→ resolveActivity 预检（runCatching）→
     * 纯函数决策。预检失败或构造异常 → 降级文案（T-06-04-01 mitigate）。
     */
    fun vendorJump(context: Context, kind: RomKind): VendorJumpUi {
        val page = vendorPageFor(kind) ?: return VendorJumpUi.ManualFallback
        val intent = vendorPageIntent(page) ?: return VendorJumpUi.ManualFallback
        val resolvable = runCatching {
            context.packageManager.resolveActivity(intent, 0) != null
        }.getOrDefault(false)
        return vendorJumpUi(page, resolvable)
    }
}

/**
 * 引导区渲染（可内嵌向导/频道管理页——容器注入）。结构：
 *  ① 通知权限状态行（areNotificationsEnabled 实读，P11 ①）；
 *  ② 电池白名单状态 + 未加白时「去设置」按钮（P11 ②）；
 *  ③ 厂商页直达按钮（预检可达）或降级文案 + 品牌专属开关 checkbox 清单（P11 ③④）；
 *  ④ FGS 常驻核对行（P11 ⑤）。
 *
 * 跳转按钮点击同样 runCatching 包裹（预检通过后跳转仍可能异常——ROM 版本差异），
 * 失败即降级文案（结构性要求）。
 */
fun renderRomGuide(container: LinearLayout) {
    val context = container.context
    container.removeAllViews()
    val kind = detectRomKind(Build.MANUFACTURER)

    container.addView(sectionTitle(context, RomGuideCopy.SECTION_TITLE, bold = true))
    container.addView(sectionTitle(context, RomGuideCopy.SECTION_SUBTITLE, bold = false))

    // ① 通知权限状态（实读）。
    container.addView(
        sectionTitle(
            context,
            if (RomGuideAndroid.notificationsEnabled(context)) RomGuideCopy.NOTIFY_ENABLED
            else RomGuideCopy.NOTIFY_DISABLED,
            bold = false,
        ),
    )

    // ② 电池白名单。
    when (val battery = batteryGuideUi(RomGuideAndroid.isIgnoringBatteryOptimizations(context), context.packageName)) {
        is BatteryGuideUi.Whitelisted ->
            container.addView(sectionTitle(context, RomGuideCopy.BATTERY_WHITELISTED, bold = false))
        is BatteryGuideUi.NeedWhitelist -> {
            container.addView(sectionTitle(context, RomGuideCopy.BATTERY_NEED, bold = false))
            container.addView(button(context, RomGuideCopy.BATTERY_BUTTON) {
                runCatching {
                    context.startActivity(RomGuideAndroid.batteryWhitelistRequestIntent(battery.packageName))
                }
            })
        }
    }

    // ③ 厂商页跳转（预检）+ 品牌专属清单。
    when (val jump = RomGuideAndroid.vendorJump(context, kind)) {
        is VendorJumpUi.JumpButton -> {
            val intent = RomGuideAndroid.vendorPageIntent(jump.page)
            container.addView(
                button(context, RomGuideCopy.JUMP_PREFIX + jump.page.label) {
                    if (intent != null) {
                        // 预检通过后的实际跳转仍防御式包裹（跳转异常 → 降级文案）。
                        runCatching { context.startActivity(intent) }
                            .onFailure { container.addView(sectionTitle(context, RomGuideCopy.MANUAL_FALLBACK, bold = false)) }
                    } else {
                        container.addView(sectionTitle(context, RomGuideCopy.MANUAL_FALLBACK, bold = false))
                    }
                },
            )
        }
        VendorJumpUi.ManualFallback ->
            container.addView(sectionTitle(context, RomGuideCopy.MANUAL_FALLBACK, bold = false))
    }

    container.addView(sectionTitle(context, RomGuideCopy.CHECKLIST_TITLE, bold = true))
    for (item in romChecklistFor(kind)) {
        val cb = CheckBox(context)
        cb.text = item.label
        cb.textSize = 13f
        container.addView(cb)
    }

    // ⑤ FGS 常驻核对。
    container.addView(sectionTitle(context, RomGuideCopy.FGS_CHECK, bold = false))
}

private fun sectionTitle(context: android.content.Context, text: String, bold: Boolean): TextView =
    TextView(context).apply {
        this.text = text
        textSize = if (bold) 16f else 13f
        setIsBold(bold)
        setPadding(0, 12, 0, 4)
    }

private fun TextView.setIsBold(bold: Boolean) {
    paint.isFakeBoldText = bold
}

private fun button(context: android.content.Context, text: String, onClick: () -> Unit): Button =
    Button(context).apply {
        this.text = text
        setOnClickListener { onClick() }
    }
