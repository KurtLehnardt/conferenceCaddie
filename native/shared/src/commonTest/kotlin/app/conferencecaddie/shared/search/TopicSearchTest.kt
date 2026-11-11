package app.conferencecaddie.shared.search

import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.fixtures.Fixtures
import app.conferencecaddie.shared.fixtures.Fixtures.A
import app.conferencecaddie.shared.fixtures.Fixtures.B
import app.conferencecaddie.shared.fixtures.Fixtures.C
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// The topic picker's lists and the evidence passages, over the fixture bundle (topics Kubernetes
// with the alias k8s and 2 talks, MCP and Security with 1 each).
class TopicSearchTest {
    private val bundle = TalkBundle.decode(Fixtures.HASH, Fixtures.files.getValue("bundle.json"))!!

    private fun ids(list: List<app.conferencecaddie.shared.bundle.Topic>) = list.map { it.topicId }

    @Test
    fun commonTopicsFollowTheirRank() {
        assertEquals(listOf("kubernetes", "mcp", "security"), ids(TopicSearch.common(bundle)))
    }

    @Test
    fun typeAheadMatchesWordPrefixesOfLabelsAndAliases() {
        assertEquals(listOf("kubernetes"), ids(TopicSearch.typeAhead(bundle, "kube")))
        assertEquals(listOf("kubernetes"), ids(TopicSearch.typeAhead(bundle, "K8")), "aliases count, case does not")
        assertEquals(listOf("security"), ids(TopicSearch.typeAhead(bundle, "  Secur ")))
        // Any word may match (the last one as a prefix); equal scores go to the topic with more talks.
        assertEquals(listOf("kubernetes", "mcp"), ids(TopicSearch.typeAhead(bundle, "mcp kub")))
        assertEquals(emptyList(), TopicSearch.typeAhead(bundle, "zzz"))
        assertEquals(emptyList(), TopicSearch.typeAhead(bundle, " "))
    }

    @Test
    fun suggestionsPutTheTopicsOfMarkedTalksFirst() {
        assertEquals(listOf("kubernetes"), ids(TopicSearch.suggest(bundle, listOf(B, C), "")))
        assertEquals(listOf("kubernetes", "mcp", "security"), ids(TopicSearch.suggest(bundle, listOf(B, C, A), "")), "most common first")
        assertEquals(listOf("security"), ids(TopicSearch.suggest(bundle, emptyList(), "security for my agents")))
        assertEquals(listOf("kubernetes", "security"), ids(TopicSearch.suggest(bundle, listOf(B), "security")), "a marked talk's topic outranks a text match")
        assertEquals(emptyList(), TopicSearch.suggest(bundle, listOf(Fixtures.LUNCH), "the and"), "breaks carry no topics; stop words match nothing")
    }

    @Test
    fun evidenceIsTheAbstractAroundTheFirstMatchElseItsStartElseTheTitle() {
        val a = bundle.talksById.getValue(A)
        assertEquals("Threat models, tool permissions and audit logs for MCP servers.", Evidence.forTalk(a, "audit"))
        val b = bundle.talksById.getValue(B)
        assertEquals("Kubernetes for beginners", Evidence.forTalk(b, "kubernetes"), "a talk without an abstract shows its title")

        val long = a.copy(abstract = "Intro sentence. ".repeat(20) + "The scheduler places pods on cheap power. " + "Outro words here. ".repeat(20))
        val fragment = Evidence.forTalk(long, "scheduling")
        assertTrue(fragment.startsWith("…The scheduler places pods"), fragment)
        assertTrue(fragment.endsWith("…") && fragment.length <= Evidence.FRAGMENT + 2, fragment)
        assertTrue(Evidence.forTalk(long, "unrelated").startsWith("Intro sentence."), "no match: the start of the abstract")
    }

    @Test
    fun passageIsTheSentenceSharingMostWordsWithTheText() {
        val t: Talk = bundle.talksById.getValue(A).copy(
            abstract = "We run agents. Inference costs on GPUs were too high, so we cut GPU costs by half. Questions after.",
        )
        assertEquals("Inference costs on GPUs were too high, so we cut GPU costs by half.", Evidence.passage(t, "our GPU inference costs are too high"))
        assertEquals("We run agents.", Evidence.passage(t, "nothing in common"), "no shared word: the first sentence")
        assertEquals(null, Evidence.passage(bundle.talksById.getValue(B), "anything"))
    }
}
