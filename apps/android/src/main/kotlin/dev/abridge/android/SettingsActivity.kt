package dev.abridge.android

import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

internal val Context.devicePreferences get() = getSharedPreferences("device", Context.MODE_PRIVATE)

internal fun serverAddress(raw: String): String? {
    val url = raw.trim().toHttpUrlOrNull() ?: return null
    if (url.username.isNotEmpty() || url.password.isNotEmpty() || url.query != null || url.fragment != null) return null
    if (!url.isHttps && !(android.os.Build.TYPE != "user" && url.host in listOf("10.0.2.2", "127.0.0.1"))) return null
    return url.toString().trimEnd('/')
}

class SettingsActivity : Activity() {
    private lateinit var layout: LinearLayout
    private lateinit var status: TextView
    private lateinit var directory: Button
    private lateinit var pause: Button
    private lateinit var forget: Button
    private val preferences by lazy { devicePreferences }
    private val settingsListener = android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, _ -> refresh() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(32), dp(24), dp(24))
        }
        setContentView(ScrollView(this).apply { addView(layout) })
        label("aBridge", 32)
        status = label("", 16)
        label("连接", 20)
        val url = field("服务器地址", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        url.setText(preferences.getString("url", ""))
        val key = field("Device Key", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)
        button("绑定设备") {
            val address = serverAddress(url.text.toString())
            val secret = key.text.toString().trim()
            if (address == null) url.error = "请输入有效的 HTTPS 服务地址"
            else if (secret.isEmpty() || secret.length > 512 || secret.any { it !in '!'..'~' }) key.error = "请输入有效的 Device Key"
            else {
                preferences.edit().putString("url", address).putString("key", secret)
                    .putBoolean("paused", true).putBoolean("revoked", false).commit()
                key.text.clear()
            }
        }
        pause = button("") {
            val enabling = preferences.getBoolean("paused", true)
            preferences.edit().putBoolean("paused", !enabling).commit()
        }
        forget = button("解除本机绑定") {
            AlertDialog.Builder(this).setTitle("解除本机绑定？")
                .setMessage("此设备将停止接收 aBridge 操作。")
                .setNegativeButton("取消", null).setPositiveButton("解除") { _, _ ->
                    preferences.edit().remove("key").putBoolean("paused", true).commit()
                }.show()
        }
        label("本机能力", 20)
        button("打开无障碍设置") { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        for ((capability, title) in listOf("screen" to "屏幕截图", "input" to "触摸和文本输入", "files" to "目录读写")) {
            layout.addView(Switch(this).apply {
                text = title
                isChecked = preferences.getBoolean(capability, false)
                setOnCheckedChangeListener { _, checked -> preferences.edit().putBoolean(capability, checked).commit() }
            })
        }
        directory = button("") {
            startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), DIRECTORY_REQUEST)
        }
        button("撤销目录授权") {
            val uri = preferences.getString("tree", null)?.let(Uri::parse)
            preferences.edit().remove("tree").commit()
            if (uri != null) releaseDirectory(uri)
        }
        preferences.registerOnSharedPreferenceChangeListener(settingsListener)
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    override fun onDestroy() {
        preferences.unregisterOnSharedPreferenceChangeListener(settingsListener)
        super.onDestroy()
    }

    @Deprecated("Uses the platform document picker result")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != DIRECTORY_REQUEST || resultCode != RESULT_OK || data == null) return
        val uri = data.data ?: return
        val required = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        if (data.flags and required != required || runCatching {
                contentResolver.takePersistableUriPermission(uri, required)
            }.isFailure) {
            status.text = "该目录未提供持久读写授权"
            return
        }
        val previous = preferences.getString("tree", null)?.let(Uri::parse)
        preferences.edit().putString("tree", uri.toString()).commit()
        if (previous != null && previous != uri) releaseDirectory(previous)
    }

    private fun releaseDirectory(uri: Uri) {
        runCatching {
            contentResolver.releasePersistableUriPermission(uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
    }

    private fun refresh() {
        val bound = preferences.contains("key")
        val paused = preferences.getBoolean("paused", true)
        val revoked = preferences.getBoolean("revoked", false)
        val connection = if (DeviceService.active) preferences.getString("connection", "offline") else "disabled"
        status.text = when {
            !bound -> "尚未绑定"
            revoked -> "凭据已撤销，请重新绑定"
            connection == "disabled" -> "请在系统设置启用 aBridge 无障碍服务"
            connection != "online" -> "设备离线"
            paused -> "已连接 · 已暂停"
            else -> "已连接"
        }
        pause.isEnabled = bound && !revoked
        pause.text = if (paused) "开始接受操作" else "立即暂停"
        forget.isEnabled = bound
        directory.text = if (preferences.contains("tree")) "更换授权目录" else "选择授权目录"
    }

    private fun label(value: String, size: Int) = TextView(this).apply {
        text = value
        textSize = size.toFloat()
        setPadding(0, dp(8), 0, dp(8))
        this@SettingsActivity.layout.addView(this)
    }

    private fun field(hintText: String, type: Int) = EditText(this).apply {
        hint = hintText
        inputType = type
        importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        setSingleLine()
        this@SettingsActivity.layout.addView(this)
    }

    private fun button(title: String, action: () -> Unit) = Button(this).apply {
        text = title
        setOnClickListener { action() }
        this@SettingsActivity.layout.addView(this)
    }

    private fun dp(n: Int) = (resources.displayMetrics.density * n).toInt()

    private companion object { const val DIRECTORY_REQUEST = 1 }
}
