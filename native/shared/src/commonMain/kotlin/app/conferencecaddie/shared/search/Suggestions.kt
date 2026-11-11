package app.conferencecaddie.shared.search

import app.conferencecaddie.shared.bundle.Facet

/**
 * Value matching, ported from `suggestChips` in server/facets.mjs: the track, room, speaker and tag
 * names found in the search text are offered as chips ("Did you mean track: Security?"). A
 * suggestion is only ever offered; it filters nothing until the person taps it.
 *
 * - The text is normalised with [normalizeKey] and cut into every run of one to six words; a facet
 *   whose normalised key equals one of those runs matches (score 3, the server's boost).
 * - For a text of up to four words, a track, room or tag whose words contain every word of the text
 *   also matches (score 1), so "security" finds "Security + Identity". Speakers match only by their
 *   whole name.
 * - A value already selected is left out, at most two suggestions per kind and four in all, ordered
 *   by score, then by how many talks carry the value.
 *
 * Elasticsearch scores the partial match with BM25, so between two partial matches the server may
 * order differently; the server's own tie-break is then the talk count, as it is here.
 */
object Suggestions {
    private const val MAX_WORDS = 6
    private const val MAX_WINDOWS = 150
    private const val PARTIAL_MAX_WORDS = 4
    private const val MAX_SUGGESTIONS = 4
    private const val MAX_PER_KIND = 2
    private val KIND_ORDER = listOf("track", "room", "speaker", "tag")

    data class Suggestion(val kind: String, val label: String, val value: String, val group: String?, val talks: Int)

    /** What is already selected, by kind; tag values are matched by value, as the server does. */
    data class Selected(
        val tracks: Set<String> = emptySet(),
        val rooms: Set<String> = emptySet(),
        val speakers: Set<String> = emptySet(),
        val tags: Set<String> = emptySet(),
    ) {
        fun has(kind: String, value: String): Boolean = when (kind) {
            "track" -> value in tracks
            "room" -> value in rooms
            "speaker" -> value in speakers
            "tag" -> value in tags
            else -> false
        }
    }

    fun suggest(text: String, facets: List<Facet>, selected: Selected = Selected()): List<Suggestion> {
        val normal = normalizeKey(text)
        if (normal.length < 2) return emptyList()
        val words = normal.split(' ')
        val windows = windows(words)
        val partial = words.size <= PARTIAL_MAX_WORDS
        val scored = facets.mapNotNull { f ->
            var score = 0
            if (f.keys.any { it in windows }) score += 3
            if (partial && f.kind != "speaker") {
                val facetWords = f.words.split(' ').toSet()
                if (words.all { it in facetWords }) score += 1
            }
            if (score == 0) null else f to score
        }.sortedWith(
            compareByDescending<Pair<Facet, Int>> { it.second }
                .thenByDescending { it.first.talks }
                .thenBy { KIND_ORDER.indexOf(it.first.kind) }
                .thenBy { it.first.value },
        )
        val perKind = HashMap<String, Int>()
        val out = ArrayList<Suggestion>()
        for ((f, _) in scored) {
            if (selected.has(f.kind, f.value)) continue
            val n = perKind[f.kind] ?: 0
            if (n >= MAX_PER_KIND) continue
            perKind[f.kind] = n + 1
            out += Suggestion(f.kind, f.label, f.value, f.group, f.talks)
            if (out.size >= MAX_SUGGESTIONS) break
        }
        return out
    }

    // Every run of one to MAX_WORDS consecutive words; runs shorter than two characters are left
    // out, and the number of runs is capped.
    private fun windows(words: List<String>): Set<String> {
        val seen = LinkedHashSet<String>()
        var i = 0
        while (i < words.size && seen.size < MAX_WINDOWS) {
            var n = 1
            while (n <= MAX_WORDS && i + n <= words.size) {
                val run = words.subList(i, i + n).joinToString(" ")
                if (run.length >= 2) seen += run
                n++
            }
            i++
        }
        return seen.take(MAX_WINDOWS).toSet()
    }
}
