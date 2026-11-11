package app.conferencecaddie.shared.search

import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.bundle.TalkBundle

/**
 * Talks for you, ported from the server's `POST /api/recommendations` (server/recommend.mjs) and run
 * on the device over the conference's bundle. Talks are suggested from what the person wants to
 * learn, never from what they can speak to (DECISIONS.md, For you is learn-only), and from the
 * talks they marked:
 *
 * - Learn topics: the talks that carry at least one of them, a talk with more of them first (each
 *   topic is its own constant-score clause on the server), then by start and talk id.
 * - The "learn or figure out next" text: the [SearchResult.SEMANTIC_K] talks nearest to it by
 *   meaning, embedded as a search query. Without the model, a keyword match over title and abstract
 *   stands in, as the server's fallback does, and once the model has failed for good the result says
 *   [Result.Ready.degraded].
 * - Native only: the talks nearest by meaning to the centre of the talks the person marked, so a
 *   person who marks talks gets suggestions without picking topics. The server's request carries
 *   the marked talks only to leave them out.
 *
 * The lists are fused by reciprocal rank fusion with equal weights, rank window
 * [SearchResult.RANK_WINDOW]; ties go to the earlier talk, then the talk id, so the same request
 * always gives the same order. Every list keeps only talks (no events or breaks) that have not ended
 * and that the person has not marked. Each suggestion names the learn topics of the request it
 * carries ([Item.learnTopics], never any other topic), a passage of its abstract for the text, and
 * the marked talk it is most like.
 */
class ForYou(
    private val bundle: TalkBundle,
    private val search: TalkSearch,
) {
    data class Request(
        /** Topic ids the person wants to learn about (at most [MAX_TOPICS] are read). */
        val learnTopics: List<String> = emptyList(),
        /** What they are trying to learn or figure out next (at most [MAX_TEXT] characters). */
        val text: String = "",
        /** The talks they marked: left out of the suggestions, and used to find talks like them. */
        val interested: Set<String> = emptySet(),
        val size: Int = 20,
    )

    data class Item(
        val talk: Talk,
        /** Labels of the request's learn topics that the talk carries, in the request's order. */
        val learnTopics: List<String>,
        /** The sentence of the abstract closest to the request's text; null without text. */
        val passage: String?,
        /** The marked talk this one is most like, when the marked talks placed it. */
        val like: Talk?,
    )

    sealed interface Result {
        /** Nothing to suggest from: no learn topic, no text and no marked talk. */
        data object NeedsInput : Result

        data class Ready(val items: List<Item>, val degraded: Boolean) : Result
    }

    private fun learnText(request: Request): String = request.text.replace(SPACE, " ").trim().take(MAX_TEXT)

    /** The text [recommend] embeds for [request], or "" when it embeds nothing (no text, or no vectors). */
    internal fun embeddedText(request: Request): String = if (bundle.vectors == null) "" else learnText(request)

    suspend fun recommend(request: Request, nowMs: Long): Result {
        val learn = request.learnTopics.distinct().take(MAX_TOPICS)
        val text = learnText(request)
        val marked = request.interested
        val vectors = bundle.vectors
        val markedRows = marked.mapNotNull { vectors?.rowOf(it) }
        if (learn.isEmpty() && text.isEmpty() && markedRows.isEmpty() && marked.isEmpty()) return Result.NeedsInput
        if (learn.isEmpty() && text.isEmpty() && markedRows.isEmpty()) return Result.Ready(emptyList(), degraded = false)

        val eligible = { t: Talk -> t.kind == "talk" && t.endEpochMs > nowMs && t.talkId !in marked }
        val window = SearchResult.RANK_WINDOW

        val byTopics: List<Talk> = if (learn.isEmpty()) {
            emptyList()
        } else {
            val wanted = learn.toSet()
            bundle.talks.asSequence()
                .filter(eligible)
                .map { t -> t to t.topics.count { it in wanted } }
                .filter { it.second > 0 }
                .sortedWith(compareByDescending<Pair<Talk, Int>> { it.second }.thenBy { it.first.startEpochMs }.thenBy { it.first.talkId })
                .take(window)
                .map { it.first }
                .toList()
        }

        var degraded = false
        val byText: List<Talk> = when {
            text.isEmpty() -> emptyList()
            else -> {
                val v = if (vectors != null) search.queryVector(text) else null
                if (v != null && vectors != null) {
                    search.nearestTalks(v, vectors, SearchResult.SEMANTIC_K, eligible)
                } else {
                    // Keywords stand in while the model loads too; only a model that failed for good
                    // is reported, as search reports it.
                    degraded = search.semanticUnavailable()
                    search.lexicalTitleAbstract(text).mapNotNull { bundle.talksById[it] }.filter(eligible).take(window)
                }
            }
        }

        val centre = if (vectors != null && markedRows.isNotEmpty()) vectors.centroid(markedRows) else null
        val byMarked: List<Talk> = if (centre != null && vectors != null) {
            search.nearestTalks(centre, vectors, SearchResult.SEMANTIC_K, eligible)
        } else {
            emptyList()
        }

        val lists = listOf(byTopics, byText, byMarked).map { list -> list.take(window).withIndex().associate { (i, t) -> t.talkId to i + 1 } }
        val score = HashMap<String, Double>()
        for (ranks in lists) for ((id, r) in ranks) score[id] = (score[id] ?: 0.0) + 1.0 / (SearchResult.RANK_CONSTANT + r)
        val ordered = score.keys.mapNotNull { bundle.talksById[it] }.sortedWith(
            compareByDescending<Talk> { score.getValue(it.talkId) }.thenBy { it.startEpochMs }.thenBy { it.talkId },
        ).take(request.size.coerceIn(1, MAX_SIZE))

        val labels = bundle.topicsById
        val markedIds = marked.filter { vectors?.rowOf(it) != null }
        val items = ordered.map { t ->
            val like = if (t.talkId in lists[2] && vectors != null) {
                val row = vectors.rowOf(t.talkId)
                if (row == null) {
                    null
                } else {
                    markedIds.maxWithOrNull(
                        compareBy<String> { vectors.cosine(row, vectors.rowOf(it)!!) }.thenByDescending { it },
                    )?.let { bundle.talksById[it] }
                }
            } else {
                null
            }
            Item(
                talk = t,
                learnTopics = learn.filter { it in t.topics }.mapNotNull { labels[it]?.label },
                passage = if (text.isEmpty()) null else Evidence.passage(t, text),
                like = like,
            )
        }
        return Result.Ready(items, degraded)
    }

    companion object {
        const val MAX_TOPICS = 30
        const val MAX_TEXT = 500
        const val MAX_SIZE = 50
        private val SPACE = Regex("""\s+""")
    }
}
