package app.conferencecaddie.ui.people

import app.conferencecaddie.shared.InMemorySecureStore
import app.conferencecaddie.shared.PeopleServices
import app.conferencecaddie.shared.people.ConferenceInfo
import app.conferencecaddie.shared.people.ConferenceTopics
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.PeopleKeyValue
import app.conferencecaddie.shared.people.Profile
import app.conferencecaddie.shared.people.TopicRef
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking

// Profile's editor, which outlives the screen: an edit that was not saved never lands on another
// conference's topics and does not outlive a delete of the profile.
class ProfileEditorTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @AfterTest
    fun cleanUp() {
        scope.cancel()
    }

    /** Records whose writes fail while [failWrites], as a full disk's do. */
    private class FlakyKeyValue : PeopleKeyValue {
        private val inner = MemoryKeyValue()

        @kotlin.concurrent.Volatile
        var failWrites = false

        override suspend fun get(key: String): String? = inner.get(key)

        override suspend fun set(key: String, value: String?) = if (failWrites) error("disk I/O error") else inner.set(key, value)
    }

    private val other = ConferenceInfo("other-conference-2026", "Other Conference")
    private val ebpf = listOf(TopicRef("ebpf", "eBPF"))
    private val k8s = listOf(TopicRef("kubernetes", "Kubernetes"))

    private fun controller(kv: PeopleKeyValue) =
        PeopleController(kv, emptyPeopleApi, PeopleServices(secureStore = InMemorySecureStore()), scope, allowLocalHttp = false)

    private fun PeopleController.editor() = state.value.let { ProfileEditor(this, it.profile, it.topics, it.conference?.slug) }

    private fun ProfileEditor.adopt(c: PeopleController) = c.state.value.let { adopt(it.profile, it.topics, it.conference?.slug) }

    @Test
    fun topicsNotSavedAtOneConferenceNeverLandOnAnother() = runBlocking {
        val kv = FlakyKeyValue()
        val c = controller(kv)
        c.updateContext(peopleContext())
        c.updateContext(peopleContext().copy(conference = other))
        check(c.setTopics(k8s, emptyList()) == null)
        c.updateContext(peopleContext())
        val editor = c.editor()

        // At the first conference a topic edit is not saved.
        kv.failWrites = true
        editor.topics = ConferenceTopics(learn = ebpf)
        assertEquals(PeopleCommonStrings.NOT_SAVED, editor.push())
        kv.failWrites = false

        // Another conference is selected: its own topics show, and the next push leaves them alone.
        c.updateContext(peopleContext().copy(conference = other))
        editor.adopt(c)
        assertEquals(k8s, editor.topics.learn)
        assertNull(editor.error)
        editor.fields = editor.fields.copy(about = "Platform engineer.")
        assertNull(editor.push())
        assertEquals(k8s, c.state.value.topics.learn)
        assertEquals("Platform engineer.", c.state.value.profile.about)

        // A push still under way when the conference changed is refused rather than stored there.
        c.updateContext(peopleContext())
        val stale = c.editor()
        c.updateContext(peopleContext().copy(conference = other))
        stale.topics = ConferenceTopics(learn = ebpf)
        assertEquals(PeopleCommonStrings.NOT_SAVED, stale.push())
        assertEquals(k8s, c.state.value.topics.learn)
        c.close()
    }

    @Test
    fun aDeleteOfTheProfileTakesTheTextThatWasNotSavedWithIt() = runBlocking {
        val kv = FlakyKeyValue()
        val c = controller(kv)
        c.updateContext(peopleContext())
        check(c.updateProfile { it.copy(displayName = "Jordan Rivera", about = "Platform engineer.") } == null)
        val editor = c.editor()

        kv.failWrites = true
        editor.fields = editor.fields.copy(contactNote = "+1 555 0100")
        assertEquals(PeopleCommonStrings.NOT_SAVED, editor.push())

        // The profile is deleted (here or by its retry): the editor shows the empty profile, and the
        // next edit writes nothing of what was typed before.
        editor.adopt(Profile.EMPTY, ConferenceTopics(), c.state.value.conference?.slug)
        assertEquals(ProfileDraft(), editor.fields)
        assertNull(editor.error)
        kv.failWrites = false
        editor.fields = editor.fields.copy(displayName = "Someone New")
        assertNull(editor.push())
        assertEquals("", c.state.value.profile.contactNote)
        assertEquals("", c.state.value.profile.about)
        c.close()
    }
}
