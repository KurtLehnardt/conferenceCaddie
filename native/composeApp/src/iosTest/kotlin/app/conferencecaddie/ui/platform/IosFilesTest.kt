package app.conferencecaddie.ui.platform

import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.usePinned
import platform.Foundation.NSData
import platform.Foundation.NSFileManager
import platform.Foundation.NSHomeDirectory
import platform.Foundation.NSTemporaryDirectory
import platform.Foundation.NSURL
import platform.Foundation.create
import platform.Foundation.writeToFile

// Schedule files the system hands the app on iOS (the document picker's copy, "Open in"): read up
// to 5 MB, and the copy made for the app deleted once it is read, so no schedule stays on the
// device. On the iOS simulator.
@OptIn(ExperimentalForeignApi::class, BetaInteropApi::class)
class IosFilesTest {
    private val fm = NSFileManager.defaultManager
    private val made = ArrayList<String>()

    @AfterTest
    fun cleanUp() {
        made.forEach { fm.removeItemAtPath(it, null) }
    }

    private fun write(dir: String, name: String, bytes: ByteArray): NSURL {
        fm.createDirectoryAtPath(dir, withIntermediateDirectories = true, attributes = null, error = null)
        val path = "$dir/$name"
        val data = bytes.usePinned { NSData.create(bytes = it.addressOf(0), length = bytes.size.toULong()) }
        assertTrue(data.writeToFile(path, atomically = true))
        made += path
        return NSURL.fileURLWithPath(path)
    }

    private fun tmp(): String = NSTemporaryDirectory().trimEnd('/') + "/2c-files-${Random.nextLong().toULong()}"

    @Test
    fun theSystemsCopyIsReadAndDeleted() {
        val text = "Title\nKubernetes scheduling deep dive\n".encodeToByteArray()
        val url = write(tmp(), "my-schedule.csv", text)
        assertTrue(IosFiles.isAppsCopy(url))
        val file = IosFiles.load(url)
        assertContentEquals(text, file.bytes)
        assertEquals("my-schedule.csv", file.name)
        assertFalse(fm.fileExistsAtPath(url.path!!), "the copy made for the app was kept")
    }

    @Test
    fun anInboxCopyIsDeletedToo() {
        val dir = NSHomeDirectory() + "/Documents/Inbox"
        val url = write(dir, "2c-calendar-${Random.nextLong().toULong()}.ics", "BEGIN:VCALENDAR".encodeToByteArray())
        IosFiles.load(url)
        assertFalse(fm.fileExistsAtPath(url.path!!))
    }

    @Test
    fun aTooLargeFileIsNotReadAndItsCopyIsStillDeleted() {
        val url = write(tmp(), "huge.csv", ByteArray(PickedFile.MAX_FILE_BYTES + 1) { 'a'.code.toByte() })
        val file = IosFiles.load(url)
        assertTrue(file.tooLarge)
        assertNull(file.bytes)
        assertFalse(fm.fileExistsAtPath(url.path!!))
    }

    @Test
    fun aFileOutsideTheCopiesIsLeftAlone() {
        val dir = NSHomeDirectory() + "/Library/Caches/2c-keep-${Random.nextLong().toULong()}"
        val url = write(dir, "keep.csv", "Title".encodeToByteArray())
        made += dir
        val file = IosFiles.load(url)
        assertContentEquals("Title".encodeToByteArray(), file.bytes)
        assertTrue(fm.fileExistsAtPath(url.path!!), "a file the app was only pointed at was deleted")
    }
}
