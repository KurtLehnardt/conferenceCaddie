package app.conferencecaddie.shared.embed

import app.conferencecaddie.shared.search.nfd

/**
 * The BERT WordPiece tokenizer of bge-small-en-v1.5, written to give the ids that transformers.js
 * gives (@huggingface/transformers 4.3.2 with its tokenizers 0.2.0, the library that embeds the talks
 * in scripts/lib/embedder.mjs), because a query vector is only comparable with the talk vectors when
 * both texts were cut into the same tokens. tokenizer.json configures it as follows, and each step is
 * done as transformers.js does it:
 *
 * - The special tokens ([PAD], [UNK], [CLS], [SEP], [MASK], the added tokens of tokenizer.json, which
 *   are not normalised) are found in the raw text first: "[SEP]" typed by a person is the token
 *   [SEP]. The text between them goes through the rest separately.
 * - BertNormalizer, clean text: U+0000, U+FFFD and every character of category Cc, Cf, Co or Cs is
 *   dropped, except tab, line feed and carriage return; every whitespace character (JavaScript's \s)
 *   becomes a space.
 * - BertNormalizer, Chinese characters: a space before and after every CJK ideograph. transformers.js
 *   tests each UTF-16 unit, not each code point, so only the ranges in the Basic Multilingual Plane
 *   count; an ideograph of Extension B or later is not padded, unlike in the Rust and Python
 *   tokenizers.
 * - BertNormalizer, lower case (JavaScript's toLowerCase, which [String.lowercase] matches: 'İ'
 *   becomes 'i' and a combining dot above, a final 'Σ' becomes 'ς'), then accents stripped:
 *   Unicode NFD, then every non-spacing mark (Mn) dropped.
 * - BertPreTokenizer: words are split at whitespace, and every punctuation character (category P,
 *   and all ASCII symbols, such as $ + < = > ^ ` | ~) is a word of its own.
 * - WordPiece: each word is cut greedily into the longest vocabulary entry that starts it, then the
 *   longest "##" entry that continues it. A word that cannot be cut completely, or that is longer
 *   than 100 code points, becomes one [UNK].
 * - [CLS] in front, [SEP] at the end, and then the whole sequence is cut after [encode]'s
 *   maxTokens ids. That is how the feature-extraction pipeline truncates: a text longer than the
 *   limit ends on a word piece and has no [SEP] (the Python tokenizer would keep [SEP]).
 *
 * Character classes come from the platform (Kotlin's [CharCategory], [String.lowercase] and [nfd]),
 * while transformers.js uses V8's Unicode 17 tables; a character assigned in a later Unicode version
 * than the platform knows may therefore be classed differently. Kotlin classifies only UTF-16 units,
 * so for code points outside the Basic Multilingual Plane the classes that matter are listed here:
 * the format (Cf) and private-use (Co) characters, which clean text drops (the tag characters of
 * subdivision flags are among them), and the variation selectors supplement, the only non-spacing
 * marks in those planes that ordinary text carries. Other supplementary marks and supplementary
 * punctuation (historic scripts) stay inside their word, where transformers.js would drop the mark or
 * split the word.
 */
