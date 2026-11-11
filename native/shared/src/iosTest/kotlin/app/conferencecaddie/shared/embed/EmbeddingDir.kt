package app.conferencecaddie.shared.embed

import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.toKString
import platform.posix.getenv

// simctl hands the test process every SIMCTL_CHILD_ variable of the Gradle task without the prefix.
@OptIn(ExperimentalForeignApi::class)
internal actual fun embeddingDir(): String? = getenv("CADDIE_EMBEDDING_DIR")?.toKString()
