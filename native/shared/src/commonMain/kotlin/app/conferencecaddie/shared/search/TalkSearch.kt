package app.conferencecaddie.shared.search

import app.conferencecaddie.shared.Embedder
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.bundle.TalkVectors
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.embed.BgeEmbedder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.time.Clock
import kotlin.time.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

/** What the person asked for: the search text and the filters, as the web app sends them. */
data class SearchRequest(
    val query: String = "",
    /** One day, `YYYY-MM-DD`, or null for every day. */
    val day: String? = null,
    val tracks: Set<String> = emptySet(),
    val levels: Set<String> = emptySet(),
    /** Selected tag values by tag group; values of one group are alternatives, groups narrow. */
    val tags: Map<String, Set<String>> = emptyMap(),
    /** True or false keeps only talks with or without slides; null keeps both. */
    val hasSlides: Boolean? = null,
    /** Speaker and room names from tapped suggestion chips. */
    val speakers: Set<String> = emptySet(),
    val rooms: Set<String> = emptySet(),
    /** Minutes after midnight, conference time: start at or after, and before. */
    val startAfter: Int? = null,
    val startBefore: Int? = null,
    val hideSponsor: Boolean = false,
    val happeningNow: Boolean = false,
    /** Include co-located events and showcases (kind ambient). */
    val includeEvents: Boolean = false,
    /** Time phrases the person removed: they leave the text but filter nothing. */
    val ignorePhrases: Set<String> = emptySet(),
)

data class FacetCount<T>(val value: T, val count: Int)

data class TagFacet(val group: String, val values: List<FacetCount<String>>)

data class Facets(
    val day: List<FacetCount<String>>,
    val track: List<FacetCount<String>>,
    /** Null when the conference has no level. */
    val level: List<FacetCount<String>>?,
    val hasSlides: List<FacetCount<Boolean>>,
    val tags: List<TagFacet>,
)

/**
 * Where a talk of a text search came in the two lists that reciprocal rank fusion combined (the
 * "Why this rank" panel): its place in the fused list, its place among the keyword matches (null
 * when outside the first [SearchResult.RANK_WINDOW]) and among the nearest by meaning (null when not
 * among the [SearchResult.SEMANTIC_K] nearest, or when meaning-based matching did not run).
 */
data class Ranking(val rank: Int, val keywordRank: Int?, val semanticRank: Int?)

data class SearchResult(
    /** How many talks match; [talks] holds all of them, best first. */
    val total: Int,
    /** The text the keyword search saw, after time phrases left it. */
    val searchText: String,
    val timePhrases: List<TimePhrases.Phrase>,
    val suggestions: List<Suggestions.Suggestion>,
    /** Whether the Happening now chip applies: the conference has talks today in its own time zone. */
    val happeningNowAvailable: Boolean,
    val talks: List<Talk>,
    val facets: Facets,
    /** For a text search, each result's place in the fused, keyword and meaning lists; empty in browse mode. */
    val ranking: Map<String, Ranking> = emptyMap(),
    /**
     * True when a text search ran on keywords alone because meaning-based matching was not available
     * (the model is missing or failed to load), as the server's `degraded: { semantic: true }`.
     */
    val degraded: Boolean = false,
    /** True when the meaning-based list took part (a text search with the model loaded). */
    val semantic: Boolean = false,
) {
    companion object {
        /** How many of each list reciprocal rank fusion reads, as the server's rank_window_size. */
        const val RANK_WINDOW = 50

        /** How many nearest talks by meaning a text search takes, as the server's knn k. */
        const val SEMANTIC_K = 50

        /** The rank constant of reciprocal rank fusion, Elasticsearch's default. */
        const val RANK_CONSTANT = 60
    }
}

