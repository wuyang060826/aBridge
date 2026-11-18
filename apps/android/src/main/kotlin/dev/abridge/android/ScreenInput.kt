package dev.abridge.android

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Bundle
import android.os.SystemClock
import android.util.Base64
import android.view.Display
import android.view.KeyEvent
import android.view.WindowManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.EditorInfo
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.ArrayDeque
import java.security.SecureRandom
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal class ScreenInput(private val service: AccessibilityService, private val imageLimit: Int) {
    private data class Focus(val packageName: String, val window: Int, val rotation: Int)
    private data class Target(
        val path: List<Int>, val bounds: Rect, val viewId: String?, val className: String?,
        val uniqueId: String?, val text: String,
    )
    private data class Observation(
        val id: String, val time: Long, val focus: Focus?, val revision: Long,
        val width: Int?, val height: Int?, val targets: Map<String, Target>,
    )
    private val observations = mutableMapOf<String, Observation>()
    private var revision = 0L
    private var lastCapture = -1000L
    private var nextReference = SecureRandom().nextLong().ushr(16)

    private fun observationId(): String {
        check(nextReference < (1L shl 48))
        val value = nextReference++
        val bytes = ByteArray(6) { (value shr ((5 - it) * 8)).toByte() }
        return "obs_" + Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }

    fun invalidate() { revision++; observations.clear() }
    fun closeSession(session: String) { observations.remove(session) }

    private fun rotation(): Int = service.getSystemService(WindowManager::class.java).defaultDisplay.rotation
    private fun focus(root: AccessibilityNodeInfo?) =
        root?.packageName?.toString()?.let { Focus(it, root.windowId, rotation()) }

    private suspend fun screenshot(): Bitmap {
        val spacing = 360 - (SystemClock.elapsedRealtime() - lastCapture)
        if (spacing > 0) delay(spacing)
        lastCapture = SystemClock.elapsedRealtime()
        return suspendCancellableCoroutine { continuation ->
            service.takeScreenshot(Display.DEFAULT_DISPLAY, service.mainExecutor, object : AccessibilityService.TakeScreenshotCallback {
                override fun onSuccess(result: AccessibilityService.ScreenshotResult) {
                    val handle = result.hardwareBuffer
                    try {
                        if (!continuation.isActive) return
                        val bitmap = Bitmap.wrapHardwareBuffer(handle, result.colorSpace)
                            ?.copy(Bitmap.Config.ARGB_8888, false) ?: error("Screenshot data is unavailable")
                        continuation.resume(bitmap)
                    } catch (e: Exception) {
                        if (continuation.isActive) continuation.resumeWithException(e)
                    } finally { handle.close() }
                }
                override fun onFailure(errorCode: Int) {
                    if (continuation.isActive) continuation.resumeWithException(
                        Refusal("screenshot_unavailable", "Android did not allow this screenshot (code ${errorCode})"))
                }
            })
        }
    }

    suspend fun observe(session: String, args: JSONObject, check: () -> Unit): JSONObject {
        if (args.has("pid") || args.has("window_id") || !args.optBoolean("desktop", observations.containsKey(session)))
            throw Refusal("unsupported_target", "Android observation uses desktop=true")
        check()
        val sequence = revision
        val before = focus(service.rootInActiveWindow)
        val wantsImage = args.optBoolean("screenshot", true)
        val image = if (wantsImage) screenshot() else null
        try {
            check()
            val root = service.rootInActiveWindow
            val after = focus(root)
            val confirmed = before != null && before == after && sequence == revision
            val query = args.optString("query").trim()
            val rows = JSONArray()
            val targets = mutableMapOf<String, Target>()
            if (root != null && confirmed) collect(root, query, rows, targets)
            val id = observationId()
            val pixels = image != null && confirmed
            val result = JSONObject().put("observation_id", id).put("elements", rows)
                .put("focus_status", if (confirmed) "confirmed" else "unconfirmed")
                .put("pixel_actions", pixels).put("platform", "android")
                .put("supported_actions", JSONArray(listOf("click", "drag", "scroll", "type", "key")))
                .put("supported_keys", JSONArray(listOf("back", "home", "enter", "search", "done")))
            if (image != null) {
                val data = ByteArrayOutputStream()
                if (!image.compress(Bitmap.CompressFormat.JPEG, 82, data) || data.size() > imageLimit)
                    throw Refusal("screenshot_unavailable", "Screenshot exceeds the transfer limit")
                result.put("geometry", JSONObject().put("width", image.width).put("height", image.height))
                result.put("image_base64", Base64.encodeToString(data.toByteArray(), Base64.NO_WRAP))
                    .put("mime_type", "image/jpeg")
            }
            check()
            observations[session] = Observation(id, SystemClock.elapsedRealtime(), after.takeIf { confirmed },
                revision, image?.width, image?.height, targets)
            return result
        } finally { image?.recycle() }
    }

    private fun label(node: AccessibilityNodeInfo): String =
        if (node.isPassword) "" else (node.text ?: node.contentDescription)?.toString()?.take(240).orEmpty()

    private fun collect(root: AccessibilityNodeInfo, query: String, rows: JSONArray, targets: MutableMap<String, Target>) {
        val pending = ArrayDeque<Pair<AccessibilityNodeInfo, List<Int>>>()
        pending.add(root to emptyList())
        var scanned = 0
        while (pending.isNotEmpty() && scanned++ < 1200 && rows.length() < 120) {
            val (node, path) = pending.removeFirst()
            val label = label(node)
            if (node.isVisibleToUser && (label.isNotEmpty() || node.isClickable || node.isEditable || node.isScrollable)
                && (query.isEmpty() || label.contains(query, ignoreCase = true))) {
                val bounds = Rect().also(node::getBoundsInScreen)
                val ref = "e${rows.length() + 1}"
                targets[ref] = Target(path, bounds, node.viewIdResourceName, node.className?.toString(), node.uniqueId, label)
                rows.put(JSONObject().put("element_ref", ref).put("text", label)
                    .put("role", node.className?.toString()?.substringAfterLast('.') ?: "View")
                    .put("editable", node.isEditable).put("enabled", node.isEnabled)
                    .put("clickable", node.isClickable).put("scrollable", node.isScrollable)
                    .put("bounds", JSONObject().put("x", bounds.left).put("y", bounds.top)
                        .put("width", bounds.width()).put("height", bounds.height())))
            }
            for (i in 0 until minOf(node.childCount, 200)) {
                if (pending.size >= 1200 || path.size >= 64) break
                node.getChild(i)?.let { pending.add(it to (path + i)) }
            }
        }
    }

    private fun target(root: AccessibilityNodeInfo, observation: Observation, action: JSONObject): AccessibilityNodeInfo? {
        if (!action.has("element_ref")) return null
        val stored = observation.targets[action.getString("element_ref")]
            ?: throw Refusal("invalid_action", "Element was not in this observation")
        var node = root
        for (index in stored.path) node = node.getChild(index)
            ?: throw Refusal("stale_observation", "Observe the screen again")
        val bounds = Rect().also(node::getBoundsInScreen)
        if (bounds != stored.bounds || node.viewIdResourceName != stored.viewId || node.className?.toString() != stored.className
            || node.uniqueId != stored.uniqueId || label(node) != stored.text || !node.isVisibleToUser || !node.isEnabled)
            throw Refusal("stale_observation", "The element changed. Observe the screen again")
        return node
    }

    private fun points(obs: Observation, x: Double, y: Double): Pair<Float, Float> {
        val width = obs.width ?: throw Refusal("screenshot_required", "Request a screenshot before using coordinates")
        val height = obs.height ?: throw Refusal("screenshot_required", "Request a screenshot before using coordinates")
        if (!x.isFinite() || !y.isFinite() || x < 0 || y < 0 || x >= width || y >= height)
            throw Refusal("invalid_action", "Coordinates are outside the screenshot")
        return x.toFloat() to y.toFloat()
    }

    private suspend fun gesture(start: Pair<Float, Float>, end: Pair<Float, Float>, duration: Long) {
        val path = Path().apply {
            moveTo(start.first, start.second)
            if (start != end) lineTo(end.first, end.second)
        }
        val request = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, duration)).build()
        suspendCancellableCoroutine<Unit> { continuation ->
            val accepted = service.dispatchGesture(request, object : AccessibilityService.GestureResultCallback() {
                override fun onCompleted(gestureDescription: GestureDescription) {
                    if (continuation.isActive) continuation.resume(Unit)
                }
                override fun onCancelled(gestureDescription: GestureDescription) {
                    if (continuation.isActive) continuation.resumeWithException(IllegalStateException("Gesture interrupted"))
                }
            }, null)
            if (!accepted && continuation.isActive) continuation.resumeWithException(
                Refusal("input_unavailable", "Android declined the gesture"))
        }
    }

    suspend fun act(session: String, args: JSONObject, check: () -> Unit): JSONObject {
        val observation = observations[session]?.takeIf {
            it.id == args.getString("observation_id") && SystemClock.elapsedRealtime() - it.time <= 120000
        } ?: throw Refusal("stale_observation", "Observe the screen again before acting")
        val root = service.rootInActiveWindow
        if (root == null || observation.focus == null) throw Refusal("focus_unavailable", "Observe an active Android window")
        if (observation.focus != focus(root) || observation.revision != revision)
            throw Refusal("focus_changed", "The active window changed. Observe again")
        if (observation.focus.packageName == service.packageName)
            throw Refusal("input_unavailable", "Local aBridge settings require direct user input")
        val action = args.getJSONObject("action")
        if ((action.optJSONArray("modifiers")?.length() ?: 0) != 0)
            throw Refusal("unsupported_action", "Android does not support keyboard modifiers")
        val element = target(root, observation, action)
        check()
        observations.remove(session)
        when (action.getString("type")) {
            "click" -> {
                if (action.optString("button", "left") != "left")
                    throw Refusal("unsupported_action", "Android click is a primary touch")
                if (element != null && element.isClickable) {
                    if (!element.performAction(AccessibilityNodeInfo.ACTION_CLICK))
                        throw Refusal("invalid_action", "The element did not accept a click")
                } else {
                    val point = if (element == null) points(observation, action.getDouble("x"), action.getDouble("y"))
                    else Rect().also(element::getBoundsInScreen).let { points(observation, it.exactCenterX().toDouble(), it.exactCenterY().toDouble()) }
                    gesture(point, point, 65)
                }
            }
            "drag" -> {
                val start = points(observation, action.getDouble("x"), action.getDouble("y"))
                val end = points(observation, action.getDouble("to_x"), action.getDouble("to_y"))
                gesture(start, end, if (start == end) 700 else 420)
            }
            "scroll" -> {
                val width = observation.width ?: throw Refusal("screenshot_required", "Request a screenshot before scrolling")
                val height = observation.height ?: throw Refusal("screenshot_required", "Request a screenshot before scrolling")
                val x = width / 2.0
                val y = height / 2.0
                val dx = action.optDouble("delta_x", 0.0).coerceIn(-width * .36, width * .36)
                val dy = action.getDouble("delta_y").coerceIn(-height * .36, height * .36)
                gesture(points(observation, x, y), points(observation, x - dx, y - dy), 380)
            }
            "type" -> {
                val node = element ?: root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
                    ?: throw Refusal("focus_unavailable", "Focus an editable field before typing")
                if (!node.isEditable || !node.isEnabled || node.isPassword)
                    throw Refusal("invalid_action", "This field does not accept accessible text input")
                val text = action.getString("text")
                val params = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
                if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, params))
                    throw Refusal("invalid_action", "This editor did not accept text replacement")
            }
            "key" -> key(action.getString("key"))
            else -> throw Refusal("unsupported_action", "This action is unavailable on Android")
        }

        val result = JSONObject().put("executed", true)
        if (args.optBoolean("observe_after", true)) {
            delay(args.optLong("wait_after_ms", 2000))
            try {
                result.put("observation", observe(session, JSONObject().put("desktop", true)
                    .put("screenshot", args.optBoolean("screenshot", false)), check))
            } catch (e: Refusal) {
                result.put("observation_error", JSONObject().put("code", e.code).put("message", e.message))
            }
        }
        return result
    }

    private fun key(key: String) {
        val global = when (key.lowercase()) {
            "back" -> AccessibilityService.GLOBAL_ACTION_BACK
            "home" -> AccessibilityService.GLOBAL_ACTION_HOME
            else -> null
        }
        if (global != null) {
            if (!service.performGlobalAction(global)) throw Refusal("invalid_action", "Android declined the system key")
            return
        }
        val action = when (key.lowercase()) {
            "search" -> EditorInfo.IME_ACTION_SEARCH
            "done" -> EditorInfo.IME_ACTION_DONE
            "enter", "return" -> EditorInfo.IME_ACTION_NONE
            else -> throw Refusal("unsupported_action", "This key is unavailable on Android")
        }
        val editor = service.inputMethod?.currentInputConnection
            ?: throw Refusal("input_unavailable", "No compatible editor is active")
        if (action == EditorInfo.IME_ACTION_NONE) {
            editor.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
            editor.sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER))
        } else editor.performEditorAction(action)
    }
}
