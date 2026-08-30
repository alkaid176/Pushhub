package app.pushhub.android.ui

import android.Manifest
import android.app.Application
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import app.pushhub.android.R
import app.pushhub.android.config.ConfigStore

/**
 * 向导表单 + 权限一步申请状态机测试（06-04 Task 2，Robolectric——Activity/
 * 布局/SharedPreferences 真实资源；网络路径不进本测试——试连 UI 面以
 * saveAndConnect 直消）。
 *
 * 覆盖（计划三类）：
 *  ① 表单三字段空值禁用逻辑 + URL 格式校验分支（纯函数 + Activity 渲染两档）；
 *  ② 权限路径状态机四分支（纯函数）；
 *  ③ grant/deny 双分支均不阻塞保存（Shadows 模拟授权态；拒绝后落标记，
 *     再次进入不再弹系统弹窗——直接走结果分支完成保存）。
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33]) // POST_NOTIFICATIONS 运行时权限分支需要 API 33
class WizardFormTest {

    private fun buildWizard(): WizardActivity =
        Robolectric.buildActivity(WizardActivity::class.java).setup().get()

    // ---- ① 表单三字段空值禁用逻辑 ----

    @Test
    fun emptyNameOrKeyDisablesTestButton() {
        val a = buildWizard()
        // server 预填生产入口（D-85）；频道名/Key 空 → 测试连接禁用。
        assertEquals(WizardActivity.DEFAULT_SERVER, a.findViewById<android.widget.EditText>(R.id.server_input).text.toString())
        assertFalse(a.findViewById<android.widget.Button>(R.id.btn_test).isEnabled)
        assertFalse(a.findViewById<android.widget.Button>(R.id.btn_save).isEnabled)

        a.findViewById<android.widget.EditText>(R.id.name_input).setText("告警群")
        a.findViewById<android.widget.EditText>(R.id.key_input).setText("phc_x")
        assertTrue(a.findViewById<android.widget.Button>(R.id.btn_test).isEnabled)
        // 未验证：保存仍禁用（验证连通后激活）。
        assertFalse(a.findViewById<android.widget.Button>(R.id.btn_save).isEnabled)
    }

    @Test
    fun emptyServerShowsErrorAndDisables() {
        val a = buildWizard()
        a.findViewById<android.widget.EditText>(R.id.server_input).setText("")
        a.findViewById<android.widget.EditText>(R.id.name_input).setText("甲")
        a.findViewById<android.widget.EditText>(R.id.key_input).setText("phc_x")
        assertFalse(a.findViewById<android.widget.Button>(R.id.btn_test).isEnabled)
        assertTrue(a.findViewById<com.google.android.material.textfield.TextInputLayout>(R.id.server_layout).error != null)
    }

    // ---- ② URL 格式校验分支（纯函数 + Activity 渲染） ----

    @Test
    fun urlValidationBranches() {
        // 合法：http/https + host 非空。
        assertTrue(isValidServerUrl("https://pushhub.dyun.org"))
        assertTrue(isValidServerUrl("http://192.168.1.5:4911"))
        // 无 scheme / 非 http(s) scheme / 无 host / 纯碎片。
        assertFalse(isValidServerUrl("pushhub.dyun.org"))
        assertFalse(isValidServerUrl("ftp://pushhub.dyun.org"))
        assertFalse(isValidServerUrl("https://"))
        assertFalse(isValidServerUrl("://garbage"))
        // 表单分支：非法地址挂错误提示并禁用测试按钮。
        val a = buildWizard()
        a.findViewById<android.widget.EditText>(R.id.server_input).setText("not a url")
        a.findViewById<android.widget.EditText>(R.id.name_input).setText("甲")
        a.findViewById<android.widget.EditText>(R.id.key_input).setText("phc_x")
        assertFalse(a.findViewById<android.widget.Button>(R.id.btn_test).isEnabled)
        assertTrue(a.findViewById<com.google.android.material.textfield.TextInputLayout>(R.id.server_layout).error != null)
        // 修正为合法地址：错误清空、按钮恢复。
        a.findViewById<android.widget.EditText>(R.id.server_input).setText("https://pushhub.dyun.org")
        assertNull(a.findViewById<com.google.android.material.textfield.TextInputLayout>(R.id.server_layout).error)
        assertTrue(a.findViewById<android.widget.Button>(R.id.btn_test).isEnabled)
    }

    // ---- ③ 权限路径状态机（纯函数四分支） ----

    @Test
    fun permissionStepDecisionBranches() {
        // API < 33：无运行时权限概念。
        assertEquals(PermissionStep.NOT_REQUIRED, nextPermissionStep(31, granted = false, requestedBefore = false))
        // API 33+ 已授权：直接完成。
        assertEquals(PermissionStep.ALREADY_GRANTED, nextPermissionStep(33, granted = true, requestedBefore = false))
        // 已申请过（拒绝过）：不再弹系统弹窗，直接走结果分支。
        assertEquals(PermissionStep.SHOW_RESULT_ONLY, nextPermissionStep(33, granted = false, requestedBefore = true))
        // 首次：弹一次。
        assertEquals(PermissionStep.REQUEST_DIALOG, nextPermissionStep(33, granted = false, requestedBefore = false))
    }

    // ---- ③ 授权分支：不弹弹窗、保存直接完成（Shadows 模拟授权） ----

    @Test
    fun grantedPermissionCompletesSaveWithoutDialog() {
        val a = buildWizard()
        shadowOf(a.application as Application).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        fillForm(a, "告警群", "phc_a")
        a.saveAndConnect()
        assertEquals("已授权：系统弹窗零请求", 0, a.permissionLaunchCount)
        assertTrue("保存流程完成（finish）", a.isFinishing)
        // 配置已落盘：server + 频道 + displayName。
        val config = ConfigStore(a.filesDir).load()
        assertEquals(WizardActivity.DEFAULT_SERVER, config.server)
        assertEquals(listOf("告警群"), config.channels.map { it.name })
    }

    // ---- ③ 拒绝分支：不阻塞保存流程；落标记后再次进入不再弹 ----

    @Test
    fun deniedPermissionDoesNotBlockSaveAndMarkerPreventsRePrompt() {
        // 第一次保存：默认拒绝态（Robolectric 危险权限缺省未授权）+ 无标记 → 弹一次。
        val first = buildWizard()
        fillForm(first, "告警群", "phc_a")
        first.saveAndConnect()
        assertEquals("首次：恰一次系统弹窗请求", 1, first.permissionLaunchCount)
        assertFalse("等待系统结果——保存流程尚未完成", first.isFinishing)
        // 系统拒绝回调（生产回调体直调——Robolectric 不驱动系统弹窗 UI）：
        // 拒绝不阻断（Pitfall 4），保存照常完成。
        first.onPermissionResult(false)
        assertTrue("拒绝后保存流程仍完成", first.isFinishing)
        assertEquals(listOf("告警群"), ConfigStore(first.filesDir).load().channels.map { it.name })

        // 第二次进入向导（同一持久标记）：不再弹系统弹窗——直接走结果分支完成。
        val second = buildWizard()
        fillForm(second, "家人", "phc_b")
        second.saveAndConnect()
        assertEquals("标记在案：零弹窗请求（结果分支直达）", 0, second.permissionLaunchCount)
        assertTrue(second.isFinishing)
        assertEquals(
            listOf("告警群", "家人"),
            ConfigStore(second.filesDir).load().channels.map { it.name },
        )
    }

    // ---- 保存错误分支：上限/重名不落盘（ConfigError → 静态文案） ----

    @Test
    fun saveErrorsShownWithoutPartialSave() {
        val a = buildWizard()
        fillForm(a, "告警群", "phc_a")
        a.saveAndConnect() // 首次：进入权限分支（REQUEST_DIALOG），保存已完成
        a.onPermissionResult(false)

        val b = buildWizard()
        fillForm(b, "告警群", "phc_b") // 重名
        b.saveAndConnect()
        assertEquals(ConnectTestText.SAVE_DUPLICATE, b.findViewById<android.widget.TextView>(R.id.status_text).text.toString())
        assertFalse(b.isFinishing)
    }

    private fun fillForm(a: WizardActivity, name: String, key: String) {
        a.findViewById<android.widget.EditText>(R.id.name_input).setText(name)
        a.findViewById<android.widget.EditText>(R.id.key_input).setText(key)
    }
}