/**
 * Search over one conference's bundle, with the behaviour of the server's `POST /api/search`
 * (server/search.mjs):
 *
 * - Text: two lists fused by reciprocal rank fusion (rank window [SearchResult.RANK_WINDOW], rank
 *   constant [SearchResult.RANK_CONSTANT]), as the server's rrf retriever:
 *   - Keywords: SQLite FTS5 with the Porter stemmer, as the server's english analyzer has, and
 *     English stop words dropped, over title (weight 2), abstract, speakers and taglines. Queries of
 *     one or two terms must match every term; longer ones must match 60% of them (the server's
 *     `minimum_should_match: "2<60%"`), all within one field, as the server's best_fields query
 *     counts them. Ordered by BM25, then talk id.
 *   - Meaning: the query, after time phrases left it, is embedded with the model's retrieval
 *     instruction ([embedder]) and compared with the bundle's int8 talk vectors; the
 *     [SearchResult.SEMANTIC_K] nearest among the talks that pass the base filters B, by cosine, then
 *     talk id. The facet selections apply afterwards, as the server's knn pre-filter holds only B.
 *   The matches are the keyword matches plus those nearest talks. A match outside both lists' first
 *   [SearchResult.RANK_WINDOW] (the server cannot return those at all) follows the fused ones in
 *   keyword order. Without the model (not loaded yet, missing or failed), the keyword list alone
 *   ranks, it also searches topics, track and room as 2a did, and a result says [SearchResult.degraded].
 * - Empty text (browse mode): every talk, by start, then talk id.
 * - Base filters B: kind (talk, or talk and ambient with [SearchRequest.includeEvents]), the start
 *   window, speakers, rooms, hide sponsor, Happening now (in progress or starting within 60
 *   minutes) and the time phrases.
 * - Facet groups S: day, track, level, has slides, and one group per tag group. The count shown for
 *   a value of group g is computed over the matches, B and every selection except g's, so it is the
 *   total the person gets after selecting it. A selected value with no matches is listed with 0.
 */
