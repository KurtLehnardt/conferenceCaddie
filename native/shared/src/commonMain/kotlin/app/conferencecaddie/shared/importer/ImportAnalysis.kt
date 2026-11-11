package app.conferencecaddie.shared.importer

import app.conferencecaddie.shared.search.normalizeKey

/**
 * Word analysis for matching a schedule against a bundle, as the Worker's in-memory import does it
 * (worker/src/talks/analyze.js): folded words, Lucene's English stop words, and the Porter stemmer,
 * the algorithm behind SQLite FTS5's porter tokenizer and Elasticsearch's porter_stem filter.
 */
internal object ImportAnalysis {
    /** Lucene's English stop words (the 33 of EnglishAnalyzer.ENGLISH_STOP_WORDS_SET), worker/src/lib/text.js. */
    val STOPWORDS: Set<String> =
        "a an and are as at be but by for if in into is it no not of on or such that the their then there these they this to was will with".split(' ').toSet()

    /** Lowercase, accents folded, split on anything that is not a letter or a number (analyze.js `words`). */
    fun words(text: String): List<String> = normalizeKey(text).let { if (it.isEmpty()) emptyList() else it.split(' ') }

    /** The analysed terms of [text] in order: folded words, stop words removed, stemmed (analyze.js `analyzed`). */
    fun analyzed(text: String): List<String> = words(text).filter { it !in STOPWORDS }.map { PorterStemmer.stem(it) }

    /**
     * Elasticsearch's `minimum_should_match` for [n] optional clauses (worker/src/lib/text.js): an
     * integer ("2"), a percentage ("60%", "-25%") or conditional specs ("3<75%"), where up to a
     * clauses all are required and above a the spec after it applies. Between 1 and [n] when n > 0.
     */
    fun minimumShouldMatch(n: Int, spec: String): Int {
        if (n <= 0) return 0
        fun one(raw: String): Int {
            val s = raw.trim()
            if (s.endsWith('%')) {
                val pct = s.dropLast(1).toDoubleOrNull() ?: return n
                val v = kotlin.math.floor(n * kotlin.math.abs(pct) / 100).toInt()
                return if (pct < 0) n - v else v
            }
            val v = s.toIntOrNull() ?: return n
            return if (v < 0) n + v else v
        }
        var result = n
        val s = spec.trim()
        if ('<' in s) {
            for (part in s.split(' ', '\t').filter { it.isNotEmpty() }) {
                val lim = part.substringBefore('<').toIntOrNull() ?: continue
                if (n > lim) result = one(part.substringAfter('<'))
            }
        } else if (s.isNotEmpty()) {
            result = one(s)
        }
        return minOf(n, maxOf(1, result))
    }
}

/**
 * The Porter stemmer (M. F. Porter, 1980), ported from analyze.js `stem`. Only words of plain ASCII
 * letters, three or more of them, are stemmed; any other word passes unchanged. Every pattern runs on
 * a short lowercase ASCII word, so the regular expressions here mean the same on every platform.
 */
