package app.conferencecaddie.ui.platform

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * A file the person chose or opened in the app. [bytes] is null when the file could not be read;
 * [tooLarge] is true when it holds more than [MAX_FILE_BYTES], in which case only that many bytes
 * were read (or none), so a huge file never fills memory.
 */
class PickedFile(val name: String, val mime: String, val bytes: ByteArray?, val tooLarge: Boolean = false) {
    companion object {
        /** The largest schedule file the import reads: 5 MB, as the web and the server. */
        const val MAX_FILE_BYTES = 5 * 1024 * 1024
    }
}

/**
 * What the screens need from the platform that Compose does not offer: the system's file picker
 * (Android's Storage Access Framework, iOS's document picker) and its share sheet. The hosts
 * implement it (MainActivity, MainViewController); UI tests pass their own.
 */
interface PlatformActions {
    /** Opens the file picker for a schedule file and calls [onPicked] with it, or with null when the person cancels. */
    fun pickScheduleFile(onPicked: (PickedFile?) -> Unit)

    /** Opens the share sheet with [text]; [subject] is the subject line apps such as e-mail use. */
    fun shareText(text: String, subject: String)

    /** No picker and no share sheet, for tests and previews. */
    object None : PlatformActions {
        override fun pickScheduleFile(onPicked: (PickedFile?) -> Unit) = onPicked(null)
        override fun shareText(text: String, subject: String) = Unit
    }
}

/** A link or file handed to the app by the platform, numbered so the app handles each one once. */
sealed interface Incoming {
    val id: Long

    /** A `caddie://` link: from a QR code, another app, or a tap in the browser. */
    class Link(override val id: Long, val url: String) : Incoming

    /**
     * A schedule file shared to the app or opened in it ("Open in", "Share to"), which waits for the
     * person's tap; or, when [picked], one the person chose in the app's own picker, handed over again
     * because the screen that asked was recreated meanwhile, which is read at once.
     */
    class File(override val id: Long, val file: PickedFile, val picked: Boolean = false) : Incoming
}

/**
 * The platforms' hand-off of links and files to the screens. The hosts call [offerLink] and
 * [offerFile] (Android's intents, iOS's onOpenURL), which may happen before the screens exist, so
 * the latest one waits here until the app takes it with [take]. A newer one replaces one that was
 * not taken yet. The hosts call it on the main thread.
 */
object IncomingHandoff {
    private val pending = MutableStateFlow<Incoming?>(null)
    private var next = 1L

    val latest: StateFlow<Incoming?> = pending.asStateFlow()

    /** Hands over [url] if it is one of the app's own `caddie://` links of a sane length; returns whether it was taken. */
    fun offerLink(url: String?): Boolean {
        if (url == null || url.length > MAX_LINK || !url.trim().startsWith("caddie:", ignoreCase = true)) return false
        pending.value = Incoming.Link(id(), url.trim())
        return true
    }

    /** Hands over a file opened in or shared to the app, or ([picked]) one chosen in its own picker. */
    fun offerFile(file: PickedFile, picked: Boolean = false) {
        pending.value = Incoming.File(id(), file, picked)
    }

    /** Marks [item] as handled, unless a newer one has replaced it meanwhile. */
    fun take(item: Incoming) {
        pending.update { if (it?.id == item.id) null else it }
    }

    /** Drops anything waiting, for tests. */
    internal fun clear() {
        pending.value = null
    }

    private fun id(): Long = next++

    private const val MAX_LINK = 2048
}
