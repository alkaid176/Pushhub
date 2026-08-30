package app.pushhub.android.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.widget.Button
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import app.pushhub.android.R
import app.pushhub.android.adapter.buildWsUrl
import app.pushhub.android.config.ConfigError
import app.pushhub.android.config.ConfigStore
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

// ---- 表单校验纯逻辑（JVM 可测——WizardFormTest 直消） ----

/** 向导四字段快照（displayName 可选，D-72）。 */
data class WizardFields(
    val server: String,
    val name: String,
    val key: String,
    val displayName: String,
)

/** 校验错误分支（sealed——UI 按分支挂错误文案）。 */
sealed class WizardFormError {
    object ServerEmpty : WizardFormError()
    object ServerInvalidUrl : WizardFormError()
    object NameEmpty : WizardFormError()
    object KeyEmpty : WizardFormError()
}

/**
 * 服务端地址格式校验：scheme 限 http/https + host 非空（URI 解析判定——
 * buildWsUrl 对无 scheme 输入不报错但必然连不上，前置校验拦截）。
 */
fun isValidServerUrl(server: String): Boolean {
    val uri = try {
        java.net.URI(server)
    } catch (e: Exception) {
        return false
    }
    val scheme = uri.scheme?.lowercase() ?: return false
    if (scheme != "http" && scheme != "https") return false
    return !uri.host.isNullOrBlank()
}

/** 表单校验（三分支空值 + URL 格式分支；null = 全部通过）。 */
fun validateWizardForm(f: WizardFields): WizardFormError? = when {
    f.server.isBlank() -> WizardFormError.ServerEmpty
    !isValidServerUrl(f.server) -> WizardFormError.ServerInvalidUrl
    f.name.isBlank() -> WizardFormError.NameEmpty
    f.key.isBlank() -> WizardFormError.KeyEmpty
    else -> null
}

// ---- 权限路径纯逻辑（JVM 可测——一次申请状态机） ----

/** 保存流程内通知权限的下一步（一次申请纪律，SC2 锁定）。 */
enum class PermissionStep {
    /** API < 33：无运行时权限概念，直接完成保存。 */
    NOT_REQUIRED,
    /** 已授权：直接完成保存。 */
    ALREADY_GRANTED,
    /** 已申请过（标记在案）：不再弹系统弹窗，直接走结果分支完成保存。 */
    SHOW_RESULT_ONLY,
    /** 首次：弹一次系统申请（结果无论授权/拒绝均不阻断保存，Pitfall 4）。 */
    REQUEST_DIALOG,
}

/**
 * 权限一步申请决策（纯函数）：
 * API 33+ 才有 POST_NOTIFICATIONS 运行时权限；已授权或已申请过（结果标记）
 * 则跳过弹窗——拒绝绝不循环弹窗骚扰（must_haves prohibition）。
 */
fun nextPermissionStep(sdkInt: Int, granted: Boolean, requestedBefore: Boolean): PermissionStep =
    when {
        sdkInt < 33 -> PermissionStep.NOT_REQUIRED
        granted -> PermissionStep.ALREADY_GRANTED
        requestedBefore -> PermissionStep.SHOW_RESULT_ONLY
        else -> PermissionStep.REQUEST_DIALOG
    }

/** 一次性 WS 试连的静态结果文案（T-06-04-02：不含动态拼接的 URL/Key——构造处零插值）。 */
object ConnectTestText {
    const val WAITING = "connect test: waiting"
    const val OK = "connect test ok，可以保存"
    const val FAIL_INVALID_URL = "connect test failed: invalid server url"
    const val FAIL_TIMEOUT = "connect test failed: timeout"
    const val FAIL_HANDSHAKE_REJECTED = "connect test failed: handshake rejected"
    const val FAIL_UNREACHABLE = "connect test failed: network unreachable"
    const val SAVE_LIMIT_REACHED = "已达频道上限（8 个）"
    const val SAVE_DUPLICATE = "已存在同名频道"
    const val NEED_VERIFY = "请先测试连接"
}

/**
 * 首启向导 / 添加频道表单（06-04 Task 2，D-82/D-73 同一表单两种心智）。
 *
 * 流程（对齐桌面 wizard.ts 三段）：表单校验（空值/URL 分支即时提示 + 按钮态）→
 * 「测试连接」一次性 OkHttp WS 试连（buildWsUrl + 10s 短超时；服务端 accept 即推
 * history——收到任意首帧即成功，成功即断开，独立于主服务连接）→ 成功后
 * 「保存并进入」激活 → 保存：ConfigStore 落盘 → 通知权限一步申请（拒绝不阻断，
 * Pitfall 4；结果落标记绝不重复弹，SC2 锁定）→ 前台启动 FGS（Pitfall 3）→ 完成。
 *
 * 安全（T-06-04-02）：连接失败文案全部静态常量（[ConnectTestText]——构造处
 * 零插值，不内嵌 URL/Key 子串）；表单不向任何存储写密钥（配置只经 ConfigStore）。
 */
