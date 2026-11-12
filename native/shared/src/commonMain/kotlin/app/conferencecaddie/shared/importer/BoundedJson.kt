package app.conferencecaddie.shared.importer

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.JsonUnquotedLiteral

/**
 * JSON text read with a bound on memory, for files a person or another app hands to the import.
 *
 * `Json.parseToJsonElement` builds the whole tree: a 5 MB file of `[1,1,1,…]` holds some 2.5
 * million values, about 200 MB once built, enough to end the app on a phone. This reader checks the
 * whole text against the JSON grammar (JSON.parse's: the six literal forms, RFC 8259 numbers and
 * strings, and space, tab, line feed and carriage return between tokens) in one pass without
 * recursion, but builds at most [maxValues] values, and none nested deeper than [keepDepth]; the
 * rest is read and dropped. A text nested deeper than [maxNestingDepth] is not read as JSON at all.
 * The import's JSON walk reads at most 50,000 containers no deeper than 8 levels, plus the values
 * just under them, so for a schedule export the dropped part is never looked at.
 */
@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
internal class BoundedJson(
    private val maxValues: Int = MAX_VALUES,
    private val keepDepth: Int = KEEP_DEPTH,
    private val maxNestingDepth: Int = MAX_NESTING_DEPTH,
) {
    /** The values built for the last text read, for the tests. */
    var built = 0
        private set

    /**
     * The characters examined for the last text read, for the tests. The reader moves forward only,
     * so this stays a small multiple of the text's length whatever the machine's speed: a second
     * pass over the text shows here; per-value work outside the scanners does not.
     */
    var steps = 0
        private set

    /** The parsed value of [text], or null when it is not JSON (or nested too deeply). */
    fun parse(text: String): JsonElement? = try {
        Reader(text).read()
    } catch (_: NotJson) {
        null
    }

    private class NotJson : Exception()

    // A container being read: what it holds so far (null when it is dropped), and for an object the
    // key of the value that comes next.
    private class Frame(val array: Boolean, val values: MutableList<JsonElement>?, val fields: LinkedHashMap<String, JsonElement>?) {
        var key: String? = null
    }

    private inner class Reader(private val s: String) {
        private var i = 0
        private val stack = ArrayList<Frame>()

        fun read(): JsonElement? {
            built = 0
            steps = 0
            var root: JsonElement? = null
            var rootSet = false
            skipSpace()
            while (true) {
                // A value, where one is expected.
                val keep = stack.size < keepDepth && built < maxValues && (stack.isEmpty() || stack.last().let { it.values != null || it.fields != null })
                val c = peek()
                var value: JsonElement? = null
                var opened = false
                when {
                    c == '{' || c == '[' -> {
                        i++
                        if (stack.size >= maxNestingDepth) throw NotJson()
                        if (keep) built++
                        val array = c == '['
                        stack += Frame(array, if (keep && array) ArrayList() else null, if (keep && !array) LinkedHashMap() else null)
                        opened = true
                    }
                    c == '"' -> {
                        val str = string(keep)
                        if (keep) {
                            built++
                            value = JsonPrimitive(str!!)
                        }
                    }
                    c == 't' -> literal("true").also { if (keep) { built++; value = JsonPrimitive(true) } }
                    c == 'f' -> literal("false").also { if (keep) { built++; value = JsonPrimitive(false) } }
                    c == 'n' -> literal("null").also { if (keep) { built++; value = JsonNull } }
                    c == '-' || (c != null && c in '0'..'9') -> {
                        val raw = number()
                        if (keep) {
                            built++
                            // The number as written, as kotlinx's own reader keeps it: no conversion here.
                            value = JsonUnquotedLiteral(raw)
                        }
                    }
                    else -> throw NotJson()
                }
                if (opened) {
                    skipSpace()
                    val top = stack.last()
                    if (peek() == (if (top.array) ']' else '}')) {
                        i++
                        val closed = close()
                        if (!place(closed)) {
                            root = closed
                            rootSet = true
                        }
                    } else {
                        if (!top.array) objectKey(top)
                        continue
                    }
                } else if (!place(value)) {
                    root = value
                    rootSet = true
                }
                // After a value: a separator, the end of containers, or the end of the text.
                while (true) {
                    skipSpace()
                    if (stack.isEmpty()) {
                        if (i != s.length || !rootSet) throw NotJson()
                        return root
                    }
                    val top = stack.last()
                    val ch = peek() ?: throw NotJson()
                    if (ch == ',') {
                        i++
                        skipSpace()
                        if (!top.array) objectKey(top)
                        break
                    }
                    if (ch == (if (top.array) ']' else '}')) {
                        i++
                        val closed = close()
                        if (!place(closed)) {
                            root = closed
                            rootSet = true
                        }
                        continue
                    }
                    throw NotJson()
                }
                skipSpace()
            }
        }

        // An object's key and its colon.
        private fun objectKey(frame: Frame) {
            if (peek() != '"') throw NotJson()
            frame.key = string(keep = frame.fields != null)
            skipSpace()
            if (peek() != ':') throw NotJson()
            i++
            skipSpace()
        }

        // The container on top of the stack, ended: its value, or null when it was dropped.
        private fun close(): JsonElement? {
            val f = stack.removeAt(stack.lastIndex)
            return when {
                f.values != null -> JsonArray(f.values)
                f.fields != null -> JsonObject(f.fields)
                else -> null
            }
        }

        // Puts [value] into the container on top; false when there is none (the value is the root).
        private fun place(value: JsonElement?): Boolean {
            val top = stack.lastOrNull() ?: return false
            if (value != null) {
                top.values?.add(value)
                // As JSON.parse: a repeated key keeps its first place and takes the last value.
                top.key?.let { k -> top.fields?.put(k, value) }
            }
            top.key = null
            return true
        }

        private fun peek(): Char? {
            steps++
            return if (i < s.length) s[i] else null
        }

        private fun skipSpace() {
            while (i < s.length) {
                steps++
                val c = s[i]
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++ else return
            }
        }

        private fun literal(word: String) {
            steps += word.length
            if (!s.startsWith(word, i)) throw NotJson()
            i += word.length
        }

        // -?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?
        private fun number(): String {
            val start = i
            if (peek() == '-') i++
            when {
                peek() == '0' -> i++
                peek()?.let { it in '1'..'9' } == true -> while (peek()?.let { it in '0'..'9' } == true) i++
                else -> throw NotJson()
            }
            if (peek() == '.') {
                i++
                if (peek()?.let { it in '0'..'9' } != true) throw NotJson()
                while (peek()?.let { it in '0'..'9' } == true) i++
            }
            if (peek() == 'e' || peek() == 'E') {
                i++
                if (peek() == '+' || peek() == '-') i++
                if (peek()?.let { it in '0'..'9' } != true) throw NotJson()
                while (peek()?.let { it in '0'..'9' } == true) i++
            }
            return s.substring(start, i)
        }

        // A string from its opening quote; its value when [keep], else only checked.
        private fun string(keep: Boolean): String? {
            i++
            val sb = if (keep) StringBuilder() else null
            while (true) {
                if (i >= s.length) throw NotJson()
                steps++
                val c = s[i++]
                when {
                    c == '"' -> return sb?.toString()
                    c == '\\' -> {
                        val e = peek() ?: throw NotJson()
                        i++
                        when (e) {
                            '"' -> sb?.append('"')
                            '\\' -> sb?.append('\\')
                            '/' -> sb?.append('/')
                            'b' -> sb?.append('\b')
                            'f' -> sb?.append('\u000C')
                            'n' -> sb?.append('\n')
                            'r' -> sb?.append('\r')
                            't' -> sb?.append('\t')
                            'u' -> {
                                if (i + 4 > s.length) throw NotJson()
                                var code = 0
                                for (k in 0 until 4) {
                                    val h = s[i + k]
                                    val d = when (h) {
                                        in '0'..'9' -> h - '0'
                                        in 'a'..'f' -> h - 'a' + 10
                                        in 'A'..'F' -> h - 'A' + 10
                                        else -> throw NotJson()
                                    }
                                    code = code * 16 + d
                                }
                                i += 4
                                steps += 4
                                // Lone surrogates are kept, as JSON.parse keeps them.
                                sb?.append(code.toChar())
                            }
                            else -> throw NotJson()
                        }
                    }
                    c < ' ' -> throw NotJson()
                    else -> sb?.append(c)
                }
            }
        }
    }

    companion object {
        /** Values built at most: about 20 MB, and four times what the walk can visit. */
        const val MAX_VALUES = 200_000

        /** Containers deeper than this are read but not built; the walk stops at 8, plus the values under it. */
        const val KEEP_DEPTH = 16

        /** A text nested deeper than this is not read as JSON (JSON.parse has no such limit; no export comes close). */
        const val MAX_NESTING_DEPTH = 512
    }
}
