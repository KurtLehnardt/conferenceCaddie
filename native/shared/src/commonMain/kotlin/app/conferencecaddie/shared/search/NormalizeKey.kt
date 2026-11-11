package app.conferencecaddie.shared.search

/**
 * The value-matching normaliser, the same rules as `normalizeKey` in server/facets.mjs and
 * contracts/js/bundle.mjs: Unicode NFD, combining marks removed, lower case, every run of
 * characters that are neither letters nor numbers turned into one space, then trimmed. The bundle's
 * facet keys were built with it, so the search text must be normalised the same way.
 *
 * Kotlin classifies UTF-16 code units, so a letter outside the Basic Multilingual Plane (rare in
 * names; emoji are not letters) becomes a space here where JavaScript would keep it.
 */
fun normalizeKey(text: String): String {
    val decomposed = nfd(text)
    val sb = StringBuilder(decomposed.length)
    var space = false
    for (c in decomposed) {
        val category = c.category
        if (category == CharCategory.NON_SPACING_MARK || category == CharCategory.ENCLOSING_MARK ||
            category == CharCategory.COMBINING_SPACING_MARK
        ) {
            continue
        }
        if (c.isLetter() || category == CharCategory.DECIMAL_DIGIT_NUMBER || category == CharCategory.LETTER_NUMBER ||
            category == CharCategory.OTHER_NUMBER
        ) {
            if (space && sb.isNotEmpty()) sb.append(' ')
            space = false
            sb.append(c.lowercase())
        } else {
            space = true
        }
    }
    return sb.toString()
}

/** Unicode canonical decomposition (NFD). */
internal expect fun nfd(text: String): String