internal object PorterStemmer {
    private val STEP2 = mapOf(
        "ational" to "ate", "tional" to "tion", "enci" to "ence", "anci" to "ance", "izer" to "ize", "bli" to "ble",
        "alli" to "al", "entli" to "ent", "eli" to "e", "ousli" to "ous", "ization" to "ize", "ation" to "ate",
        "ator" to "ate", "alism" to "al", "iveness" to "ive", "fulness" to "ful", "ousness" to "ous", "aliti" to "al",
        "iviti" to "ive", "biliti" to "ble", "logi" to "log",
    )
    private val STEP3 = mapOf("icate" to "ic", "ative" to "", "alize" to "al", "iciti" to "ic", "ical" to "ic", "ful" to "", "ness" to "")
    private const val CONS = "[^aeiou]"
    private const val VOW = "[aeiouy]"
    private const val CS = "$CONS[^aeiouy]*"
    private const val VS = "$VOW[aeiou]*"
    private val MGR0 = Regex("^($CS)?$VS$CS")
    private val MEQ1 = Regex("^($CS)?$VS$CS($VS)?$")
    private val MGR1 = Regex("^($CS)?$VS$CS$VS$CS")
    private val S_V = Regex("^($CS)?$VOW")
    private val CVC = Regex("^$CS$VOW[^aeiouwxy]$")
    private val DOUBLE = Regex("([^aeiouylsz])\\1$")
    private val STEP1A_SSES = Regex("^(.+?)(ss|i)es$")
    private val STEP1A_S = Regex("^(.+?)([^s])s$")
    private val STEP1B_EED = Regex("^(.+?)eed$")
    private val STEP1B_EDING = Regex("^(.+?)(ed|ing)$")
    private val STEP1B_FIX = Regex("(at|bl|iz)$")
    private val STEP1C = Regex("^(.+?)y$")
    private val STEP2_RE = Regex("^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$")
    private val STEP3_RE = Regex("^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$")
    private val STEP4_RE = Regex("^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$")
    private val STEP4_ION = Regex("^(.+?)(s|t)(ion)$")
    private val STEP5 = Regex("^(.+?)e$")

    private fun plainAscii(word: String): Boolean = word.all { it in 'a'..'z' }

    fun stem(word: String): String {
        if (word.length < 3 || !plainAscii(word)) return word
        var w = word
        val firstY = w[0] == 'y'
        if (firstY) w = "Y" + w.substring(1)
        // Step 1a.
        val m1a = STEP1A_SSES.matchEntire(w)
        if (m1a != null) {
            w = m1a.groupValues[1] + m1a.groupValues[2]
        } else {
            STEP1A_S.matchEntire(w)?.let { w = it.groupValues[1] + it.groupValues[2] }
        }
        // Step 1b.
        val eed = STEP1B_EED.matchEntire(w)
        if (eed != null) {
            if (MGR0.containsMatchIn(eed.groupValues[1])) w = w.dropLast(1)
        } else {
            val ed = STEP1B_EDING.matchEntire(w)
            if (ed != null && S_V.containsMatchIn(ed.groupValues[1])) {
                w = ed.groupValues[1]
                when {
                    STEP1B_FIX.containsMatchIn(w) -> w += "e"
                    DOUBLE.containsMatchIn(w) -> w = w.dropLast(1)
                    CVC.containsMatchIn(w) -> w += "e"
                }
            }
        }
        // Step 1c.
        STEP1C.matchEntire(w)?.let { if (S_V.containsMatchIn(it.groupValues[1])) w = it.groupValues[1] + "i" }
        // Step 2.
        STEP2_RE.matchEntire(w)?.let { if (MGR0.containsMatchIn(it.groupValues[1])) w = it.groupValues[1] + STEP2.getValue(it.groupValues[2]) }
        // Step 3.
        STEP3_RE.matchEntire(w)?.let { if (MGR0.containsMatchIn(it.groupValues[1])) w = it.groupValues[1] + STEP3.getValue(it.groupValues[2]) }
        // Step 4.
        val m4 = STEP4_RE.matchEntire(w)
        if (m4 != null) {
            if (MGR1.containsMatchIn(m4.groupValues[1])) w = m4.groupValues[1]
        } else {
            STEP4_ION.matchEntire(w)?.let {
                val s = it.groupValues[1] + it.groupValues[2]
                if (MGR1.containsMatchIn(s)) w = s
            }
        }
        // Step 5.
        STEP5.matchEntire(w)?.let {
            val s = it.groupValues[1]
            if (MGR1.containsMatchIn(s) || (MEQ1.containsMatchIn(s) && !CVC.containsMatchIn(s))) w = s
        }
        if (w.endsWith("ll") && MGR1.containsMatchIn(w)) w = w.dropLast(1)
        if (firstY) w = "y" + w.substring(1)
        return w
    }
}
