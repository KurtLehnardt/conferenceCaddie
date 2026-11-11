package app.conferencecaddie.shared.search

import platform.Foundation.NSString
import platform.Foundation.decomposedStringWithCanonicalMapping

@Suppress("CAST_NEVER_SUCCEEDS")
internal actual fun nfd(text: String): String = (text as NSString).decomposedStringWithCanonicalMapping
