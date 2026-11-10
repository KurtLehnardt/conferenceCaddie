package app.conferencecaddie.shared.search

import app.conferencecaddie.shared.bundle.Talk

/**
 * The passage a result card shows under its tags, chosen as the server's highlighter chooses
 * (server/search.mjs, evidenceFor): the stretch of the abstract around the first word of the search
 * text, about [FRAGMENT] characters long; else the start of the abstract; else the title, so a
 * result never has empty evidence. The server's fallback to the best semantic chunk has no
 * equivalent here, because a bundle carries one vector per talk, not per passage.
 *
 * Words are found roughly as the server's english analyzer finds them: case and accents do not
 * matter, and common English endings are ignored (so "scheduler" finds "scheduling" and "GPU"
 * finds "GPUs"). This only chooses which text to show; it never changes what matches.
 */
object Evidence {
    const val FRAGMENT = 200
    const val PASSAGE = 300

    fun forTalk(talk: Talk, searchText: String): String {
        val abstract = collapse(talk.abstract)
        if (abstract.isEmpty()) return collapse(talk.title)
        val at = firstMatch(abstract, TalkSearch.terms(searchText))
        if (at == null || at < FRAGMENT / 2) return cut(abstract, 0, FRAGMENT)
        // Start at the sentence that holds the match when it is close, else a little before it.
        val sentence = sentenceStart(abstract, at)
        val start = if (at - sentence <= FRAGMENT / 2) sentence else wordStart(abstract, at - FRAGMENT / 4)
        return cut(abstract, start, FRAGMENT)
    }

    /**
     * The sentence of [talk]'s abstract that shares the most words with [text], cut to [PASSAGE]
     * characters: the passage For you shows under a suggestion, as the server's best chunk. The first
     * sentence when none shares a word; null when the abstract is empty.
     */
    fun passage(talk: Talk, text: String): String? {
        val abstract = collapse(talk.abstract)
        if (abstract.isEmpty()) return null
        val terms = TalkSearch.terms(text)
        val sentences = sentences(abstract)
        val best = sentences.maxByOrNull { s -> terms.count { firstMatch(s, listOf(it)) != null } } ?: abstract
        val chosen = if (terms.none { firstMatch(best, listOf(it)) != null }) sentences.first() else best
        return cut(chosen, 0, PASSAGE)
    }

    private val SPACE = Regex("""\s+""")
    private val SENTENCE_END = Regex("""(?<=[.!?])\s+(?=[A-Z0-9"'“(])""")

    private fun collapse(s: String) = s.replace(SPACE, " ").trim()

    private fun sentences(text: String): List<String> = text.split(SENTENCE_END).map { it.trim() }.filter { it.isNotEmpty() }

    /** The index in [text] of the earliest word that one of [terms] finds, or null. */
    internal fun firstMatch(text: String, terms: List<String>): Int? {
        if (terms.isEmpty()) return null
        val folded = normalizeKey(text)
        if (folded.isEmpty()) return null
        // Positions of each word of the folded text, mapped back to the original by word order.
        val words = folded.split(' ')
        val starts = wordStarts(text)
        if (starts.size != words.size) return null
        val stems = terms.map { stem(it) }
        for ((i, w) in words.withIndex()) {
            val ws = stem(w)
            for (t in stems) {
                if (ws == t || (t.length >= 4 && w.startsWith(t))) return starts[i]
            }
        }
        return null
    }

    private val SUFFIXES = listOf("ations", "ation", "ings", "ing", "ers", "er", "ies", "ied", "es", "ed", "s")

    // A word without one common English ending, keeping at least three letters.
    private fun stem(word: String): String {
        if (word.length < 4) return word
        for (suffix in SUFFIXES) if (word.length - suffix.length >= 3 && word.endsWith(suffix)) return word.dropLast(suffix.length)
        return word
    }

    // The start index of each word of [text] the way normalizeKey splits it: runs of letters and
    // numbers, with combining marks inside a word.
    private fun wordStarts(text: String): List<Int> {
        val starts = ArrayList<Int>()
        var inWord = false
        for ((i, c) in text.withIndex()) {
            val mark = c.category == CharCategory.NON_SPACING_MARK || c.category == CharCategory.ENCLOSING_MARK ||
                c.category == CharCategory.COMBINING_SPACING_MARK
            val wordChar = c.isLetter() || c.category == CharCategory.DECIMAL_DIGIT_NUMBER ||
                c.category == CharCategory.LETTER_NUMBER || c.category == CharCategory.OTHER_NUMBER
            if (wordChar && !inWord) starts += i
            if (!mark) inWord = wordChar
        }
        return starts
    }

    private fun sentenceStart(text: String, at: Int): Int {
        var i = at
        while (i > 0) {
            val c = text[i - 1]
            if ((c == ' ') && i >= 2 && text[i - 2] in ".!?") return i
            i--
        }
        return 0
    }

    private fun wordStart(text: String, at: Int): Int {
        var i = at.coerceIn(0, text.length)
        while (i > 0 && text[i - 1] != ' ') i--
        return i
    }

    // [max] characters of [text] from [start], cut at a word boundary when one is near, with an
    // ellipsis wherever text was left out.
    private fun cut(text: String, start: Int, max: Int): String {
        val lead = if (start > 0) "…" else ""
        val rest = text.substring(start)
        if (rest.length <= max) return lead + rest
        val piece = rest.substring(0, max)
        val space = piece.lastIndexOf(' ')
        return lead + (if (space > max * 0.6) piece.substring(0, space) else piece) + "…"
    }
}