class TalkSearch(
    private val bundle: TalkBundle,
    private val scope: String,
    private val database: CaddieDatabase,
    private val now: () -> Instant = { Clock.System.now() },
    /**
     * The query embedder, or null while it is not loaded. [embedderFailed] tells "not loaded yet"
     * from "unavailable", which a result reports as [SearchResult.degraded].
     */
    private val embedder: () -> Embedder? = { null },
    private val embedderFailed: () -> Boolean = { false },
) {
    private val shape = TimePhrases.Shape.of(bundle.conference.startDate, bundle.conference.endDate, bundle.talks)
    private val queryVectors = QueryVectorCache()

    suspend fun search(request: SearchRequest): SearchResult {
        val time = TimePhrases.parse(request.query.trim().take(MAX_QUERY), shape, request.ignorePhrases)
        val text = time.text
        val nowMs = now().toEpochMilliseconds()
        val passes = { t: Talk -> passesBase(t, request, time.filter, nowMs) }
        val groups = selections(request)
        val selected = { t: Talk -> groups.all { it.test(t) } }

        val vectors = bundle.vectors
        val queryVector = if (text.isBlank() || vectors == null) null else queryVector(text)
        val semantic = queryVector != null

        // The keyword matches that pass B, in BM25 order; every talk in browse mode.
        val keyword: List<Talk> = if (text.isBlank()) {
            bundle.talks.filter(passes)
        } else {
            lexical(text, if (semantic) SERVER_COLUMNS else COLUMNS).mapNotNull { bundle.talksById[it] }.filter(passes)
        }
        // The nearest talks by meaning among those that pass B, best first.
        val nearest: List<Talk> = if (queryVector != null && vectors != null) {
            nearestTalks(queryVector, vectors, SearchResult.SEMANTIC_K, passes)
        } else {
            emptyList()
        }

        // M ∩ B, in keyword order, then the nearest talks that are not keyword matches.
        val base = if (nearest.isEmpty()) keyword else (keyword + nearest).distinctBy { it.talkId }
        val unranked = base.filter(selected)
        val ranking = if (text.isBlank()) emptyMap() else fuse(keyword.filter(selected), nearest.filter(selected))
        val results = if (text.isBlank()) unranked else unranked.sortedBy { ranking.getValue(it.talkId).rank }

        fun except(name: String) = base.filter { t -> groups.all { it.name == name || it.test(t) } }

        val facets = Facets(
            day = counts(except("day").map { it.day }, listOfNotNull(request.day)).sortedBy { it.value },
            track = counts(except("track").mapNotNull { it.track }, request.tracks),
            level = if (bundle.conference.hasLevel) counts(except("level").mapNotNull { it.level }, request.levels) else null,
            hasSlides = except("has_slides").let { list ->
                listOf(FacetCount(true, list.count { it.hasSlides }), FacetCount(false, list.count { !it.hasSlides }))
            },
            tags = bundle.conference.tagGroups.map { group ->
                val values = except("tag:$group").flatMap { t -> t.tags.filter { it.group == group }.map { it.value }.distinct() }
                TagFacet(group, counts(values, request.tags[group].orEmpty()))
            },
        )

        val suggestions = if (text.isBlank()) {
            emptyList()
        } else {
            Suggestions.suggest(
                text,
                bundle.facets,
                Suggestions.Selected(
                    tracks = request.tracks,
                    rooms = request.rooms,
                    speakers = request.speakers,
                    tags = request.tags.values.flatten().toSet(),
                ),
            )
        }

        return SearchResult(
            total = results.size,
            searchText = text,
            timePhrases = time.phrases,
            suggestions = suggestions,
            happeningNowAvailable = runningToday(nowMs),
            talks = results,
            facets = facets,
            ranking = ranking,
            degraded = text.isNotBlank() && !semantic && embedderFailed(),
            semantic = semantic,
        )
    }

    /**
     * Reciprocal rank fusion of the keyword list and the meaning list, both already filtered by B and
     * the selections, so a talk's rank in each is its position among what the person can see (the
     * server's rrf filter is passed down to both child retrievers the same way). Each list counts up
     * to [SearchResult.RANK_WINDOW] places; a talk's score is the sum of 1 / (60 + rank) over the
     * lists it is placed in. Ties go to the better keyword rank, then the better meaning rank, then
     * talk id. Keyword matches outside both windows follow, in keyword order.
     */
    private fun fuse(keyword: List<Talk>, nearest: List<Talk>): Map<String, Ranking> {
        val window = SearchResult.RANK_WINDOW
        val kRank = HashMap<String, Int>()
        keyword.take(window).forEachIndexed { i, t -> kRank[t.talkId] = i + 1 }
        val sRank = HashMap<String, Int>()
        nearest.take(window).forEachIndexed { i, t -> sRank[t.talkId] = i + 1 }
        fun score(id: String): Double =
            (kRank[id]?.let { 1.0 / (SearchResult.RANK_CONSTANT + it) } ?: 0.0) +
                (sRank[id]?.let { 1.0 / (SearchResult.RANK_CONSTANT + it) } ?: 0.0)
        val fused = (kRank.keys + sRank.keys).sortedWith(
            compareByDescending<String> { score(it) }
                .thenBy { kRank[it] ?: Int.MAX_VALUE }
                .thenBy { sRank[it] ?: Int.MAX_VALUE }
                .thenBy { it },
        )
        val rest = keyword.map { it.talkId }.filter { it !in kRank && it !in sRank }
        val ranking = LinkedHashMap<String, Ranking>()
        (fused + rest).forEachIndexed { i, id -> ranking[id] = Ranking(i + 1, kRank[id], sRank[id]) }
        return ranking
    }

    /**
     * The [k] talks nearest to [query] among those that pass [accept], by cosine over the int8 rows,
     * then talk id. Talks without a row (breaks and housekeeping) never qualify.
     */
    fun nearestTalks(query: FloatArray, vectors: TalkVectors, k: Int, accept: (Talk) -> Boolean): List<Talk> =
        bundle.talks.asSequence()
            .filter(accept)
            .mapNotNull { t -> vectors.rowOf(t.talkId)?.let { t to vectors.cosine(query, it) } }
            .sortedWith(compareByDescending<Pair<Talk, Double>> { it.second }.thenBy { it.first.talkId })
            .take(k)
            .map { it.first }
            .toList()

    /** The embedding of [text] as a search query, or null without a working embedder. */
    suspend fun queryVector(text: String): FloatArray? {
        queryVectors.get(text)?.let { return it }
        val e = embedder() ?: return null
        if (e.dimensions != TalkVectors.DIMS || e.modelId != BgeEmbedder.MODEL_ID) return null
        val v = try {
            e.embed(listOf(BgeEmbedder.queryText(text))).single()
        } catch (c: CancellationException) {
            throw c
        } catch (_: Exception) {
            // A failed embedding leaves this search on keywords alone; the next one tries again.
            return null
        }
        queryVectors.put(text, v)
        return v
    }

    /** The talks of the bundle's `related` list for [talkId], most similar first. */
    fun related(talkId: String): List<Talk> = bundle.related[talkId].orEmpty().mapNotNull { bundle.talksById[it] }

    /** Whether the conference has a talk on today's date in its own time zone. */
    fun runningToday(nowMs: Long): Boolean {
        val zone = bundle.conference.timeZone?.let { runCatching { TimeZone.of(it) }.getOrNull() } ?: TimeZone.UTC
        val today = Instant.fromEpochMilliseconds(nowMs).toLocalDateTime(zone).date.toString()
        return bundle.talks.any { it.kind == "talk" && it.day == today }
    }

    /**
     * The keyword matches of [text] over title and abstract only, in BM25 order: the server's keyword
     * stand-in for the For you text when meaning-based matching is unavailable.
     */
    internal suspend fun lexicalTitleAbstract(text: String): List<String> = lexical(text, TITLE_ABSTRACT)

    // The keyword matches of [text] in BM25 order, in [columns]: the fields the server's multi_match
    // reads (title, abstract, speakers and taglines) when meaning-based matching runs too, and every
    // column (also topics, track and room, which stand in for meaning) when it does not.
    //
    // The server's multi_match is of type best_fields, which applies minimum_should_match to each
    // field on its own: a talk matches when one field holds enough of the terms, not when the terms
    // are spread over several fields. So each term is looked up in each column, and a talk is kept
    // when its best column reaches the required count. The ranking is BM25 over those columns.
    private suspend fun lexical(text: String, columns: List<String>): List<String> {
        val terms = terms(text)
        if (terms.isEmpty()) return emptyList()
        val quoted = terms.map { "\"" + it.replace("\"", "\"\"") + "\"" }
        val perColumn = columns.flatMap { column -> quoted.map { "$column : $it" } }
        val filter = columns.joinToString(" ", prefix = "{", postfix = "} : ")
        val (sets, ranked) = database.match(scope, perColumn, quoted.joinToString(" OR ") { filter + it })
        val required = if (terms.size <= 2) terms.size else maxOf(1, (terms.size * 3) / 5)
        val best = HashMap<String, Int>()
        for (column in columns.indices) {
            val hits = HashMap<String, Int>()
            for (term in quoted.indices) {
                for (id in sets[column * quoted.size + term]) hits[id] = (hits[id] ?: 0) + 1
            }
            for ((id, n) in hits) if (n > (best[id] ?: 0)) best[id] = n
        }
        return ranked.filter { (best[it] ?: 0) >= required }
    }

    private fun passesBase(t: Talk, r: SearchRequest, phrases: TimePhrases.Filter, nowMs: Long): Boolean {
        if (t.kind != "talk" && !(r.includeEvents && t.kind == "ambient")) return false
        if (r.startAfter != null && t.startMinutes < r.startAfter) return false
        if (r.startBefore != null && t.startMinutes >= r.startBefore) return false
        if (r.speakers.isNotEmpty() && r.speakers.none { name -> t.speakers.any { speakerMatches(it, name) } }) return false
        if (r.rooms.isNotEmpty() && t.room !in r.rooms) return false
        if (r.hideSponsor && t.sponsor) return false
        if (r.happeningNow && !(t.endEpochMs > nowMs && t.startEpochMs < nowMs + HAPPENING_NOW_AHEAD_MS)) return false
        return phrases.matches(t)
    }

    private class Group(val name: String, val test: (Talk) -> Boolean)

    private fun selections(r: SearchRequest): List<Group> = buildList {
        if (r.day != null) add(Group("day") { it.day == r.day })
        if (r.tracks.isNotEmpty()) add(Group("track") { it.track in r.tracks })
        if (r.levels.isNotEmpty() && bundle.conference.hasLevel) add(Group("level") { it.level in r.levels })
        if (r.hasSlides != null) add(Group("has_slides") { it.hasSlides == r.hasSlides })
        for ((group, values) in r.tags) {
            if (values.isNotEmpty()) add(Group("tag:$group") { t -> t.tags.any { it.group == group && it.value in values } })
        }
    }

    // Counts by value, most frequent first and then by value, as an Elasticsearch terms aggregation
    // orders them; selected values with no match are added with 0.
    private fun counts(values: List<String>, selected: Collection<String>): List<FacetCount<String>> {
        val list = values.groupingBy { it }.eachCount().map { FacetCount(it.key, it.value) }
            .sortedWith(compareByDescending<FacetCount<String>> { it.count }.thenBy { it.value })
            .toMutableList()
        for (v in selected) if (list.none { it.value == v }) list += FacetCount(v, 0)
        return list
    }

    companion object {
        const val MAX_QUERY = 200
        const val HAPPENING_NOW_AHEAD_MS = 60 * 60 * 1000L

        /** The fields of the server's search multi_match, and of its For you fallback. */
        private val SERVER_COLUMNS = listOf("title", "abstract", "speakers", "taglines")
        private val TITLE_ABSTRACT = listOf("title", "abstract")

        /** Lucene's English stop words, which the server's english analyzer drops. */
        val STOP_WORDS = setOf(
            "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in", "into", "is", "it", "no", "not",
            "of", "on", "or", "such", "that", "the", "their", "then", "there", "these", "they", "this", "to", "was",
            "will", "with",
        )

        /** The distinct search terms of [text]: letters and digits, lower case, stop words dropped. */
        fun terms(text: String): List<String> = normalizeKey(text).split(' ')
            .filter { it.isNotEmpty() && it !in STOP_WORDS }
            .distinct()
            .take(MAX_TERMS)

        private const val MAX_TERMS = 32

        /** The columns of the FTS5 table `talk_fts` (CaddieDatabase.MIGRATIONS), in table order. */
        private val COLUMNS = listOf("title", "abstract", "speakers", "taglines", "topics", "track", "room")

        // The server matches a speaker name as a phrase inside the speakers field.
        private fun speakerMatches(speaker: String, name: String): Boolean {
            val s = " ${normalizeKey(speaker)} "
            val n = normalizeKey(name)
            return n.isNotEmpty() && s.contains(" $n ")
        }
    }
}

/** The last few query embeddings, so a change of filters does not embed the same text again. */
internal class QueryVectorCache(private val capacity: Int = 16) {
    private val mutex = Mutex()
    private val map = LinkedHashMap<String, FloatArray>()

    suspend fun get(text: String): FloatArray? = mutex.withLock {
        map.remove(text)?.also { map[text] = it }
    }

    suspend fun put(text: String, vector: FloatArray) = mutex.withLock {
        map.remove(text)
        map[text] = vector
        while (map.size > capacity) map.remove(map.keys.first())
    }
}