class WizardActivity : AppCompatActivity() {

    private lateinit var serverInput: TextInputEditText
    private lateinit var nameInput: TextInputEditText
    private lateinit var keyInput: TextInputEditText
    private lateinit var displayInput: TextInputEditText
    private lateinit var serverLayout: TextInputLayout
    private lateinit var nameLayout: TextInputLayout
    private lateinit var keyLayout: TextInputLayout
    private lateinit var btnTest: Button
    private lateinit var btnSave: Button
    private lateinit var statusText: TextView

    private var initialMode = true
    private var verified = false
    private var testing = false

    private val configStore: ConfigStore get() = ConfigStore(filesDir)

    /** 一次申请纪律的程序化断言口（WizardFormTest 消费——系统弹窗请求计数）。 */
    var permissionLaunchCount: Int = 0
        private set

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            onPermissionResult(granted)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        initialMode = intent?.getStringExtra(EXTRA_MODE) != MODE_ADD
        setContentView(R.layout.activity_wizard)
        bindViews()
        setupCopy()
        prefillServer()
        attachValidationWatchers()
        renderFormState()
        // RomGuide 引导区注入（Task 3——电池白名单/ROM 专属/P11 清单内嵌向导）。
        renderRomGuide(findViewById(R.id.rom_guide_container))
    }

    private fun bindViews() {
        serverInput = findViewById(R.id.server_input)
        nameInput = findViewById(R.id.name_input)
        keyInput = findViewById(R.id.key_input)
        displayInput = findViewById(R.id.display_input)
        serverLayout = findViewById(R.id.server_layout)
        nameLayout = findViewById(R.id.name_layout)
        keyLayout = findViewById(R.id.key_layout)
        btnTest = findViewById(R.id.btn_test)
        btnSave = findViewById(R.id.btn_save)
        statusText = findViewById(R.id.status_text)
        btnTest.setOnClickListener { onTestClicked() }
        btnSave.setOnClickListener { onSaveClicked() }
    }

    private fun setupCopy() {
        val title = findViewById<TextView>(R.id.wizard_title)
        val subtitle = findViewById<TextView>(R.id.wizard_subtitle)
        if (initialMode) {
            title.text = "欢迎使用 PushHub"
            subtitle.text = "填服务端地址、频道名与 Channel Key 三项即接入"
        } else {
            title.text = "添加频道"
            subtitle.text = "与服务端同一表单——填频道名与 Channel Key（服务端地址沿用或修改）"
            btnSave.text = "保存"
        }
    }

    /** 服务端地址预填：已有配置沿用，否则生产入口缺省（D-85 唯一可达入口）。 */
    private fun prefillServer() {
        val existing = configStore.load().server
        serverInput.setText(if (existing.isBlank()) DEFAULT_SERVER else existing)
    }

    /** 地址/密钥任一变更即作废已验证状态（对齐桌面 wizard.ts——验证结果只对被验证的输入有效）。 */
    private fun attachValidationWatchers() {
        val voidsVerified = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: Editable?) {
                verified = false
                renderFormState()
            }
        }
        serverInput.addTextChangedListener(voidsVerified)
        keyInput.addTextChangedListener(voidsVerified)
        // 频道名/展示名不影响连通性——变更不作废验证（桌面同款）。
        nameInput.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: Editable?) {
                renderFormState()
            }
        })
    }

    private fun currentFields(): WizardFields = WizardFields(
        server = serverInput.text?.toString()?.trim().orEmpty(),
        name = nameInput.text?.toString()?.trim().orEmpty(),
        key = keyInput.text?.toString()?.trim().orEmpty(),
        displayName = displayInput.text?.toString()?.trim().orEmpty(),
    )

    /** 表单态渲染：字段错误提示 + 双按钮可用性（测试连接需表单合法；保存需已验证）。 */
    private fun renderFormState() {
        val fields = currentFields()
        val error = validateWizardForm(fields)
        serverLayout.error = when (error) {
            WizardFormError.ServerEmpty -> "请填服务端地址"
            WizardFormError.ServerInvalidUrl -> "地址格式无效（如 https://pushhub.dyun.org）"
            else -> null
        }
        nameLayout.error = if (error == WizardFormError.NameEmpty) "请填频道名" else null
        keyLayout.error = if (error == WizardFormError.KeyEmpty) "请填 Channel Key" else null
        btnTest.isEnabled = error == null && !testing
        btnSave.isEnabled = error == null && verified
    }

    // ---- 测试连接（一次性 WS 试连——独立于主服务） ----

    private fun onTestClicked() {
        val fields = currentFields()
        if (validateWizardForm(fields) != null) return
        testing = true
        verified = false
        statusText.text = ConnectTestText.WAITING
        renderFormState()
        testConnection(fields.server, fields.key) { ok, failText ->
            runOnUiThread {
                testing = false
                verified = ok
                statusText.text = if (ok) ConnectTestText.OK else failText
                renderFormState()
            }
        }
    }

    /**
     * 一次性 WS 试连：短超时 10s，收到任意首帧即成功（服务端 accept 即推
     * history——首帧即连接与密钥双验证通过的证据）；成功即断开。失败分类
     * 静态英文短句（[ConnectTestText]——零插值，T-06-04-02）。
     */
    private fun testConnection(serverUrl: String, channelKey: String, onDone: (Boolean, String) -> Unit) {
        val client = OkHttpClient.Builder()
            .connectTimeout(CONNECT_TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .readTimeout(CONNECT_TEST_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            .build()
        val request = try {
            Request.Builder().url(buildWsUrl(serverUrl, channelKey)).build()
        } catch (e: IllegalArgumentException) {
            onDone(false, ConnectTestText.FAIL_INVALID_URL)
            return
        }
        client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                // 任意首帧即成功（含 history/error 帧——握手与鉴权已通过）。
                webSocket.close(1000, "test done")
                onDone(true, ConnectTestText.OK)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val fail = when {
                    t is SocketTimeoutException -> ConnectTestText.FAIL_TIMEOUT
                    response != null -> ConnectTestText.FAIL_HANDSHAKE_REJECTED
                    else -> ConnectTestText.FAIL_UNREACHABLE
                }
                onDone(false, fail)
            }
        })
    }

    // ---- 保存流程（配置落盘 → 权限一步申请 → 前台启动 FGS） ----

    private fun onSaveClicked() {
        if (!verified) {
            statusText.text = ConnectTestText.NEED_VERIFY
            return
        }
        saveAndConnect()
    }

    /**
     * 保存主体（verified 之后的生产路径——btnSave 点击与测试共用；测试直调
     * 以绕过网络依赖）。ConfigError → 静态文案（上限/重名），保存不发生。
     */
    fun saveAndConnect() {
        val fields = currentFields()
        try {
            val config = configStore.load()
            config.server = fields.server
            config.displayName = fields.displayName.ifBlank { null }
            configStore.save(config)
            configStore.addChannel(fields.name, fields.key)
        } catch (e: ConfigError.ChannelLimitReached) {
            statusText.text = ConnectTestText.SAVE_LIMIT_REACHED
            return
        } catch (e: ConfigError.DuplicateChannel) {
            statusText.text = ConnectTestText.SAVE_DUPLICATE
            return
        }
        statusText.text = ""
        runPermissionGate()
    }

    /** 权限一步申请（一次申请状态机——决策纯函数 [nextPermissionStep]）。 */
    private fun runPermissionGate() {
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        when (nextPermissionStep(Build.VERSION.SDK_INT, granted, wasPermissionRequested())) {
            PermissionStep.NOT_REQUIRED -> completeSave()
            PermissionStep.ALREADY_GRANTED -> completeSave()
            // 拒绝过不再弹系统弹窗——直接走结果分支（常驻提示横幅归 06-06 主界面）。
            PermissionStep.SHOW_RESULT_ONLY -> completeSave()
            PermissionStep.REQUEST_DIALOG -> {
                permissionLaunchCount++
                permissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    /** 系统申请结果回调：落标记（此后不再弹）+ 授权/拒绝均完成保存（Pitfall 4）。 */
    internal fun onPermissionResult(granted: Boolean) {
        markPermissionRequested()
        completeSave()
    }

    private fun completeSave() {
        restartPushHubService(this)
        if (initialMode) {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            )
        }
        finish()
    }

    // ---- 权限结果标记（SharedPreferences——一次申请纪律的持久化面） ----

    private fun wasPermissionRequested(): Boolean =
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(KEY_NOTIF_REQUESTED, false)

    private fun markPermissionRequested() {
        getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_NOTIF_REQUESTED, true)
            .apply()
    }

    companion object {
        const val EXTRA_MODE = "mode"
        const val MODE_ADD = "add"

        /** 生产入口缺省预填（DEPLOY.md 既定——workers.dev 国内 SNI/DNS 阻断）。 */
        const val DEFAULT_SERVER = "https://pushhub.dyun.org"

        const val CONNECT_TEST_TIMEOUT_SECONDS = 10L

        private const val PREFS_NAME = "wizard_prefs"
        private const val KEY_NOTIF_REQUESTED = "notif_permission_requested"
    }
}
