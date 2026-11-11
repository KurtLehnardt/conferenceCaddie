package app.conferencecaddie.ui.talks

import app.conferencecaddie.shared.Embedder
import app.conferencecaddie.shared.embed.BgeEmbedder
import app.conferencecaddie.ui.resources.Res
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.jetbrains.compose.resources.ExperimentalResourceApi

/**
 * The query embedder the app ships: bge-small-en-v1.5 (int8) and its vocabulary, packed as Compose
 * resources from the pinned, verified downloads (composeApp/build.gradle.kts). Loading reads about
 * 34 MB and builds an ONNX Runtime session, so it runs once, in the background, when the app starts.
 */
object EmbeddingModel {
    const val MODEL = "files/embedding/model_quantized.onnx"
    const val VOCAB = "files/embedding/vocab.txt"

    /** The embedder, or an exception when a file is missing or ONNX Runtime refuses the model. */
    @OptIn(ExperimentalResourceApi::class)
    suspend fun load(): Embedder = withContext(Dispatchers.Default) {
        val vocab = Res.readBytes(VOCAB).decodeToString()
        val model = Res.readBytes(MODEL)
        BgeEmbedder.create(model, vocab)
    }
}
