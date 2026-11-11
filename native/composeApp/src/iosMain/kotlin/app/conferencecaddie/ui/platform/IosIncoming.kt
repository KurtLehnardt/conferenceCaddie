package app.conferencecaddie.ui.platform

import app.conferencecaddie.ui.theme.HostController
import kotlinx.cinterop.BetaInteropApi
import kotlinx.cinterop.ObjCSignatureOverride
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.useContents
import kotlinx.cinterop.usePinned
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import platform.CoreGraphics.CGRectMake
import platform.Foundation.NSData
import platform.Foundation.NSFileManager
import platform.Foundation.NSFileSize
import platform.Foundation.NSHomeDirectory
import platform.Foundation.NSNumber
import platform.Foundation.NSTemporaryDirectory
import platform.Foundation.NSURL
import platform.Foundation.NSURLTypeIdentifierKey
import platform.Foundation.dataWithContentsOfURL
import platform.UIKit.UIActivityItemSourceProtocol
import platform.UIKit.UIActivityViewController
import platform.UIKit.UIDocumentPickerDelegateProtocol
import platform.UIKit.UIDocumentPickerViewController
import platform.UIKit.UIViewController
import platform.UIKit.popoverPresentationController
import platform.UniformTypeIdentifiers.UTType
import platform.UniformTypeIdentifiers.UTTypeCalendarEvent
import platform.UniformTypeIdentifiers.UTTypeCommaSeparatedText
import platform.UniformTypeIdentifiers.UTTypeJSON
import platform.UniformTypeIdentifiers.UTTypePlainText
import platform.UniformTypeIdentifiers.UTTypeTabSeparatedText
import platform.darwin.NSObject
import platform.posix.memcpy

/**
 * Called from Swift (ContentView.swift, `onOpenURL`) with a URL the system opened the app with: a
 * `caddie://` link, or a schedule file opened in the app ("Open in", "Copy to Conference Caddie").
 * Only `caddie:` links and file URLs are taken; everything else is ignored.
 */
fun openIncomingUrl(url: NSURL) {
    val scheme = url.scheme?.lowercase()
    when {
        scheme == "caddie" -> url.absoluteString?.let { IncomingHandoff.offerLink(it) }
        url.isFileURL() -> IosFiles.read(url) { IncomingHandoff.offerFile(it) }
    }
}

/** Reads schedule files the person chose or opened, off the main thread and bounded in size. */
internal object IosFiles {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /**
     * Reads at most [PickedFile.MAX_FILE_BYTES] of [url] and calls [deliver] on the main thread. The
     * copy the system made for the app (its Inbox, or the picker's temporary copy) is deleted
     * afterwards, so no schedule file stays on the device.
     */
    fun read(url: NSURL, deliver: (PickedFile) -> Unit) {
        scope.launch {
            val file = load(url)
            withContext(Dispatchers.Main) { deliver(file) }
        }
    }

    /** [read]'s work: the file, read and bounded, with the system's copy deleted. Blocking I/O; call it off the main thread. */
    @OptIn(ExperimentalForeignApi::class, BetaInteropApi::class)
    internal fun load(url: NSURL): PickedFile {
        val name = (url.lastPathComponent ?: "").take(255)
        val type = runCatching {
            val values = url.resourceValuesForKeys(listOf(NSURLTypeIdentifierKey), null)
            (values?.get(NSURLTypeIdentifierKey) as? String)?.let { UTType.typeWithIdentifier(it)?.preferredMIMEType }
        }.getOrNull().orEmpty().take(127)
        val scoped = url.startAccessingSecurityScopedResource()
        val file = try {
            val path = url.path
            val size = path?.let { (NSFileManager.defaultManager.attributesOfItemAtPath(it, null)?.get(NSFileSize) as? NSNumber)?.longLongValue }
            when {
                size != null && size > PickedFile.MAX_FILE_BYTES -> PickedFile(name, type, null, tooLarge = true)
                else -> {
                    val data = NSData.dataWithContentsOfURL(url)
                    when {
                        data == null -> PickedFile(name, type, null)
                        data.length.toLong() > PickedFile.MAX_FILE_BYTES -> PickedFile(name, type, null, tooLarge = true)
                        else -> PickedFile(name, type, data.toByteArray())
                    }
                }
            }
        } catch (_: Throwable) {
            PickedFile(name, type, null)
        } finally {
            if (scoped) url.stopAccessingSecurityScopedResource()
        }
        // The system's copy for the app (Documents/Inbox, or the picker's copy in the temporary
        // directory) is not kept.
        if (isAppsCopy(url)) runCatching { NSFileManager.defaultManager.removeItemAtURL(url, null) }
        return file
    }

