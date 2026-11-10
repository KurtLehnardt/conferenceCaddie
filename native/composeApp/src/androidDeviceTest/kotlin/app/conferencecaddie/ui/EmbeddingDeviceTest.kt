package app.conferencecaddie.ui

import android.os.Build
import android.util.Log
import app.conferencecaddie.shared.embed.OnnxRuntimeTelemetry
import app.conferencecaddie.ui.talks.EmbeddingModel
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Base64
import kotlin.math.sqrt
import kotlin.test.Test
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * The shipped query embedder on an Android device or emulator, loaded the way the app loads it (from
 * the APK's Compose resources): the 72 queries of shared/fixtures/query-embeddings.v1.json against
 * their fp32 vectors from transformers.js, with the mean cosine (at least 0.99) and the latency of one
 * query after a warm-up, which it logs under the tag CaddieEmbedding.
 */
class EmbeddingDeviceTest {
    @Test
    fun theShippedModelMatchesTheReferenceVectors() = runBlocking {
        // The app does this in CaddieApplication.onCreate; the test process has no such application.
        OnnxRuntimeTelemetry.disableForProcess()
        val loadStart = System.nanoTime()
        val embedder = EmbeddingModel.load()
        val loadMs = (System.nanoTime() - loadStart) / 1e6
        val json = String(Base64.getDecoder().decode(QueryFixtureData.chunks.joinToString("")))
        val queries = Json.parseToJsonElement(json).jsonObject.getValue("queries").jsonArray.map { it.jsonObject }
        embedder.embed(listOf("Represent this sentence for searching relevant passages: warm up"))
        val cosines = ArrayList<Double>()
        val millis = ArrayList<Double>()
        for (q in queries) {
            val bytes = Base64.getDecoder().decode(q.getValue("fp32").jsonPrimitive.content)
            val floats = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
            val reference = FloatArray(floats.remaining()) { floats.get(it) }
            val start = System.nanoTime()
            val v = embedder.embed(listOf(q.getValue("input").jsonPrimitive.content)).single()
            millis += (System.nanoTime() - start) / 1e6
            var d = 0.0
            var a = 0.0
            var b = 0.0
            for (i in v.indices) {
                d += v[i].toDouble() * reference[i]
                a += v[i].toDouble() * v[i]
                b += reference[i].toDouble() * reference[i]
            }
            cosines += d / sqrt(a * b)
        }
        val sorted = millis.sorted()
        val report = "EMBEDDING-REPORT device=${Build.MODEL} abi=${Build.SUPPORTED_ABIS.firstOrNull()} queries=${queries.size} " +
            "mean_cosine=${"%.4f".format(cosines.average())} min_cosine=${"%.4f".format(cosines.min())} " +
            "median_ms=${"%.1f".format(sorted[sorted.size / 2])} p95_ms=${"%.1f".format(sorted[((sorted.size - 1) * 0.95).toInt()])} " +
            "load_ms=${"%.0f".format(loadMs)}"
        Log.i("CaddieEmbedding", report)
        println(report)
        assertTrue(cosines.average() >= 0.99, report)
        assertTrue(cosines.min() >= 0.97, report)
    }
}
