package app.conferencecaddie.shared.importer

import app.conferencecaddie.shared.bundle.Talk
import kotlin.math.ln

/**
 * Finds a conference's talks for schedule candidates in memory, as the Worker's import does
 * (worker/src/talks/import.js), which in turn reproduces the named queries of the Elasticsearch
 * version in server/import.mjs over an inverted index of the kind-talk titles and speakers:
 *
 * - exact_title: the candidate's analysed words appear as a phrase in the title (only for a
 *   candidate with three content words or more);
 * - title_words: the title holds "3<75%" of the candidate's words;
 * - speaker: at least two words of the candidate's nearby speaker text are in the talk's speakers;
 * - time: the talk starts within the minute the file gives.
 *
 * A hit must match exact_title or title_words. It is scored with BM25 on the title (k1 1.2, b 0.75)
 * plus the speaker and time clauses; the best talk per candidate is kept, then the best candidate
 * per talk, and the confidence label comes from every clause that matched that talk. Ties go to the
 * talk that comes first in the bundle.
 */
internal class ScheduleMatcher(talks: List<Talk>) {
    private class Doc(val talk: Talk, val title: List<String>, val tf: Map<String, Int>, val speakers: Set<String>)

    private val docs: List<Doc> = talks.filter { it.kind == "talk" }.map { t ->
        val title = ImportAnalysis.analyzed(t.title)
        val tf = HashMap<String, Int>()
        for (w in title) tf[w] = (tf[w] ?: 0) + 1
        Doc(t, title, tf, t.speakers.flatMap { ImportAnalysis.words(it) }.toSet())
    }
    private val titleIdx = HashMap<String, MutableList<Int>>()
    private val speakerIdx = HashMap<String, MutableList<Int>>()
    private val avg: Double

    init {
        var total = 0
        docs.forEachIndexed { i, d ->
            total += d.title.size
            for (w in d.tf.keys) titleIdx.getOrPut(w) { ArrayList() } += i
            for (w in d.speakers) speakerIdx.getOrPut(w) { ArrayList() } += i
        }
        avg = if (docs.isNotEmpty()) total.toDouble() / docs.size else 1.0
    }

    private fun idf(n: Int, df: Int): Double = ln(1 + (n - df + 0.5) / (df + 0.5))

    private class Acc {
        var score = 0.0
        var matched = 0
        var idfSum = 0.0
    }

    class Hit(val doc: Int, val talk: Talk, val score: Double, val names: List<String>)

    /** The best talk for [c], or null (`matchCandidate`). */
    fun match(c: ImportCandidate): Hit? {
        val n = docs.size
        val phrase = ImportAnalysis.analyzed(c.text)
        val terms = phrase.distinct()
        if (terms.isEmpty()) return null
        val need = ImportAnalysis.minimumShouldMatch(terms.size, TITLE_MIN_MATCH)
        val acc = LinkedHashMap<Int, Acc>()
        for (term in terms) {
            val posting = titleIdx[term] ?: continue
            val w = idf(n, posting.size)
            for (i in posting) {
                val d = docs[i]
                val tf = d.tf.getValue(term).toDouble()
                val s = (w * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * d.title.size) / avg))
                val a = acc.getOrPut(i) { Acc() }
                a.score += s
                a.matched += 1
                a.idfSum += w
            }
        }
        val context = if (c.context.isNotEmpty()) ImportAnalysis.words(c.context).distinct() else emptyList()
        val hint = c.hintMs
        var best: Hit? = null
        for ((i, a) in acc) {
            val d = docs[i]
            val names = ArrayList<String>(4)
            var score = 0.0
            if (c.exact && containsPhrase(d.title, phrase)) {
                names += EXACT_TITLE
                score += a.idfSum
            }
            if (a.matched >= need) {
                names += TITLE_WORDS
                score += a.score
            }
            if (names.isEmpty()) continue
            if (context.size >= 2) {
                var hits = 0
                var s = 0.0
                for (w in context) {
                    if (w !in d.speakers) continue
                    hits += 1
                    s += idf(n, speakerIdx[w]?.size ?: 1)
                }
                if (hits >= 2) {
                    names += SPEAKER
                    score += s
                }
            }
            if (hint != null && d.talk.startEpochMs >= hint && d.talk.startEpochMs < hint + 60_000) {
                names += TIME
                score += 1
            }
            val b = best
            if (b == null || score > b.score || (score == b.score && i < b.doc)) best = Hit(i, d.talk, score, names)
        }
        return best
    }

    private fun containsPhrase(seq: List<String>, phrase: List<String>): Boolean {
        if (phrase.isEmpty() || phrase.size > seq.size) return false
        outer@ for (i in 0..seq.size - phrase.size) {
            for (j in phrase.indices) if (seq[i + j] != phrase[j]) continue@outer
            return true
        }
        return false
    }

    /**
     * The import's result for [candidates] (`runImport` after parsing): the talks found, listed in
     * the order the items that found them appear in the file; the number of items that offered a
     * candidate but matched no talk; and [extractedChars].
     */
    fun run(candidates: List<ImportCandidate>, extractedChars: Int): ImportResult {
        class Found(var hit: Hit, var candidate: ImportCandidate, val names: MutableSet<String>)
        val best = LinkedHashMap<String, Found>()
        val matchedEntries = HashSet<Int>()
        val entriesWithCandidates = HashSet<Int>()
        for (c in candidates) {
            entriesWithCandidates += c.entries
            val hit = match(c) ?: continue
            matchedEntries += c.entries
            val id = hit.talk.talkId
            val prev = best[id]
            if (prev == null) {
                best[id] = Found(hit, c, hit.names.toMutableSet())
            } else {
                prev.names += hit.names
                if (hit.score > prev.hit.score) {
                    prev.hit = hit
                    prev.candidate = c
                }
            }
        }
        val found = best.values.sortedBy { f -> f.candidate.entries.min() }
        return ImportResult(
            matched = found.map { f -> ImportMatch(f.hit.talk, confidence(f.names), excerpt(f.candidate.text)) },
            unmatchedCount = entriesWithCandidates.count { it !in matchedEntries },
            extractedChars = extractedChars,
        )
    }

    companion object {
        private const val TITLE_MIN_MATCH = "3<75%"
        private const val K1 = 1.2
        private const val B = 0.75
        const val EXACT_TITLE = "exact_title"
        const val TITLE_WORDS = "title_words"
        const val SPEAKER = "speaker"
        const val TIME = "time"

        /** The confidence label from the named queries that matched, across every candidate that found the talk. */
        fun confidence(names: Set<String>): ImportConfidence = when {
            EXACT_TITLE in names -> ImportConfidence.ExactTitle
            SPEAKER in names -> ImportConfidence.TitleAndSpeaker
            TIME in names -> ImportConfidence.TitleAndTime
            else -> ImportConfidence.TitleWords
        }

        /** At most 160 characters of the requester's own line, cut at a word when one is near the end. */
        fun excerpt(text: String): String {
            if (text.length <= EXCERPT_MAX) return text
            val cut = text.substring(0, EXCERPT_MAX)
            val space = cut.lastIndexOf(' ')
            return (if (space > EXCERPT_MAX * 0.6) cut.substring(0, space) else cut) + "…"
        }
    }
}
