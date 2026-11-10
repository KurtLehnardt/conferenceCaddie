package app.conferencecaddie.shared.embed

import app.conferencecaddie.shared.Embedder
import kotlin.math.sqrt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Runs the ONNX encoder on one tokenised text and returns the last hidden state of its first token
 * ([CLS]). ONNX Runtime's Java API on Android and the JVM, its C API on iOS ([openEncoder]).
 */
internal interface EncoderSession {
    fun cls(ids: LongArray, mask: LongArray, types: LongArray): FloatArray

    fun close()
}

/**
 * Opens an encoder on the ONNX model in [model] that runs each operator on [threads] threads.
 * Throws when ONNX Runtime refuses the model. Every implementation switches ONNX Runtime's telemetry
 * off first ([disableOnnxRuntimeTelemetryByEnvironment]) and turns its telemetry events off once
 * the environment exists.
 */
internal expect fun openEncoder(model: ByteArray, threads: Int): EncoderSession

/**
 * ONNX Runtime 1.30 on Android and Apple platforms sends usage telemetry to Microsoft
 * (mobile.events.data.microsoft.com) and keeps a device id, unless the process environment sets
 * ORT_DISABLE_TELEMETRY before ONNX Runtime initialises (core/platform/posix/telemetry.cc). The app
 * sends nothing anywhere but its backend, so this sets it; it must run before the first ONNX
 * Runtime call. On Android the manifest also removes the AAR's telemetry initializer.
 */
internal expect fun disableOnnxRuntimeTelemetryByEnvironment()

internal const val ORT_DISABLE_TELEMETRY = "ORT_DISABLE_TELEMETRY"

/**
 * The query embedder of the talk bundle contract (docs/contracts/talk-bundle.md, Embedding
 * conventions): bge-small-en-v1.5 through ONNX Runtime, WordPiece tokens cut at 512, the hidden
 * state of [CLS] as the embedding (not mean pooling), L2-normalised.
 *
 * [embed] embeds each text exactly as given, which is how talk text is embedded; a search query
 * needs [queryText] first, which puts the model's retrieval instruction in front of it.
 *
 * One text runs at a time: ONNX Runtime's session could run several, but a phone gains nothing
 * from that and the order of results would then depend on scheduling.
 */
class BgeEmbedder internal constructor(
    private val tokenizer: WordPieceTokenizer,
    private val session: EncoderSession,
) : Embedder {
    private val mutex = Mutex()
    private var closed = false

    override val modelId: String get() = MODEL_ID

    override val dimensions: Int get() = DIMS

    override suspend fun embed(texts: List<String>): List<FloatArray> = withContext(Dispatchers.Default) {
        mutex.withLock {
            check(!closed) { "The embedder is closed." }
            texts.map { embedOne(it) }
        }
    }

    /** Releases the ONNX Runtime session. Later calls to [embed] fail. */
    suspend fun close() = mutex.withLock {
        if (!closed) {
            closed = true
            session.close()
        }
    }

    private fun embedOne(text: String): FloatArray {
        val ids = tokenizer.encode(text, MAX_TOKENS)
        val n = ids.size
        val tokens = LongArray(n) { ids[it].toLong() }
        val mask = LongArray(n) { 1L }
        val types = LongArray(n)
        val cls = session.cls(tokens, mask, types)
        require(cls.size == DIMS) { "The encoder returned ${cls.size} values, expected $DIMS." }
        return normalize(cls)
    }

    companion object {
        const val MODEL_ID = "BAAI/bge-small-en-v1.5"
        const val DIMS = 384
        const val MAX_TOKENS = 512

        /** The retrieval instruction from the model card, with its trailing space. */
        const val QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: "

        /** The intra-op threads a session uses: enough to halve a phone's latency, not all cores. */
        const val THREADS = 2

        /** The input string of a search query: the instruction, then the query as typed. */
        fun queryText(query: String): String = QUERY_INSTRUCTION + query

        /**
         * Loads the embedder from the ONNX model bytes and the text of its vocab.txt. Throws when the
         * vocabulary is malformed or ONNX Runtime refuses the model.
         */
        fun create(model: ByteArray, vocab: String, threads: Int = THREADS): BgeEmbedder {
            val tokenizer = WordPieceTokenizer.fromVocab(vocab)
            return BgeEmbedder(tokenizer, openEncoder(model, threads))
        }

        /** [v] scaled to unit length; a zero vector stays zero. */
        fun normalize(v: FloatArray): FloatArray {
            var sum = 0.0
            for (x in v) sum += x.toDouble() * x
            if (sum == 0.0) return v.copyOf()
            val scale = 1.0 / sqrt(sum)
            return FloatArray(v.size) { (v[it] * scale).toFloat() }
        }
    }
}
