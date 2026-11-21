package ai.zoltbot.share

// P9: Android's side of sharing into Zoltbot. Same bridge as the iPhone's ZoltShare: drafts are
// JSON files in app storage that is never backed up, and the app opens one to pick the agent.

import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.util.Base64
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import java.io.ByteArrayOutputStream
import java.io.File
import java.time.Instant
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

class ZoltShareModule(private val context: ReactApplicationContext) :
  ReactContextBaseJavaModule(context), ActivityEventListener {

  /** A share that arrived while the app was already open. Set on the UI thread. */
  @Volatile private var pending: Intent? = null

  init {
    context.addActivityEventListener(this)
  }

  override fun getName() = "ZoltShare"

  override fun onNewIntent(intent: Intent) {
    if (isShare(intent)) synchronized(this) { pending = intent }
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {}

  private class Failure(message: String) : Exception(message)

  private fun root(): File = File(context.noBackupFilesDir, "ZoltShare").apply { mkdirs() }

  private fun draftFile(id: String): File {
    try {
      UUID.fromString(id)
    } catch (_: IllegalArgumentException) {
      throw Failure("Invalid shared draft.")
    }
    return File(root(), "draft-$id.json")
  }

  private fun write(file: File, text: String) {
    val temp = File(file.parentFile, "${file.name}.tmp")
    temp.writeText(text)
    if (!temp.renameTo(file)) throw Failure("Could not save the share.")
  }

  private fun recipients(): JSONArray {
    val file = File(root(), "recipients.json")
    return if (file.exists()) JSONArray(file.readText()) else JSONArray()
  }

  private fun draft(id: String): JSONObject {
    val draft = JSONObject(draftFile(id).readText())
    if (draft.optInt("version") != 1 || draft.optString("id") != id) throw Failure("Unsupported shared draft.")
    return draft
  }

  private fun drafts(): List<JSONObject> =
    (root().listFiles() ?: emptyArray())
      .filter { it.name.startsWith("draft-") && it.name.endsWith(".json") }
      .map { JSONObject(it.readText()) }
      .sortedBy { it.optString("createdAt") }

  private fun save(draft: JSONObject, isNew: Boolean = false) {
    val images = draft.getJSONArray("images")
    val fits = draft.getString("text").toByteArray().size <= 16_000 && images.length() <= 5 &&
      (0 until images.length()).all { images.getJSONObject(it).getString("base64").length <= 80_000 }
    if (!fits) throw Failure("This share is too large. Use up to five photos and a shorter message.")
    if (isNew && drafts().size >= 50)
      throw Failure("Your shared drafts inbox is full. Send or discard drafts in Zoltbot first.")
    write(draftFile(draft.getString("id")), draft.toString())
  }

  private fun perform(promise: Promise, body: () -> Any?) {
    try {
      promise.resolve(body())
    } catch (error: Failure) {
      promise.reject("ZOLT_SHARE", error.message, error)
    } catch (error: Exception) {
      promise.reject("ZOLT_SHARE", "Could not read the shared drafts.", error)
    }
  }

  @ReactMethod
  fun syncRecipients(values: ReadableArray, promise: Promise) = perform(promise) {
    val list = JSONArray()
    for (i in 0 until values.size()) {
      val row = values.getMap(i) ?: continue
      list.put(JSONObject().apply {
        for (key in listOf("id", "macId", "threadId", "name")) put(key, row.getString(key) ?: "")
      })
    }
    write(File(root(), "recipients.json"), list.toString())
    null
  }

  @ReactMethod
  fun listDrafts(promise: Promise) = perform(promise) {
    Arguments.createArray().apply { for (draft in drafts()) pushMap(toMap(draft)) }
  }

  @ReactMethod
  fun updateDraft(id: String, recipientId: String, message: String, promise: Promise) = perform(promise) {
    val draft = draft(id)
    val list = recipients()
    val known = (0 until list.length()).any {
      val row = list.getJSONObject(it)
      row.optString("id") == recipientId && row.optString("macId") == draft.optString("macId")
    }
    if (!known) throw Failure("Choose an available bot on the original Mac.")
    if (draft.has("sentThreadId")) throw Failure("This draft was already sent.")
    draft.put("recipientId", recipientId)
    draft.put("text", message)
    save(draft)
    null
  }

  @ReactMethod
  fun markDraftSent(id: String, threadId: String, promise: Promise) = perform(promise) {
    val draft = draft(id)
    draft.put("sentThreadId", threadId)
    save(draft)
    null
  }

  @ReactMethod
  fun removeDraft(id: String, promise: Promise) = perform(promise) {
    draftFile(id).delete()
    null
  }

  /** The iPhone suggests recent agents in its share sheet; Android has nothing to donate to. */
  @ReactMethod
  fun donate(@Suppress("UNUSED_PARAMETER") recipient: ReadableMap, promise: Promise) = promise.resolve(null)

  /**
   * Turns a share the app was opened with into a draft for the shown Mac, once. Resolves with the
   * draft's id, or null when there is none.
   */
  @ReactMethod
  fun takeIncoming(macId: String, promise: Promise) = perform(promise) {
    val activity = context.currentActivity
    val intent = synchronized(this) { pending.also { pending = null } }
      ?: activity?.intent?.takeIf { isShare(it) }
    if (intent == null) return@perform null
    // Reopened from Recents after Android ended the app: this share was already taken.
    if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) {
      intent.action = HANDLED
      return@perform null
    }
    if (macId.isEmpty()) {
      intent.action = HANDLED
      throw Failure("Pair a Mac first, then share again.")
    }
    // Taken: a later call, or a rotation, doesn't make it again.
    intent.action = HANDLED
    activity?.intent?.takeIf { isShare(it) }?.action = HANDLED
    val text = listOfNotNull(intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
      .joinToString("\n").trim()
    val uris = streams(intent)
    if (uris.size > 5) throw Failure("Share up to five photos at a time.")
    val images = JSONArray()
    for (uri in uris) images.put(JSONObject().put("base64", photo(uri)).put("mimeType", "image/jpeg"))
    if (text.isEmpty() && images.length() == 0) return@perform null
    val id = UUID.randomUUID().toString()
    save(
      JSONObject()
        .put("version", 1)
        .put("id", id)
        .put("createdAt", Instant.now().toString())
        .put("macId", macId)
        .put("recipientId", "")
        .put("text", text)
        .put("images", images),
      isNew = true,
    )
    id
  }

  private fun isShare(intent: Intent) =
    intent.action == Intent.ACTION_SEND || intent.action == Intent.ACTION_SEND_MULTIPLE

  @Suppress("DEPRECATION")
  private fun streams(intent: Intent): List<Uri> =
    if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
      (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
      else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)) ?: emptyList()
    } else {
      listOfNotNull(
        if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM),
      )
    }.filter { context.contentResolver.getType(it)?.startsWith("image/") == true }

  /** A photo shrunk to fit a draft: at most 1024 px and 60 KB of JPEG, like the iPhone's. */
  private fun photo(uri: Uri): String {
    val resolver = context.contentResolver
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 1024) sample *= 2
    val decoded = resolver.openInputStream(uri)?.use {
      BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
    } ?: throw Failure("Could not decode this photo.")
    // Camera photos store their rotation separately; apply it as the iPhone does.
    val orientation = try {
      resolver.openInputStream(uri)?.use {
        ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
      } ?: ExifInterface.ORIENTATION_NORMAL
    } catch (_: Exception) {
      ExifInterface.ORIENTATION_NORMAL
    }
    val scale = minOf(1f, 1024f / maxOf(decoded.width, decoded.height))
    val matrix = Matrix().apply {
      postScale(scale, scale)
      when (orientation) {
        ExifInterface.ORIENTATION_ROTATE_90 -> postRotate(90f)
        ExifInterface.ORIENTATION_ROTATE_180 -> postRotate(180f)
        ExifInterface.ORIENTATION_ROTATE_270 -> postRotate(270f)
        ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> postScale(-1f, 1f)
        ExifInterface.ORIENTATION_FLIP_VERTICAL -> postScale(1f, -1f)
        ExifInterface.ORIENTATION_TRANSPOSE -> { postRotate(90f); postScale(-1f, 1f) }
        ExifInterface.ORIENTATION_TRANSVERSE -> { postRotate(270f); postScale(-1f, 1f) }
      }
    }
    val image = if (matrix.isIdentity) decoded
      else Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
    for (quality in 70 downTo 10 step 10) {
      val out = ByteArrayOutputStream()
      image.compress(Bitmap.CompressFormat.JPEG, quality, out)
      if (out.size() <= 60_000) return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }
    throw Failure("This photo is too detailed to send. Try a smaller image.")
  }

  private fun toMap(draft: JSONObject): WritableMap = Arguments.createMap().apply {
    putInt("version", draft.optInt("version"))
    for (key in listOf("id", "createdAt", "macId", "recipientId", "text")) putString(key, draft.optString(key))
    if (draft.has("sentThreadId")) putString("sentThreadId", draft.getString("sentThreadId"))
    val images = draft.optJSONArray("images") ?: JSONArray()
    putArray("images", Arguments.createArray().apply {
      for (i in 0 until images.length()) {
        val image = images.getJSONObject(i)
        pushMap(Arguments.createMap().apply {
          putString("base64", image.getString("base64"))
          putString("mimeType", image.getString("mimeType"))
        })
      }
    })
  }

  private companion object {
    const val HANDLED = "ai.zoltbot.share.HANDLED"
  }
}
