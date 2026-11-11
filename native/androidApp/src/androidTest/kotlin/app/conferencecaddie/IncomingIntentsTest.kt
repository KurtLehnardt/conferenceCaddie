package app.conferencecaddie

import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.conferencecaddie.ui.platform.PickedFile
import java.io.File
import java.io.InputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The intents other apps send MainActivity, on a device or emulator: which addresses are read, and
 * how much of a file. Run with `./gradlew :androidApp:connectedDebugAndroidTest`.
 */
@RunWith(AndroidJUnit4::class)
class IncomingIntentsTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private class Seen {
        val links = ArrayList<String>()
        val files = ArrayList<Uri>()
        fun handOff(intent: Intent?) = IncomingIntents.handOff(intent, { links += it }, { uri, _ -> files += uri })
    }

    @Test
    fun onlyContentAddressesAndTheAppsLinksAreTaken() {
        val seen = Seen()
        // The app's own private files, named by a file: address: never read.
        val own = File(context.filesDir, "../databases/caddie.db").path
        // setDataAndType, since setType alone clears the data.
        seen.handOff(Intent(Intent.ACTION_VIEW).setDataAndType(Uri.parse("file://$own"), "text/csv"))
        seen.handOff(Intent(Intent.ACTION_SEND).setType("text/csv").putExtra(Intent.EXTRA_STREAM, Uri.parse("file://$own")))
        seen.handOff(Intent(Intent.ACTION_VIEW, Uri.parse("https://evil.example/e/x")))
        seen.handOff(Intent(Intent.ACTION_VIEW, Uri.parse("javascript:alert(1)")))
        seen.handOff(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "Title"))
        seen.handOff(null)
        assertTrue(seen.files.isEmpty())
        assertTrue(seen.links.isEmpty())

        val content = Uri.parse("content://com.example.files/schedule.ics")
        seen.handOff(Intent(Intent.ACTION_VIEW).setDataAndType(content, "text/calendar"))
        seen.handOff(Intent(Intent.ACTION_SEND).setType("text/csv").putExtra(Intent.EXTRA_STREAM, content))
        seen.handOff(Intent(Intent.ACTION_VIEW, Uri.parse("caddie://connect?url=https%3A%2F%2Fcaddie.example")))
        assertEquals(listOf(content, content), seen.files)
        assertEquals(listOf("caddie://connect?url=https%3A%2F%2Fcaddie.example"), seen.links)
    }

    @Test
    fun anIntentReplayedFromRecentsIsNotHandedOverAgain() {
        val seen = Seen()
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("caddie://e/kubecon-2026#/search")).addFlags(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY)
        seen.handOff(intent)
        assertTrue(seen.links.isEmpty())
    }

    /** An endless stream that counts what was read from it. */
    private class Endless : InputStream() {
        var served = 0L
        override fun read(): Int {
            served++
            return 'a'.code
        }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            b.fill('a'.code.toByte(), off, off + len)
            served += len
            return len
        }
    }

    @Test
    fun aStreamIsReadNoFurtherThanTheLimitAndOneByte() {
        val endless = Endless()
        val file = IncomingIntents.readBounded(endless, "huge.csv", "text/csv")
        assertTrue(file.tooLarge)
        assertNull(file.bytes)
        assertEquals(PickedFile.MAX_FILE_BYTES + 1L, endless.served)
        // A file of exactly the limit is read whole.
        val exact = IncomingIntents.readBounded(ByteArray(PickedFile.MAX_FILE_BYTES) { 'b'.code.toByte() }.inputStream(), "max.csv", "text/csv")
        assertEquals(PickedFile.MAX_FILE_BYTES, exact.bytes?.size)
    }

    @Test
    fun anOversizedContentFileIsCutAtTheLimitAndASmallOneIsRead() {
        // A real content: address, from the device's own media store (no permission needed for the
        // app's own downloads from Android 10).
        assumeTrue(Build.VERSION.SDK_INT >= 29)
        val resolver = context.contentResolver
        fun insert(name: String, bytes: Int): Uri {
            val values = ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, name)
                put(MediaStore.Downloads.MIME_TYPE, "text/csv")
            }
            val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)!!
            resolver.openOutputStream(uri)!!.use { out ->
                val chunk = ByteArray(64 * 1024) { 'c'.code.toByte() }
                var left = bytes
                while (left > 0) {
                    val n = minOf(left, chunk.size)
                    out.write(chunk, 0, n)
                    left -= n
                }
            }
            return uri
        }
        val big = insert("2c-big-${System.nanoTime()}.csv", PickedFile.MAX_FILE_BYTES + 1024 * 1024)
        val small = insert("2c-small-${System.nanoTime()}.csv", 12)
        try {
            val tooLarge = IncomingIntents.read(resolver, big, null)
            assertTrue(tooLarge.tooLarge)
            assertNull(tooLarge.bytes)
            val read = IncomingIntents.read(resolver, small, null)
            assertArrayEquals(ByteArray(12) { 'c'.code.toByte() }, read.bytes)
            assertTrue(read.name.endsWith(".csv"))
            // The media store names the type as it knows it.
            assertTrue(read.mime, read.mime == "text/csv" || read.mime == "text/comma-separated-values")
        } finally {
            resolver.delete(big, null, null)
            resolver.delete(small, null, null)
        }
    }
}
