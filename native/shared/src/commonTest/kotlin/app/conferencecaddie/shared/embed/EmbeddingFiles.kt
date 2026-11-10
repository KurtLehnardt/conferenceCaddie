package app.conferencecaddie.shared.embed

import kotlin.test.fail
import kotlinx.io.buffered
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.readString

/**
 * The directory that the downloadEmbeddingModel and downloadEmbeddingVocab tasks fill with the
 * pinned model_quantized.onnx and vocab.txt: the system property caddie.embeddingDir on the JVM, the
 * environment variable CADDIE_EMBEDDING_DIR on the iOS simulator (see shared/build.gradle.kts). Null
 * when the test was started some other way.
 */
internal expect fun embeddingDir(): String?

/**
 * The text of the file [name] in [embeddingDir]. Fails the test, rather than skipping it, when the
 * directory or the file is missing, so a misconfigured run cannot pass without checking anything.
 */
internal fun embeddingText(name: String): String {
    val dir = embeddingDir()
        ?: fail("The embedding directory is not set (caddie.embeddingDir on the JVM, CADDIE_EMBEDDING_DIR on iOS); run the tests through Gradle.")
    val path = Path(dir, name)
    if (!SystemFileSystem.exists(path)) fail("$path does not exist; the downloadEmbeddingVocab task puts it there.")
    return SystemFileSystem.source(path).buffered().use { it.readString() }
}
