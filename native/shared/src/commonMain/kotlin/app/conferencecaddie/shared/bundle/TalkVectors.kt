package app.conferencecaddie.shared.bundle

import kotlin.math.sqrt

/**
 * The int8 talk vectors of a bundle (`vectors.i8`, docs/contracts/talk-bundle.md, Vectors): one row
 * of [dims] signed bytes per talk and ambient item, in [rows] order. Similarities follow the
 * contract: cosine computed in double precision, each dot product of int8 rows an exact integer,
 * and 0 when either vector is all zeros. A float query is compared with a row by the same
 * expression, so it needs no quantisation.
 */
class TalkVectors(val rows: List<String>, private val data: ByteArray, val dims: Int = DIMS) {
    init {
        require(data.size == rows.size * dims) { "vectors.i8 must hold rows x dims bytes" }
    }

    private val index: Map<String, Int> = rows.withIndex().associate { (i, id) -> id to i }

    // sqrt(dot(row, row)), computed once.
    private val norms = DoubleArray(rows.size) { r ->
        var sum = 0L
        val base = r * dims
        for (j in 0 until dims) {
            val v = data[base + j].toLong()
            sum += v * v
        }
        sqrt(sum.toDouble())
    }

    /** The row of [talkId], or null for a talk without a vector (breaks and housekeeping). */
    fun rowOf(talkId: String): Int? = index[talkId]

    /** Cosine of [query] and row [row]. */
    fun cosine(query: FloatArray, row: Int): Double {
        require(query.size == dims) { "the query has ${query.size} dimensions, expected $dims" }
        val n = norms[row]
        if (n == 0.0) return 0.0
        var dot = 0.0
        var qq = 0.0
        val base = row * dims
        for (j in 0 until dims) {
            val q = query[j].toDouble()
            dot += q * data[base + j]
            qq += q * q
        }
        if (qq == 0.0) return 0.0
        return dot / (sqrt(qq) * n)
    }

    /** Cosine of rows [a] and [b]: an exact integer dot product over the precomputed norms. */
    fun cosine(a: Int, b: Int): Double {
        if (norms[a] == 0.0 || norms[b] == 0.0) return 0.0
        var dot = 0L
        val ba = a * dims
        val bb = b * dims
        for (j in 0 until dims) dot += data[ba + j].toLong() * data[bb + j]
        return dot / (norms[a] * norms[b])
    }

    /**
     * The mean of the given rows after scaling each to unit length, as a float vector: the centre of
     * a set of talks, to search for talks like them. Null when no row is given or all are zero.
     */
    fun centroid(rowIndexes: Collection<Int>): FloatArray? {
        val sum = DoubleArray(dims)
        var used = 0
        for (r in rowIndexes) {
            val n = norms[r]
            if (n == 0.0) continue
            val base = r * dims
            for (j in 0 until dims) sum[j] += data[base + j] / n
            used++
        }
        if (used == 0) return null
        return FloatArray(dims) { (sum[it] / used).toFloat() }
    }

    companion object {
        const val DIMS = 384
    }
}
