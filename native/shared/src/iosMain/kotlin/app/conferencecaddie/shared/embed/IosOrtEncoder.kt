package app.conferencecaddie.shared.embed

import app.conferencecaddie.shared.embed.ort.CaddieOrt
import app.conferencecaddie.shared.embed.ort.caddie_ort_close
import app.conferencecaddie.shared.embed.ort.caddie_ort_cls
import app.conferencecaddie.shared.embed.ort.caddie_ort_open
import kotlinx.cinterop.ByteVar
import kotlinx.cinterop.CPointer
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.cinterop.addressOf
import kotlinx.cinterop.allocArray
import kotlinx.cinterop.memScoped
import kotlinx.cinterop.set
import kotlinx.cinterop.toKString
import kotlinx.cinterop.usePinned

// ONNX Runtime's C API through the cinterop in src/nativeInterop/cinterop/onnxruntime.def, whose
// small C functions do the session work.

internal actual fun openEncoder(model: ByteArray, threads: Int): EncoderSession {
    requireOnnxRuntimeTelemetryDisabled()
    return IosOrtEncoder(model, threads)
}

@OptIn(ExperimentalForeignApi::class)
private class IosOrtEncoder(model: ByteArray, threads: Int) : EncoderSession {
    private var handle: CPointer<CaddieOrt>? = memScoped {
        val err = allocArray<ByteVar>(ERR_LEN)
        err[0] = 0
        // ONNX Runtime copies what it needs while it builds the session, so the pin ends here.
        model.usePinned { pinned ->
            caddie_ort_open(pinned.addressOf(0), model.size.toULong(), threads, err, ERR_LEN.toULong())
        } ?: throw IllegalStateException("ONNX Runtime could not open the model: ${err.toKString()}")
    }

    override fun cls(ids: LongArray, mask: LongArray, types: LongArray): FloatArray {
        val session = checkNotNull(handle) { "The encoder is closed." }
        val out = FloatArray(DIMS)
        memScoped {
            val err = allocArray<ByteVar>(ERR_LEN)
            err[0] = 0
            val status = ids.usePinned { i ->
                mask.usePinned { m ->
                    types.usePinned { t ->
                        out.usePinned { o ->
                            caddie_ort_cls(
                                session, i.addressOf(0), m.addressOf(0), t.addressOf(0), ids.size.toLong(),
                                o.addressOf(0), DIMS.toLong(), err, ERR_LEN.toULong(),
                            )
                        }
                    }
                }
            }
            check(status == 0) { "ONNX Runtime could not run the model: ${err.toKString()}" }
        }
        return out
    }

    override fun close() {
        handle?.let { caddie_ort_close(it) }
        handle = null
    }

    private companion object {
        const val ERR_LEN = 512
        const val DIMS = BgeEmbedder.DIMS
    }
}
