package app.conferencecaddie.shared.embed

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.nio.LongBuffer

// Compiled into both androidMain and jvmMain (see shared/build.gradle.kts): ONNX Runtime's Java API
// is the same in onnxruntime-android and in the JVM package.

internal actual fun openEncoder(model: ByteArray, threads: Int): EncoderSession {
    disableOnnxRuntimeTelemetryByEnvironment()
    return OrtJavaEncoder(model, threads)
}

private class OrtJavaEncoder(model: ByteArray, threads: Int) : EncoderSession {
    private val env = OrtEnvironment.getEnvironment().also { it.setTelemetry(false) }
    private val session: OrtSession = OrtSession.SessionOptions().use { options ->
        options.setIntraOpNumThreads(threads)
        options.setInterOpNumThreads(1)
        options.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
        env.createSession(model, options)
    }
    private val inputs = session.inputNames.toList()
    private val output = session.outputNames.first()

    init {
        val unknown = inputs - setOf(INPUT_IDS, ATTENTION_MASK, TOKEN_TYPE_IDS)
        if (unknown.isNotEmpty()) {
            session.close()
            throw IllegalArgumentException("The model takes inputs other than input_ids, attention_mask and token_type_ids.")
        }
    }

    override fun cls(ids: LongArray, mask: LongArray, types: LongArray): FloatArray {
        val shape = longArrayOf(1, ids.size.toLong())
        val data = mapOf(INPUT_IDS to ids, ATTENTION_MASK to mask, TOKEN_TYPE_IDS to types)
        val tensors = inputs.associateWith { OnnxTensor.createTensor(env, LongBuffer.wrap(data.getValue(it)), shape) }
        try {
            session.run(tensors, setOf(output)).use { result ->
                val tensor = result.get(output).orElseThrow() as OnnxTensor
                val dims = tensor.info.shape
                require(dims.size == 3 && dims[0] == 1L && dims[1] == ids.size.toLong()) { "The model's output has an unexpected shape." }
                val hidden = tensor.floatBuffer
                val width = dims[2].toInt()
                return FloatArray(width) { hidden.get(it) }
            }
        } finally {
            tensors.values.forEach { it.close() }
        }
    }

    override fun close() = session.close()

    private companion object {
        const val INPUT_IDS = "input_ids"
        const val ATTENTION_MASK = "attention_mask"
        const val TOKEN_TYPE_IDS = "token_type_ids"
    }
}
