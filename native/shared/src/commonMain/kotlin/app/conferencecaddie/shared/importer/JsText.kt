package app.conferencecaddie.shared.importer

/**
 * The text primitives of the JavaScript import code (worker/src/talks/import-parse.js), written out
 * by hand rather than as regular expressions. Kotlin's `Regex` behaves differently on each platform
 * (the JVM's java.util.regex, ICU on Android and Kotlin/Native's own engine on iOS): `\s`, `\d`,
 * `\b`, `$` and the Unicode classes `\p{L}`, `\p{N}` and `\p{M}` do not mean the same thing
 * everywhere, and none of them means exactly what it means in JavaScript. These functions do, so the
 * import reads a file the same way on Android, iOS and the servers. None of them can backtrack.
 */
internal object JsText {
    /** JavaScript's `\s` and the characters `String.prototype.trim` removes: WhiteSpace and LineTerminator. */
    fun isSpace(c: Char): Boolean = when (c) {
        ' ', '\t', '\n', '\u000B', '\u000C', '\r', ' ', ' ', ' ', ' ', ' ', ' ', '　', '﻿' -> true
        else -> c in ' '..' '
    }

    /** The characters the import's `squash` turns into a space before it collapses white space. */
    private fun isSquashSpace(c: Char): Boolean =
        c == ' ' || c in ' '..'​' || c == ' ' || c == ' ' || c == '　'

    /** JavaScript's line terminators, which `.` in a pattern does not match. */
    fun isLineTerminator(c: Char): Boolean = c == '\n' || c == '\r' || c == ' ' || c == ' '

    /**
     * True for a letter or a number, `[\p{L}\p{N}]` in a pattern with the `u` flag. A character
     * outside the Basic Multilingual Plane is a surrogate pair here and counts as neither, where
     * JavaScript would classify the code point; letters there are rare in schedules.
     */
    fun isWordChar(c: Char): Boolean = c.isLetter() || c.category == CharCategory.DECIMAL_DIGIT_NUMBER ||
        c.category == CharCategory.LETTER_NUMBER || c.category == CharCategory.OTHER_NUMBER

    /** An ASCII digit, `\d` in JavaScript. */
    fun isDigit(c: Char): Boolean = c in '0'..'9'

    /** An ASCII letter, `[a-z]` with the `i` flag. */
    fun isAsciiLetter(c: Char): Boolean = c in 'a'..'z' || c in 'A'..'Z'

    /** JavaScript's `\w` without the `u` and `i` flags together: `[A-Za-z0-9_]`, which `\b` is built on. */
    fun isAsciiWord(c: Char): Boolean = isAsciiLetter(c) || isDigit(c) || c == '_'

    /** `String.prototype.trim`. */
    fun trim(s: String): String {
        var a = 0
        var b = s.length
        while (a < b && isSpace(s[a])) a++
        while (b > a && isSpace(s[b - 1])) b--
        return s.substring(a, b)
    }

    /** `String.prototype.trimStart`. */
    fun trimStart(s: String): String {
        var a = 0
        while (a < s.length && isSpace(s[a])) a++
        return s.substring(a)
    }

    /** `s.replace(/\s+/g, ' ')`, then `trim()`: every run of white space becomes one space. */
    fun collapse(s: String): String = squashWith(s) { isSpace(it) }

    /**
     * The import's `squash`: the Unicode spaces some exports use become spaces, then every run of
     * white space becomes one space, and the ends are trimmed.
     */
    fun squash(s: String): String = squashWith(s) { isSpace(it) || isSquashSpace(it) }

    private inline fun squashWith(s: String, space: (Char) -> Boolean): String {
        val sb = StringBuilder(s.length)
        var pending = false
        for (c in s) {
            if (space(c)) {
                pending = true
            } else {
                if (pending && sb.isNotEmpty()) sb.append(' ')
                pending = false
                sb.append(c)
            }
        }
        return sb.toString()
    }

    /** True when [s] starts with [prefix], comparing ASCII letters without case (a pattern's `i` flag). */
    fun startsWithAsciiIgnoreCase(s: String, prefix: String, at: Int = 0): Boolean {
        if (at < 0 || s.length - at < prefix.length) return false
        for (i in prefix.indices) if (!asciiEqualsIgnoreCase(s[at + i], prefix[i])) return false
        return true
    }

    fun asciiEqualsIgnoreCase(a: Char, b: Char): Boolean = a == b || (isAsciiLetter(a) && isAsciiLetter(b) && (a.code or 0x20) == (b.code or 0x20))

    /** `String.prototype.toLowerCase` for the import's purposes. */
    fun lower(s: String): String = s.lowercase()

    /** `s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()`: the de-duplication key of a candidate. */
    fun wordKey(s: String): String {
        val lower = lower(s)
        val sb = StringBuilder(lower.length)
        var pending = false
        for (c in lower) {
            if (isWordChar(c)) {
                if (pending && sb.isNotEmpty()) sb.append(' ')
                pending = false
                sb.append(c)
            } else {
                pending = true
            }
        }
        return sb.toString()
    }

    /** `s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)`. */
    fun lowerTokens(s: String): List<String> = wordKey(s).let { if (it.isEmpty()) emptyList() else it.split(' ') }

    /** The extension of [filename] as `/\.([a-z0-9]{1,5})$/i` reads it, lowercased, or "". */
    fun extension(filename: String): String {
        val dot = filename.lastIndexOf('.')
        if (dot < 0) return ""
        val ext = filename.substring(dot + 1)
        if (ext.length !in 1..5 || !ext.all { isAsciiLetter(it) || isDigit(it) }) return ""
        return ext.lowercase()
    }
}

/**
 * The first [MAX_LINES] lines of [text], split at `\r\n`, `\r` or `\n`, each cut to [MAX_LINE]
 * characters (import-parse.js `lines`). The text is read by index and never split into one array,
 * so a file of millions of short lines costs no more than the lines read.
 */
internal fun importLines(text: String): Sequence<String> = sequence {
    val n = text.length
    var i = 0
    var count = 0
    while (count < MAX_LINES) {
        var j = i
        while (j < n) {
            val c = text[j]
            if (c == '\n' || c == '\r') break
            j++
        }
        yield(text.substring(i, minOf(j, i + MAX_LINE)))
        if (j >= n) return@sequence
        i = j + if (text[j] == '\r' && j + 1 < n && text[j + 1] == '\n') 2 else 1
        count++
    }
}

/** The text up to the first `\n` (without a `\r` before it), cut to [MAX_LINE] characters. */
internal fun importFirstLine(text: String): String {
    val nl = text.indexOf('\n')
    val line = text.substring(0, minOf(if (nl == -1) text.length else nl, MAX_LINE))
    return if (nl != -1 && nl <= MAX_LINE && line.endsWith('\r')) line.dropLast(1) else line
}

/** Characters read from one line, CSV cell or iCalendar property before anything else looks at it. */
internal const val MAX_LINE = 1000

/** An item of plain text merges at most four lines. */
internal const val MAX_ITEM = 4 * (MAX_LINE + 1)

/** Lines read from plain text or iCalendar. */
internal const val MAX_LINES = 100_000

/** Entries every parser stops at. */
internal const val MAX_ENTRIES = 3000

internal const val MAX_CSV_ROWS = 5000
internal const val MAX_CSV_CELLS = 100_000
internal const val MAX_CANDIDATES = 300
internal const val TITLE_MAX = 300
internal const val CONTEXT_MAX = 300
internal const val EXCERPT_MAX = 160
