package app.conferencecaddie.shared.search

import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.bundle.Topic

/**
 * The topic picker's lists, ported from the server's topics API (server/topics-api.mjs) and run on
 * the bundle's topics:
 *
 * - [common]: every topic by rank, as `GET /api/topics` with an empty q.
 * - [typeAhead]: `GET /api/topics?q=`, Elasticsearch's bool_prefix multi_match over label and
 *   aliases. Each word of the text is a should clause and the last one may be a prefix, so a topic
 *   matches when any word does; more matched words rank higher, then more talks, then the label.
 *   Elasticsearch also scores word pairs in order through its shingle fields and weighs rare words
 *   higher (BM25); here every matched word counts the same, so close scores can order differently.
 * - [suggest]: `POST /api/topics/suggest`: the topics of the given talks, most common first (at
 *   most [FROM_TALKS] of them), ahead of every topic whose label or aliases share a word with the
 *   text; at most [SUGGEST_MAX].
 *
 * Words are compared after [normalizeKey] (lower case, accents and punctuation removed).
 */
object TopicSearch {
    const val TYPE_AHEAD_MAX = 12
    const val SUGGEST_MAX = 12
    const val FROM_TALKS = 8
    const val QUERY_MAX = 60
    const val TEXT_MAX = 500

    fun common(bundle: TalkBundle): List<Topic> = bundle.topics.sortedWith(compareBy<Topic> { it.rank }.thenBy { it.label })

    fun typeAhead(bundle: TalkBundle, query: String, size: Int = TYPE_AHEAD_MAX): List<Topic> {
        val words = normalizeKey(query.take(QUERY_MAX)).split(' ').filter { it.isNotEmpty() }
        if (words.isEmpty()) return emptyList()
        val last = words.last()
        val whole = words.dropLast(1).toSet()
        return bundle.topics.mapNotNull { topic ->
            val own = wordsOf(topic)
            val score = whole.count { it in own } + (if (own.any { it.startsWith(last) }) 1 else 0)
            if (score > 0) topic to score else null
        }
            .sortedWith(compareByDescending<Pair<Topic, Int>> { it.second }.thenByDescending { it.first.talkCount }.thenBy { it.first.label })
            .take(size)
            .map { it.first }
    }

    fun suggest(bundle: TalkBundle, talkIds: Collection<String>, text: String): List<Topic> {
        val scores = HashMap<String, Int>()
        if (talkIds.isNotEmpty()) {
            val ids = talkIds.toSet()
            val counts = bundle.talks.filter { it.kind == "talk" && it.talkId in ids }
                .flatMap { it.topics.distinct() }
                .groupingBy { it }
                .eachCount()
            counts.entries.sortedWith(compareByDescending<Map.Entry<String, Int>> { it.value }.thenBy { it.key })
                .take(FROM_TALKS)
                .forEach { (id, n) -> scores[id] = TALK_TOPIC_BOOST + n }
        }
        val words = normalizeKey(text.take(TEXT_MAX)).split(' ').filter { it.isNotEmpty() && it !in TalkSearch.STOP_WORDS }.toSet()
        if (words.isNotEmpty()) {
            for (topic in bundle.topics) {
                val matched = wordsOf(topic).count { it in words }
                if (matched > 0) scores[topic.topicId] = (scores[topic.topicId] ?: 0) + matched
            }
        }
        val byId = bundle.topicsById
        return scores.entries.mapNotNull { (id, score) -> byId[id]?.let { it to score } }
            .sortedWith(compareByDescending<Pair<Topic, Int>> { it.second }.thenByDescending { it.first.talkCount }.thenBy { it.first.label })
            .take(SUGGEST_MAX)
            .map { it.first }
    }

    private const val TALK_TOPIC_BOOST = 1000

    private fun wordsOf(topic: Topic): Set<String> =
        (listOf(topic.label) + topic.aliases).flatMap { normalizeKey(it).split(' ') }.filter { it.isNotEmpty() }.toSet()
}
