package app.pushhub.android.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Field
import java.lang.reflect.Modifier

/**
 * RomGuide 纯逻辑测试（06-04 Task 3，JVM——零 Android 依赖）。
 *
 * 覆盖（计划三类）：
 *  ① 品牌字符串 → 清单项映射纯函数（xiaomi/huawei/honor/未知四路）；
 *  ② Intent 构造与预检逻辑拆纯接口（注入 resolveActivity 结果 true/false 两路
 *     断言降级文案选择）+ 白名单状态判定；
 *  ③ 文案纪律：RomGuideCopy 常量表逐条可读审阅 + 反射断言无恐吓式措辞
 *     （prohibition AND-06）。
 */
class RomGuideLogicTest {

    // ---- ① 品牌四路映射 ----

    @Test
    fun romDetectionFourPaths() {
        assertEquals(RomKind.XIAOMI, detectRomKind("Xiaomi"))
        assertEquals(RomKind.XIAOMI, detectRomKind("  xiaomi  "))
        assertEquals(RomKind.HUAWEI, detectRomKind("HUAWEI"))
        assertEquals(RomKind.HUAWEI, detectRomKind("Honor"))
        assertEquals(RomKind.OTHER, detectRomKind("samsung"))
        assertEquals(RomKind.OTHER, detectRomKind("Google"))
        assertEquals(RomKind.OTHER, detectRomKind(""))
    }

    @Test
    fun checklistMappingXiaomiThreeItems() {
        val items = romChecklistFor(RomKind.XIAOMI)
        assertEquals(3, items.size)
        assertEquals(listOf("xiaomi_autostart", "xiaomi_battery", "xiaomi_lockscreen"), items.map { it.id })
        // 三项文案与 P11 ③ 对齐（自启动/省电策略/锁屏后台运行）。
        assertTrue(items[0].label.contains("自启动"))
        assertTrue(items[1].label.contains("省电策略"))
        assertTrue(items[2].label.contains("锁屏后台运行"))
    }

    @Test
    fun checklistMappingHuaweiThreeItemsIncludingP11IndependentSwitches() {
        val items = romChecklistFor(RomKind.HUAWEI)
        assertEquals(3, items.size)
        // 启动管理三开关 + 两个独立开关（P11 ④——显示锁屏通知/后台弹出界面并入清单）。
        assertTrue(items[0].label.contains("启动管理"))
        assertTrue(items[1].label.contains("显示锁屏通知"))
        assertTrue(items[2].label.contains("后台弹出界面"))
    }

    @Test
    fun checklistMappingUnknownOnlyGenericItem() {
        val items = romChecklistFor(RomKind.OTHER)
        assertEquals(1, items.size)
        assertEquals("generic_background", items[0].id)
    }

    @Test
    fun vendorPagesAssumedA1Constants() {
        // [ASSUMED] A1 组件名集中常量（T-06-04-01——spike 实证后修订点唯一）。
        val mi = vendorPageFor(RomKind.XIAOMI)!!
        assertEquals("com.miui.securitycenter", mi.pkg)
        assertEquals("com.miui.permcenter.autostart.AutoStartManagementActivity", mi.cls)
        val hw = vendorPageFor(RomKind.HUAWEI)!!
        assertEquals("com.huawei.systemmanager", hw.pkg)
        assertEquals("com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity", hw.cls)
        assertEquals(null, vendorPageFor(RomKind.OTHER))
    }

    // ---- ② 预检双路降级 + 白名单状态判定 ----

    @Test
    fun vendorJumpResolvableTrueShowsButton() {
        val page = vendorPageFor(RomKind.XIAOMI)!!
        val ui = vendorJumpUi(page, resolvable = true)
        assertTrue(ui is VendorJumpUi.JumpButton)
        assertEquals(page, (ui as VendorJumpUi.JumpButton).page)
    }

    @Test
    fun vendorJumpResolvableFalseFallsBackToManualCopy() {
        // 预检失败 → 降级文案（结构性要求，不是可选容错）。
        val page = vendorPageFor(RomKind.XIAOMI)!!
        val ui = vendorJumpUi(page, resolvable = false)
        assertEquals(VendorJumpUi.ManualFallback, ui)
        // 降级文案常量存在且非空（渲染层消费同一常量——本测试锚定不漂移）。
        assertTrue(RomGuideCopy.MANUAL_FALLBACK.isNotBlank())
        assertTrue(RomGuideCopy.MANUAL_FALLBACK.contains("手动"))
    }

    @Test
    fun vendorJumpNoVendorPageFallsBack() {
        assertEquals(VendorJumpUi.ManualFallback, vendorJumpUi(null, resolvable = true))
    }

    @Test
    fun batteryGuideStateDetermination() {
        assertEquals(BatteryGuideUi.Whitelisted, batteryGuideUi(true, "app.pushhub.android"))
        val need = batteryGuideUi(false, "app.pushhub.android")
        assertTrue(need is BatteryGuideUi.NeedWhitelist)
        assertEquals("app.pushhub.android", (need as BatteryGuideUi.NeedWhitelist).packageName)
    }

    // ---- Key 打码（频道列表展示面） ----

    @Test
    fun channelKeyMaskedToLastFour() {
        assertEquals("••••_def", maskChannelKey("phc_abc_def"))
        assertEquals("••••wxyz", maskChannelKey("abcdwxyz"))
        // 短密钥全打码（不泄露全部内容）。
        assertEquals("••••", maskChannelKey("ab"))
        assertEquals("••••", maskChannelKey("abcd"))
        // 打码结果不含原始密钥前缀。
        assertFalse(maskChannelKey("phc_secret_tail").contains("secret"))
    }

    // ---- ③ 文案纪律：常量表逐条审阅 + 恐吓措辞禁令 ----

    @Test
    fun copyTableCompleteAndReadable() {
        // 常量表逐条非空（清单化审阅——每条文案集中可读）。
        val copies = allCopyConstants()
        assertTrue("常量表至少覆盖引导各面", copies.size >= 16)
        copies.forEach { (name, value) ->
            assertTrue("copy $name must be non-blank", value.isNotBlank())
        }
    }

    @Test
    fun copyTableContainsNoFearMongeringPhrases() {
        // prohibition AND-06：MUST NOT 恐吓式引导文案（如『不开启将彻底失效/
        // 手机将有风险』）——文案必须如实陈述系统行为。
        val banned = listOf(
            "彻底失效", "手机将有风险", "将丢失全部", "永久失效", "无法挽回",
            "立即崩溃", "危险", "严重后果", "马上删除",
        )
        for ((name, value) in allCopyConstants()) {
            for (phrase in banned) {
                assertFalse(
                    "copy $name contains banned phrase <$phrase>: $value",
                    value.contains(phrase),
                )
            }
        }
    }

    /** 反射收集 RomGuideCopy 全部 String 常量（审阅面 = 常量表全集）。 */
    private fun allCopyConstants(): List<Pair<String, String>> =
        RomGuideCopy::class.java.declaredFields
            .filter { f -> Modifier.isStatic(f.modifiers) && f.type == String::class.java }
            .map { f -> f.name to readConst(f) }

    private fun readConst(f: Field): String {
        f.isAccessible = true
        return f.get(null) as String
    }
}
