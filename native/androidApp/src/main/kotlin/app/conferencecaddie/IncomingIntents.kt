package app.conferencecaddie

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import app.conferencecaddie.ui.platform.PickedFile
import java.io.ByteArrayOutputStream
import java.io.InputStream

/**
 * What MainActivity takes from the intents other apps send it, everything in them untrusted: a
 * `caddie://` link, or a schedule file opened in or shared to the app ("Open with", "Share").
 *
 * Only `content:` addresses are read, never `file:`: a `file:` address could name the app's own
 * private files, which the app must never read for another app. An intent replayed from the recents
 * list ([Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY]) is not handed over again, and an intent whose
 * extras cannot be read (a hostile parcel) is ignored.
 */
internal object IncomingIntents {
    /** Calls [onLink] or [onFile] for what [intent] carries, at most one of them. */
    fun handOff(intent: Intent?, onLink: (String) -> Unit, onFile: (Uri, String?) -> Unit) {
        intent ?: return
        try {
            if (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
            val data = intent.data
            when (intent.action) {
                Intent.ACTION_VIEW -> when (data?.scheme?.lowercase()) {
                    "caddie" -> onLink(data.toString())
                    "content" -> onFile(data, intent.type)
                }
                Intent.ACTION_SEND -> {
                    val stream = if (Build.VERSION.SDK_INT >= 33) {
                        intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                    } else {
                        @Suppress("DEPRECATION")
                        intent.getParcelableExtra(Intent.EXTRA_STREAM)
                    }
                    if (stream?.scheme?.lowercase() == "content") onFile(stream, intent.type)
                }
            }
        } catch (_: RuntimeException) {
            // BadParcelableException and the like, from extras another app crafted.
        }
    }

    /**
     * Reads [uri] with the name and type its provider gives: at most [PickedFile.MAX_FILE_BYTES]
     * bytes, plus one to tell a larger file. Blocking; call it off the main thread. A file that
     * cannot be read arrives with null bytes.
     */
    fun read(resolver: ContentResolver, uri: Uri, typeHint: String?): PickedFile {
        val name = runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) else null
            }
        }.getOrNull() ?: uri.lastPathSegment.orEmpty()
        val mime = runCatching { resolver.getType(uri) }.getOrNull() ?: typeHint.orEmpty()
        return try {
            resolver.openInputStream(uri)?.use { readBounded(it, name, mime) } ?: PickedFile(name.take(255), mime.take(127), null)
        } catch (_: Exception) {
            PickedFile(name.take(255), mime.take(127), null)
        }
    }

    /** Reads [input] up to [limit] bytes and one more; a longer stream is too large, and the rest is never read. */
    fun readBounded(input: InputStream, name: String, mime: String, limit: Int = PickedFile.MAX_FILE_BYTES): PickedFile {
        val buffer = ByteArrayOutputStream()
        val chunk = ByteArray(64 * 1024)
        var total = 0
        while (total <= limit) {
            val n = input.read(chunk, 0, minOf(chunk.size, limit + 1 - total))
            if (n < 0) break
            buffer.write(chunk, 0, n)
            total += n
        }
        return if (total > limit) {
            PickedFile(name.take(255), mime.take(127), null, tooLarge = true)
        } else {
            PickedFile(name.take(255), mime.take(127), buffer.toByteArray())
        }
    }
}