    /** True for a file in the app's temporary directory or its Documents/Inbox, where the system puts the copies it makes. */
    internal fun isAppsCopy(url: NSURL): Boolean {
        fun resolved(u: NSURL?): String? = u?.URLByResolvingSymlinksInPath?.path?.trimEnd('/')
        val path = resolved(url) ?: return false
        val tmp = resolved(NSURL.fileURLWithPath(NSTemporaryDirectory()))
        val inbox = resolved(NSURL.fileURLWithPath(NSHomeDirectory() + "/Documents/Inbox"))
        return listOfNotNull(tmp, inbox).any { path.startsWith("$it/") }
    }

    @OptIn(ExperimentalForeignApi::class)
    private fun NSData.toByteArray(): ByteArray {
        val size = length.toInt()
        val out = ByteArray(size)
        if (size > 0) out.usePinned { memcpy(it.addressOf(0), bytes, length) }
        return out
    }
}

/**
 * The iOS side of [PlatformActions]: the document picker (UIDocumentPickerViewController, as a copy,
 * for calendar, CSV, TSV, JSON and text files) and the share sheet (UIActivityViewController), both
 * presented from the view controller that hosts the Compose UI.
 */
object IosPlatformActions : PlatformActions {
    // UIKit keeps only a weak reference to the picker's delegate.
    private var delegate: PickerDelegate? = null

    override fun pickScheduleFile(onPicked: (PickedFile?) -> Unit) {
        val host = top() ?: return onPicked(null)
        val types = listOfNotNull(
            UTTypeCommaSeparatedText,
            UTTypeTabSeparatedText,
            UTTypeJSON,
            UTTypePlainText,
            UTTypeCalendarEvent,
            UTType.typeWithFilenameExtension("ics"),
        )
        val picker = UIDocumentPickerViewController(forOpeningContentTypes = types, asCopy = true)
        val d = PickerDelegate { file ->
            delegate = null
            onPicked(file)
        }
        delegate = d
        picker.delegate = d
        picker.allowsMultipleSelection = false
        host.presentViewController(picker, animated = true, completion = null)
    }

    @OptIn(ExperimentalForeignApi::class)
    override fun shareText(text: String, subject: String) {
        val host = top() ?: return
        // The item gives Mail and similar apps the subject through the public UIActivityItemSource.
        val sheet = UIActivityViewController(activityItems = listOf(ShareItem(text, subject)), applicationActivities = null)
        // On an iPad the sheet is a popover, which needs an anchor: the middle of the screen.
        sheet.popoverPresentationController?.let { popover ->
            val view = host.view
            popover.sourceView = view
            view.bounds.useContents { popover.sourceRect = CGRectMake(origin.x + size.width / 2, origin.y + size.height / 2, 0.0, 0.0) }
        }
        host.presentViewController(sheet, animated = true, completion = null)
    }

    private fun top(): UIViewController? {
        var c = HostController.current ?: return null
        while (true) c = c.presentedViewController ?: return c
    }

    /** The shared text, with its subject for apps that take one (Mail). */
    @OptIn(BetaInteropApi::class)
    private class ShareItem(private val text: String, private val subject: String) : NSObject(), UIActivityItemSourceProtocol {
        override fun activityViewControllerPlaceholderItem(activityViewController: UIActivityViewController): Any = text

        @ObjCSignatureOverride
        override fun activityViewController(activityViewController: UIActivityViewController, itemForActivityType: String?): Any? = text

        @ObjCSignatureOverride
        override fun activityViewController(activityViewController: UIActivityViewController, subjectForActivityType: String?): String = subject
    }

    private class PickerDelegate(private val onPicked: (PickedFile?) -> Unit) : NSObject(), UIDocumentPickerDelegateProtocol {
        override fun documentPicker(controller: UIDocumentPickerViewController, didPickDocumentsAtURLs: List<*>) {
            val url = didPickDocumentsAtURLs.firstOrNull() as? NSURL ?: return onPicked(null)
            IosFiles.read(url) { onPicked(it) }
        }

        override fun documentPickerWasCancelled(controller: UIDocumentPickerViewController) = onPicked(null)
    }
}