class WordPieceTokenizer private constructor(
    private val vocab: HashMap<String, Int>,
    private val tokens: Array<String>,
) {
    private val cls = vocab.getValue(CLS)
    private val sep = vocab.getValue(SEP)
    private val unk = vocab.getValue(UNK)

    // A piece longer than the longest entry cannot be in the vocabulary, so the greedy search starts
    // there instead of at the end of the word.
    private val longestEntry = vocab.keys.maxOf { it.length }

    private val specials = SPECIAL_TOKENS.filter { it in vocab }

    /**
     * The ids of [text] for the model: [CLS], the word pieces, [SEP], cut after [maxTokens] ids as
     * transformers.js cuts them (see the class description).
     */
    fun encode(text: String, maxTokens: Int = 512): IntArray {
        require(maxTokens > 0) { "maxTokens must be positive, was $maxTokens." }
        val out = Ids(minOf(maxTokens, text.length / 3 + 8), maxTokens)
        out.add(cls)
        pieces(text, out)
        out.add(sep)
        return out.toIntArray()
    }

    /** The word pieces of [text], without [CLS] and [SEP] and not cut. */
    fun tokenize(text: String): List<String> {
        val out = Ids(text.length / 3 + 8, Int.MAX_VALUE)
        pieces(text, out)
        return out.toIntArray().map { tokens[it] }
    }

    private fun pieces(text: String, out: Ids) {
        var start = 0
        var i = 0
        while (i < text.length && !out.full) {
            val special = if (text[i] == '[') specials.firstOrNull { text.startsWith(it, i) } else null
            if (special == null) {
                i++
                continue
            }
            if (i > start) section(text.substring(start, i), out)
            out.add(vocab.getValue(special))
            i += special.length
            start = i
        }
        if (start < text.length && !out.full) section(text.substring(start), out)
    }

    private fun section(text: String, out: Ids) {
        val normal = normalize(text)
        var wordStart = -1
        var i = 0
        while (i < normal.length && !out.full) {
            val c = normal[i]
            val width = if (c.isHighSurrogate() && i + 1 < normal.length && normal[i + 1].isLowSurrogate()) 2 else 1
            when {
                isWhitespace(c) -> {
                    if (wordStart >= 0) word(normal, wordStart, i, out)
                    wordStart = -1
                }
                width == 1 && isPunctuation(c) -> {
                    if (wordStart >= 0) word(normal, wordStart, i, out)
                    wordStart = -1
                    word(normal, i, i + 1, out)
                }
                wordStart < 0 -> wordStart = i
            }
            i += width
        }
        if (wordStart >= 0) word(normal, wordStart, normal.length, out)
    }

    // Greedy longest match first, as transformers.js's WordPiece model does it, on code point
    // boundaries.
    private fun word(text: String, start: Int, end: Int, out: Ids) {
        if (codePoints(text, start, end) > MAX_WORD_CODE_POINTS) {
            out.add(unk)
            return
        }
        val found = Ids(4, Int.MAX_VALUE)
        var pos = start
        while (pos < end) {
            var e = minOf(end, pos + longestEntry)
            var id = -1
            while (e > pos) {
                if (e < end && text[e].isLowSurrogate() && text[e - 1].isHighSurrogate()) {
                    e--
                    continue
                }
                val piece = if (pos == start) text.substring(pos, e) else "##" + text.substring(pos, e)
                val hit = vocab[piece]
                if (hit != null) {
                    id = hit
                    break
                }
                e--
            }
            if (id < 0) {
                out.add(unk)
                return
            }
            found.add(id)
            pos = e
        }
        found.addTo(out)
    }

    /** A growing list of ids that takes no more than [limit]. */
    private class Ids(capacity: Int, private val limit: Int) {
        private var data = IntArray(maxOf(capacity, 4))
        private var size = 0

        val full: Boolean get() = size >= limit

        fun add(id: Int) {
            if (size >= limit) return
            if (size == data.size) data = data.copyOf(data.size * 2)
            data[size++] = id
        }

        fun addTo(other: Ids) {
            for (i in 0 until size) other.add(data[i])
        }

        fun toIntArray(): IntArray = data.copyOf(size)
    }

    companion object {
        private const val PAD = "[PAD]"
        private const val UNK = "[UNK]"
        private const val CLS = "[CLS]"
        private const val SEP = "[SEP]"
        private const val MASK = "[MASK]"
        private val SPECIAL_TOKENS = listOf(PAD, UNK, CLS, SEP, MASK)
        private const val MAX_WORD_CODE_POINTS = 100

        /**
         * The tokenizer of a vocab.txt: one entry per line, its id the line number counted from 0,
         * line ends "\n" or "\r\n", a final line end optional. A token listed twice gets the later id,
         * as the Python tokenizer reads the file. Throws [IllegalArgumentException] when [CLS],
         * [SEP], [UNK] or [PAD] is missing.
         */
        fun fromVocab(text: String): WordPieceTokenizer {
            val lines = text.split('\n')
            val count = if (lines.last().isEmpty()) lines.size - 1 else lines.size
            val tokens = Array(count) { lines[it].removeSuffix("\r") }
            val vocab = HashMap<String, Int>(count * 2)
            tokens.forEachIndexed { id, token -> vocab[token] = id }
            for (required in listOf(CLS, SEP, UNK, PAD)) {
                require(required in vocab) { "The vocabulary has no $required token." }
            }
            return WordPieceTokenizer(vocab, tokens)
        }

        /** BertNormalizer with clean text, Chinese characters, lower case and accent stripping. */
        private fun normalize(text: String): String {
            val sb = StringBuilder(text.length + 8)
            var i = 0
            while (i < text.length) {
                val c = text[i]
                if (c.isHighSurrogate() && i + 1 < text.length && text[i + 1].isLowSurrogate()) {
                    if (!isSupplementaryControl(codePoint(c, text[i + 1]))) sb.append(c).append(text[i + 1])
                    i += 2
                    continue
                }
                when {
                    c == '\u0000' || c == '\uFFFD' -> {}
                    c == '\t' || c == '\n' || c == '\r' -> sb.append(' ')
                    isControl(c) -> {}
                    isWhitespace(c) -> sb.append(' ')
                    isChinese(c) -> sb.append(' ').append(c).append(' ')
                    else -> sb.append(c)
                }
                i++
            }
            val lower = sb.toString().lowercase()
            // Below U+00C0 nothing decomposes and nothing is a mark.
            if (lower.all { it < '\u00C0' }) return lower
            val decomposed = nfd(lower)
            val out = StringBuilder(decomposed.length)
            i = 0
            while (i < decomposed.length) {
                val c = decomposed[i]
                if (c.isHighSurrogate() && i + 1 < decomposed.length && decomposed[i + 1].isLowSurrogate()) {
                    if (codePoint(c, decomposed[i + 1]) !in VARIATION_SELECTORS_SUPPLEMENT) {
                        out.append(c).append(decomposed[i + 1])
                    }
                    i += 2
                    continue
                }
                if (c.category != CharCategory.NON_SPACING_MARK) out.append(c)
                i++
            }
            return out.toString()
        }

        private val VARIATION_SELECTORS_SUPPLEMENT = 0xE0100..0xE01EF

        private fun codePoint(high: Char, low: Char): Int = 0x10000 + ((high.code - 0xD800) shl 10) + (low.code - 0xDC00)

        private fun codePoints(text: String, start: Int, end: Int): Int {
            var n = 0
            var i = start
            while (i < end) {
                i += if (text[i].isHighSurrogate() && i + 1 < end && text[i + 1].isLowSurrogate()) 2 else 1
                n++
            }
            return n
        }

        // Cc, Cf, Co and Cs, the classes that clean text drops; a lone surrogate is Cs.
        private fun isControl(c: Char): Boolean = when (c.category) {
            CharCategory.CONTROL, CharCategory.FORMAT, CharCategory.PRIVATE_USE, CharCategory.SURROGATE -> true
            else -> false
        }

        // The format and private-use characters outside the Basic Multilingual Plane (Unicode 17).
        private fun isSupplementaryControl(cp: Int): Boolean =
            cp == 0x110BD || cp == 0x110CD || cp in 0x13430..0x1343F || cp in 0x1BCA0..0x1BCA3 ||
                cp in 0x1D173..0x1D17A || cp == 0xE0001 || cp in 0xE0020..0xE007F ||
                (cp >= 0xF0000 && (cp and 0xFFFF) <= 0xFFFD)

        // JavaScript's \s: the Zs space separators, tab, line feed, vertical tab, form feed, carriage
        // return, line and paragraph separator, and U+FEFF.
        private fun isWhitespace(c: Char): Boolean =
            c == ' ' || c in '\t'..'\r' || c == '\u00A0' || c == '\u1680' || c in '\u2000'..'\u200A' ||
                c == '\u2028' || c == '\u2029' || c == '\u202F' || c == '\u205F' || c == '\u3000' || c == '\uFEFF'

        // The ranges of transformers.js's is_chinese_char that lie in the Basic Multilingual Plane.
        private fun isChinese(c: Char): Boolean = c in '\u4E00'..'\u9FFF' || c in '\u3400'..'\u4DBF' || c in '\uF900'..'\uFAFF'

        private fun isPunctuation(c: Char): Boolean {
            if (c in '!'..'/' || c in ':'..'@' || c in '['..'`' || c in '{'..'~') return true
            return when (c.category) {
                CharCategory.CONNECTOR_PUNCTUATION, CharCategory.DASH_PUNCTUATION, CharCategory.START_PUNCTUATION,
                CharCategory.END_PUNCTUATION, CharCategory.INITIAL_QUOTE_PUNCTUATION,
                CharCategory.FINAL_QUOTE_PUNCTUATION, CharCategory.OTHER_PUNCTUATION,
                -> true
                else -> false
            }
        }
    }
}
