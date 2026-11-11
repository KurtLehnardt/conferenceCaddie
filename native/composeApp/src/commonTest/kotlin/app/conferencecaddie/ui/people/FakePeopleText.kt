package app.conferencecaddie.ui.people

// Text helpers of FakePeopleServer: words, passages and the HTML-escaped evidence with <mark> as the
// only markup, as the contract describes it.

/** The lowercase letter-and-digit runs of [s]. */
internal fun tokens(s: String): List<String> {
    val out = ArrayList<String>()
    val sb = StringBuilder()
    for (ch in s) {
        if (ch.isLetterOrDigit()) {
            sb.append(ch.lowercaseChar())
        } else if (sb.isNotEmpty()) {
            out += sb.toString()
            sb.clear()
        }
    }
    if (sb.isNotEmpty()) out += sb.toString()
    return out
}

internal fun escapeHtml(s: String): String = buildString {
    for (ch in s) {
        when (ch) {
            '&' -> append("&amp;")
            '<' -> append("&lt;")
            '>' -> append("&gt;")
            '"' -> append("&quot;")
            '\'' -> append("&#39;")
            else -> append(ch)
        }
    }
}

/** [s] HTML-escaped, with every word of [words] (any case) wrapped in `<mark>`. */
internal fun markHtml(s: String, words: List<String>): String = buildString {
    var i = 0
    while (i < s.length) {
        if (s[i].isLetterOrDigit()) {
            var j = i
            while (j < s.length && s[j].isLetterOrDigit()) j++
            val run = s.substring(i, j)
            if (run.lowercase() in words) append("<mark>").append(escapeHtml(run)).append("</mark>") else append(escapeHtml(run))
            i = j
        } else {
            append(escapeHtml(s[i].toString()))
            i++
        }
    }
}

/** The sentences of [s], split after `.`, `!` or `?` followed by a space or the end. */
internal fun sentences(s: String): List<String> {
    val out = ArrayList<String>()
    var start = 0
    for (i in s.indices) {
        if (s[i] in ".!?" && (i + 1 == s.length || s[i + 1].isWhitespace())) {
            out += s.substring(start, i + 1).trim()
            start = i + 1
        }
    }
    if (start < s.length && s.substring(start).isNotBlank()) out += s.substring(start).trim()
    return out
}

internal fun firstSentence(s: String): String = sentences(s).firstOrNull() ?: ""

/** The first sentence of [s] that holds one of [words], else its first, cut to 160 characters. */
internal fun sentenceWith(s: String, words: List<String>): String =
    (sentences(s).firstOrNull { sentence -> tokens(sentence).any { it in words } } ?: firstSentence(s)).take(160)

/** "a", "a and b", "a, b, and c". */
internal fun list(items: List<String>): String = when (items.size) {
    0 -> ""
    1 -> items[0]
    2 -> "${items[0]} and ${items[1]}"
    else -> items.dropLast(1).joinToString(", ") + ", and " + items.last()
}
