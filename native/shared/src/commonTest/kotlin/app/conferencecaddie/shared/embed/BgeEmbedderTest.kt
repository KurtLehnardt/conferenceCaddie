package app.conferencecaddie.shared.embed

import app.conferencecaddie.shared.fixtures.Fixtures
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi
import kotlin.math.abs
import kotlin.math.sqrt
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertTrue
import kotlin.time.TimeSource
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// The query embedder with the real model (model_quantized.onnx through ONNX Runtime), on the JVM and
// on the iOS simulator; composeApp's EmbeddingDeviceTest runs the same measurement on Android.
class BgeEmbedderTest {
    private val embedder by lazy { BgeEmbedder.create(embeddingBytes("model_quantized.onnx"), embeddingText("vocab.txt")) }

    private fun cosine(a: FloatArray, b: FloatArray): Double {
        var d = 0.0
        var x = 0.0
        var y = 0.0
        for (i in a.indices) {
            d += a[i].toDouble() * b[i]
            x += a[i].toDouble() * a[i]
            y += b[i].toDouble() * b[i]
        }
        return d / sqrt(x * y)
    }

    @Test
    fun aCorruptOrTruncatedModelIsRefused() {
        val vocab = embeddingText("vocab.txt")
        val model = embeddingBytes("model_quantized.onnx")
        assertFails("a truncated model") { BgeEmbedder.create(model.copyOf(model.size / 2), vocab) }
        assertFails("bytes that are no model") { BgeEmbedder.create(ByteArray(4096) { (it * 31).toByte() }, vocab) }
        assertFails("an empty model") { BgeEmbedder.create(ByteArray(0), vocab) }
        assertFails("a vocabulary without the special tokens") { BgeEmbedder.create(model, "hello\nworld\n") }
    }

    // The core closes the embedder when memory is short and creates it again for the next text
    // search: a second session after the first was closed must give the same vectors, and a closed
    // embedder must refuse to embed rather than touch a released session.
    @Test
    fun anEmbedderCanBeClosedAndCreatedAgain() = runTest {
        val vocab = embeddingText("vocab.txt")
        val model = embeddingBytes("model_quantized.onnx")
        val query = listOf(BgeEmbedder.queryText("kubernetes autoscaling"))
        val first = BgeEmbedder.create(model, vocab)
        val before = first.embed(query).single()
        first.close()
        first.close()
        assertTrue(runCatching { first.embed(query) }.exceptionOrNull() is IllegalStateException, "a closed embedder embeds")
        repeat(2) { round ->
            val again = BgeEmbedder.create(model, vocab)
            val after = again.embed(query).single()
            again.close()
            assertTrue(cosine(before, after) > 0.9999, "round $round: ${cosine(before, after)}")
        }
    }

    private fun JsonArray.floats() = FloatArray(size) { this[it].jsonPrimitive.double.toFloat() }

    /**
     * The contract's conformance test (contracts/fixtures/embedding/reference.v1.json): every
     * query-by-talk cosine within 0.02 of the fp32 reference, and the same best talk for each query.
     */
    @Test
    fun conformsToTheContractsReferenceEmbeddings() = runTest {
        val ref = Fixtures.json("embedding/reference.v1.json").jsonObject
        val tolerance = ref.getValue("tolerance").jsonPrimitive.double
        val docs = ref.getValue("documents").jsonArray.map { it.jsonObject }
        val queries = ref.getValue("queries").jsonArray.map { it.jsonObject }
        val docVectors = embedder.embed(docs.map { it.getValue("input").jsonPrimitive.content })
        val queryVectors = embedder.embed(queries.map { it.getValue("input").jsonPrimitive.content })
        assertEquals(BgeEmbedder.queryText(queries[0].getValue("query").jsonPrimitive.content), queries[0].getValue("input").jsonPrimitive.content)
        for ((i, d) in docs.withIndex()) {
            val c = cosine(docVectors[i], d.getValue("vector").jsonArray.floats())
            assertTrue(c >= 0.99, "document ${i + 1} is $c from its fp32 reference")
        }
        val sims = ref.getValue("similarities").jsonArray
        for ((q, row) in sims.withIndex()) {
            val expected = row.jsonArray.map { it.jsonPrimitive.double }
            val actual = docVectors.map { cosine(queryVectors[q], it) }
            for (t in expected.indices) assertTrue(abs(actual[t] - expected[t]) <= tolerance, "query $q, talk $t: ${actual[t]} vs ${expected[t]}")
            assertEquals(expected.indices.maxBy { expected[it] }, actual.indices.maxBy { actual[it] }, "query $q picks another best talk")
        }
        embedder.embed(listOf("")).single().let { v ->
            assertEquals(BgeEmbedder.DIMS, v.size)
            assertTrue(abs(sqrt(v.sumOf { it.toDouble() * it }) - 1.0) < 1e-5, "vectors are unit length")
        }
    }

    /**
     * The 72 queries of shared/fixtures/query-embeddings.v1.json against their fp32 vectors from
     * transformers.js (the bundle builder's embedder): the int8 model must stay close (mean cosine at
     * least 0.99). Also measures the latency of one query, after a warm-up. The numbers are printed.
     */
    @OptIn(ExperimentalEncodingApi::class)
    @Test
    fun queryVectorsMatchTheFp32ReferenceAndReportLatency() = runTest {
        val fixture = Fixtures.json("native/query-embeddings.v1.json") as JsonObject
        val queries = fixture.getValue("queries").jsonArray.map { it.jsonObject }
        assertTrue(queries.size >= 50)
        embedder.embed(listOf(BgeEmbedder.queryText("warm up")))
        val cosines = ArrayList<Double>()
        val millis = ArrayList<Double>()
        for (q in queries) {
            val input = q.getValue("input").jsonPrimitive.content
            val bytes = Base64.decode(q.getValue("fp32").jsonPrimitive.content)
            val reference = FloatArray(bytes.size / 4) { i ->
                val bits = (bytes[i * 4].toInt() and 0xff) or ((bytes[i * 4 + 1].toInt() and 0xff) shl 8) or
                    ((bytes[i * 4 + 2].toInt() and 0xff) shl 16) or ((bytes[i * 4 + 3].toInt() and 0xff) shl 24)
                Float.fromBits(bits)
            }
            val mark = TimeSource.Monotonic.markNow()
            val v = embedder.embed(listOf(input)).single()
            millis += mark.elapsedNow().inWholeMicroseconds / 1000.0
            cosines += cosine(v, reference)
        }
        val mean = cosines.average()
        val sorted = millis.sorted()
        val median = sorted[sorted.size / 2]
        val p95 = sorted[((sorted.size - 1) * 0.95).toInt()]
        println(
            "EMBEDDING-REPORT queries=${queries.size} mean_cosine=${mean.fmt()} min_cosine=${cosines.min().fmt()} " +
                "median_ms=${median.fmt(1)} p95_ms=${p95.fmt(1)}",
        )
        assertTrue(mean >= 0.99, "mean cosine $mean is below 0.99")
        assertTrue(cosines.min() >= 0.97, "a query's cosine is ${cosines.min()}")
    }

    private fun Double.fmt(digits: Int = 4): String {
        var scale = 1.0
        repeat(digits) { scale *= 10 }
        val r = kotlin.math.round(this * scale) / scale
        return r.toString()
    }
}
