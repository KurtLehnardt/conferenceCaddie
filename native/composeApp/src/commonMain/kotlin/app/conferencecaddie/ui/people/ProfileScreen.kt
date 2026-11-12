package app.conferencecaddie.ui.people

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.people.ConferenceTopics
import app.conferencecaddie.shared.people.PeopleAvailability
import app.conferencecaddie.shared.people.PeopleController
import app.conferencecaddie.shared.people.PeopleUiState
import app.conferencecaddie.shared.people.Profile
import app.conferencecaddie.shared.people.StopTryingReason
import app.conferencecaddie.shared.people.SyncStatus
import app.conferencecaddie.shared.people.TopicRef
import app.conferencecaddie.ui.components.ButtonVariant
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Profile (web ProfileScreen.tsx, spec section 12; the Profile page, with the labelled Back the shell
 * draws: "‹ Settings", or the name of the tab it was opened from). It works offline: everything is
 * kept on this device and saved to the server only while the profile is visible or shared. While the
 * people records could not be opened it is the People tab's message with "Try again" instead, and
 * nothing while they open. Top to bottom:
 *
 * 1. The save status (`state.sync`: Saving…, Saved, or the error), right-aligned; edits save by
 *    themselves through `controller.updateProfile { ... }` and `controller.setTopics(...)`, and an
 *    edit this device could not keep shows their message here instead, its text left in the field.
 * 2. The pending-delete banner while `state.deletes.unfinished` ([PendingDeleteBanner]).
 * 3. The hidden banner while `state.visibility.hiddenForOwner` (EyeOff).
 * 4. "About you": Name (60) and About me (280).
 * 5. and 6. The two [TopicPicker]s ("I want to learn about", "I can speak to"; at most 30 each),
 *    choosing from `talks.bundle` and suggesting from `talks.interested` and the free text, each
 *    with its free-text field (500). "Find people who've done this" on a held chip is
 *    `host.openPeople(PeopleRequest(query = label))`.
 * 7. "How to reach me": LinkedIn link (200, checked as the server checks it) and Another way to
 *    reach me (120).
 * 8. "Visibility": the switch (`controller.setOpenToMeet(on)`, its String? the failure line, the
 *    requested state shown while it saves), [PeopleCommonStrings.VISIBILITY_NOTICE], and "Stop
 *    sharing for all talks" while the profile is shared for talks (`controller.unshareAll()`).
 * 9. "Delete": "Delete my profile" (a text button in the accent ink, as the web renders it) opens an
 *    inline notice, not a dialog, whose red "Delete my profile" runs `controller.deleteMyProfile()`
 *    and shows its message; on a failure the notice stays open, so the same button tries again.
 *
 * The web's ImportGitHub row under About me is out of scope for the native apps.
 */
@Composable
fun ProfileScreen(state: PeopleUiState, host: PeopleHost, talks: PeopleTalks, modifier: Modifier = Modifier) {
    // While the records could not be opened, the People tab's message and "Try again", not fields
    // whose edits nothing could keep. Until they are open there is no profile to edit either (the
    // People tab shows nothing meanwhile): a draft typed over the empty profile would replace the
    // stored one once they open.
    if (state.sessionFailed) {
        PeopleSessionFailed(host, modifier)
        return
    }
    if (state.availability == PeopleAvailability.Loading) {
        Box(modifier.fillMaxSize().testTag("profile-loading"))
        return
    }

    val controller = host.controller
    val scroll = rememberScrollState()
    // Kept in the host's memory, so an edit that was not saved is still here after the activity's
    // re-creation or when Profile is opened again; it takes what the controller holds now unless it
    // has such an edit.
    val slug = state.conference?.slug
    val editor = remember(host, state.backend) {
        host.profileEditor(state.backend) { ProfileEditor(controller, state.profile, state.topics, slug) }.also { it.adopt(state.profile, state.topics, slug) }
    }
    // A change the user did not type (a delete clearing the device, another conference's topics)
    // replaces what the fields or the pickers show, once their edits have reached the controller.
    LaunchedEffect(editor, state.profile, state.topics, slug) { editor.adopt(state.profile, state.topics, slug) }

    val visBusy = host.isRunning(VISIBILITY_ACTION)
    // The switch shows the requested state while the first save, which can take a second or two,
    // is running. If the save fails it falls back to the stored state and the message says why.
    var visPending by remember { mutableStateOf<Boolean?>(null) }
    var visMessage by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    val deleting = host.isRunning(DELETE_ACTION)
    var deleteMessage by remember { mutableStateOf<String?>(null) }
    // The actions run on the app's scope (PeopleHost.scope), not this screen's: Back, another tab or
    // the activity's re-creation while one is under way would cancel its caller and lose its answer,
    // which goes in a toast once the screen has left ([shown]). They run one at a time under a name
    // (PeopleHost.launchOnce), so a second tap in the same frame, or on a screen that came back while
    // the first was under way, starts nothing.
    val shown = rememberInComposition()

    /** [message] where this screen shows it, or in a toast once the screen has left. */
    fun answer(message: String, show: (String) -> Unit) {
        if (shown.value) show(message) else host.showMessage(message)
    }

    // Edits are handed to the controller on the app's scope, so leaving the screen at once still
    // saves the last keystroke. An edit the controller could not keep stays in its field and the
    // save status says so ([ProfileEditor.error]); once the screen has left, one toast says so.
    // Every keystroke is handed over, in order (ProfileEditor.push), so none waits behind launchOnce.
    fun save() {
        host.scope.launch {
            val message = editor.push() ?: return@launch
            if (!shown.value && editor.tellOnce()) {
                host.showToast(message, PeopleToastAction(PeopleCommonStrings.OPEN_PROFILE, host::openProfile))
            }
        }
    }

    fun edit(change: (ProfileDraft) -> ProfileDraft) {
        editor.fields = change(editor.fields)
        save()
    }

    fun setTopics(learn: List<TopicRef>? = null, speak: List<TopicRef>? = null) {
        val t = editor.topics
        editor.topics = ConferenceTopics(learn ?: t.learn, speak ?: t.speak)
        save()
    }

    // An edit that was not saved is tried again when Profile shows again.
    LaunchedEffect(editor) { if (editor.error != null) save() }

    fun toggleVisible(on: Boolean) {
        if (host.isRunning(VISIBILITY_ACTION)) return
        visPending = on
        host.launchOnce(VISIBILITY_ACTION) {
            val err = try {
                editor.push()
                controller.setOpenToMeet(on)
            } finally {
                visPending = null
            }
            visMessage = null
            if (err != null) answer(err) { visMessage = it }
        }
    }

    // "Stop sharing for all" runs on the app's scope (PeopleHost.scope): leaving Profile meanwhile
    // loses no message, which goes in a toast once the screen has left ([shown]).
    fun stopSharing() {
        if (host.isRunning(VISIBILITY_ACTION)) return
        visMessage = null
        host.launchOnce(VISIBILITY_ACTION) {
            val err = controller.unshareAll()
            if (err != null) answer(err) { visMessage = it }
        }
    }

    // The device's data goes only once the server has confirmed the delete for every conference.
    fun removeEverything() {
        if (host.isRunning(DELETE_ACTION)) return
        deleteMessage = null
        host.launchOnce(DELETE_ACTION) {
            editor.push()
            val result = controller.deleteMyProfile()
            if (result.done) confirmDelete = false
            result.message?.let { m -> answer(m) { deleteMessage = it } }
        }
    }

    val fields = editor.fields
    val conferenceName = state.conference?.name ?: ""
    val findPeople: (TopicRef) -> Unit = { host.openPeople(PeopleRequest(query = it.label)) }
    val shift: (Float) -> Unit = { scroll.dispatchRawDelta(it) }

    Column(
        // The keyboard shrinks the scrolling area, so the field being typed in scrolls into view.
        modifier.fillMaxSize().imePadding().verticalScroll(scroll).padding(PeopleScreenPadding).testTag("profile-screen"),
        verticalArrangement = Arrangement.spacedBy(PeopleScreenGap),
    ) {
        SaveStatus(state.sync, editor.error)
        PendingDeleteBanner(state, host, onResult = { m -> answer(m) { deleteMessage = it } })
        if (state.visibility.hiddenForOwner) {
            PeopleBanner(LucideIcon.EyeOff, Modifier.testTag("profile-hidden-banner"), announce = true) {
                Text(boldLead(ProfileStrings.HIDDEN_TITLE, ProfileStrings.HIDDEN_COPY))
            }
        }

        PeopleCard(Modifier.testTag("profile-about"), title = ProfileStrings.ABOUT_YOU) {
            PeopleTextField(
                fields.displayName,
                { v -> edit { it.copy(displayName = v) } },
                ProfileStrings.NAME,
                placeholder = ProfileStrings.NAME_PLACEHOLDER,
                maxLength = 60,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words),
                fieldModifier = Modifier.testTag("profile-name"),
            )
            PeopleTextField(
                fields.about,
                { v -> edit { it.copy(about = v) } },
                ProfileStrings.ABOUT_ME,
                placeholder = ProfileStrings.ABOUT_PLACEHOLDER,
                maxLength = 280,
                multiline = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                fieldModifier = Modifier.testTag("profile-about-me"),
            )
        }

        PeopleCard(Modifier.testTag("profile-learn")) {
            TopicPicker(
                ProfileStrings.LEARN_TITLE,
                editor.topics.learn,
                { setTopics(learn = it) },
                talks.bundle,
                suggestText = fields.interests,
                talkIds = talks.interested,
                onFindPeople = findPeople,
                onShift = shift,
                tag = "picker-learn",
            )
            PeopleTextField(
                fields.interests,
                { v -> edit { it.copy(interests = v) } },
                ProfileStrings.INTERESTS_LABEL,
                placeholder = ProfileStrings.INTERESTS_PLACEHOLDER,
                hint = ProfileStrings.SPECIFIC_HINT,
                maxLength = 500,
                multiline = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                fieldModifier = Modifier.testTag("profile-interests"),
            )
        }

        PeopleCard(Modifier.testTag("profile-speak")) {
            TopicPicker(
                ProfileStrings.SPEAK_TITLE,
                editor.topics.speak,
                { setTopics(speak = it) },
                talks.bundle,
                suggestText = fields.expertise,
                talkIds = emptyList(),
                onFindPeople = findPeople,
                onShift = shift,
                tag = "picker-speak",
            )
            PeopleTextField(
                fields.expertise,
                { v -> edit { it.copy(expertise = v) } },
                ProfileStrings.EXPERTISE_LABEL,
                placeholder = ProfileStrings.EXPERTISE_PLACEHOLDER,
                hint = ProfileStrings.SPECIFIC_HINT,
                maxLength = 500,
                multiline = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                fieldModifier = Modifier.testTag("profile-expertise"),
            )
        }

        PeopleCard(Modifier.testTag("profile-reach"), title = ProfileStrings.REACH_TITLE) {
            HintText(ProfileStrings.REACH_HINT)
            PeopleTextField(
                fields.linkedinUrl,
                { v -> edit { it.copy(linkedinUrl = v) } },
                ProfileStrings.LINKEDIN_LABEL,
                placeholder = ProfileStrings.LINKEDIN_PLACEHOLDER,
                error = if (linkedinMalformed(fields.linkedinUrl)) ProfileStrings.LINKEDIN_INVALID else null,
                maxLength = 200,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Uri),
                fieldModifier = Modifier.testTag("profile-linkedin"),
            )
            PeopleTextField(
                fields.contactNote,
                { v -> edit { it.copy(contactNote = v) } },
                ProfileStrings.CONTACT_LABEL,
                placeholder = ProfileStrings.CONTACT_PLACEHOLDER,
                maxLength = 120,
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false),
                fieldModifier = Modifier.testTag("profile-contact"),
            )
        }

        PeopleCard(Modifier.testTag("profile-visibility"), title = ProfileStrings.VISIBILITY_TITLE) {
            PeopleSwitchRow(
                ProfileStrings.visibleAt(conferenceName),
                checked = visPending ?: state.visibility.openToMeet,
                onChange = ::toggleVisible,
                enabled = !visBusy,
                modifier = Modifier.testTag("profile-visible"),
            )
            if (visBusy) StatusLine(ProfileStrings.SAVING)
            NoticeText(PeopleCommonStrings.VISIBILITY_NOTICE)
            val shared = state.visibility.sharedTalkIds.size
            if (shared > 0) SharedTalksRow(shared, enabled = !visBusy, onStop = ::stopSharing)
            visMessage?.let { ErrorText(it, Modifier.testTag("profile-visibility-message")) }
        }

        PeopleCard(Modifier.testTag("profile-delete-card"), title = ProfileStrings.DELETE_TITLE) {
            if (!confirmDelete) {
                // .pp-danger renders in the accent ink with the plain button padding on the web.
                CaddieButton(
                    ProfileStrings.DELETE_MY_PROFILE,
                    { confirmDelete = true },
                    Modifier.testTag("profile-delete"),
                    variant = ButtonVariant.Text,
                    icon = LucideIcon.Trash2,
                )
            } else {
                PeopleNotice(Modifier.testTag("profile-delete-confirm")) {
                    Text(ProfileStrings.DELETE_CONFIRM)
                    ActionsRow {
                        CaddieButton(
                            if (deleting) ProfileStrings.DELETING else ProfileStrings.DELETE_MY_PROFILE,
                            ::removeEverything,
                            Modifier.testTag("profile-delete-now"),
                            variant = ButtonVariant.Danger,
                            small = true,
                            enabled = !deleting,
                        )
                        CaddieButton(Strings.Common.CANCEL, { confirmDelete = false }, variant = ButtonVariant.Text, small = true)
                    }
                }
            }
            deleteMessage?.let {
                Text(
                    it,
                    style = Caddie.type.meta,
                    color = Caddie.colors.text2,
                    modifier = Modifier.testTag("profile-delete-message").semantics { liveRegion = LiveRegionMode.Polite },
                )
            }
        }
    }
}

/** The profile's free-text fields as the user typed them. */
@Immutable
internal data class ProfileDraft(
    val displayName: String = "",
    val about: String = "",
    val interests: String = "",
    val expertise: String = "",
    val linkedinUrl: String = "",
    val contactNote: String = "",
) {
    fun applyTo(p: Profile): Profile = p.copy(
        displayName = displayName,
        about = about,
        interests = interests,
        expertise = expertise,
        linkedinUrl = linkedinUrl,
        contactNote = contactNote,
    )

    companion object {
        fun of(p: Profile) = ProfileDraft(p.displayName, p.about, p.interests, p.expertise, p.linkedinUrl, p.contactNote)
    }
}

/**
 * What Profile's fields and topic pickers show, ahead of the controller: the controller's actions
 * are suspend functions, so a field bound to its state straight away would lose keystrokes typed
 * while one is on its way. Every edit lands here first and [push] hands the latest to the
 * controller, one at a time and in order. An edit the controller could not keep stays here, unsent,
 * and goes with the next push.
 */
@Stable
internal class ProfileEditor(private val controller: PeopleController, profile: Profile, topics: ConferenceTopics, slug: String?) {
    var fields by mutableStateOf(ProfileDraft.of(profile))
    var topics by mutableStateOf(topics)

    // The conference [topics] belong to: topics picked at one conference are never set at another.
    private var topicsSlug = slug

    /** The controller's message for the last edit it could not keep, until a push has handed every edit over. */
    var error by mutableStateOf<String?>(null)
        private set
    private var sentFields = fields
    private var sentTopics = topics
    private val mutex = Mutex()

    // Whether a toast has said that an edit was not saved since the last one that was.
    @kotlin.concurrent.Volatile
    private var told = false

    /** True the first time it is asked after an edit was not saved, for the one toast that says so. */
    fun tellOnce(): Boolean {
        if (told) return false
        told = true
        return true
    }

    /**
     * Takes what the controller holds now for the fields, and for the topics of the conference
     * [slug], each unless an edit of it has not reached the controller yet. The topics of another
     * conference than the one picked at are replaced all the same (an edit of them is dropped), and
     * so is everything once the profile was deleted: no text typed before a delete outlives it.
     */
    fun adopt(profile: Profile, topics: ConferenceTopics, slug: String?) {
        val f = ProfileDraft.of(profile)
        val wiped = f == ProfileDraft() && sentFields != ProfileDraft()
        if (wiped || fields == sentFields) {
            fields = f
            sentFields = f
        }
        if (wiped || slug != topicsSlug || this.topics == sentTopics) {
            this.topics = topics
            sentTopics = topics
            topicsSlug = slug
        }
        if (fields == sentFields && this.topics == sentTopics) {
            error = null
            told = false
        }
    }

    /**
     * Hands the latest edits to the controller; returns null once it has kept them, or its message
     * when it could not ([error]), the edit then waiting for the next push.
     */
    suspend fun push(): String? = mutex.withLock {
        val f = fields
        if (f != sentFields) {
            controller.updateProfile { f.applyTo(it) }?.let { return@withLock failed(it) }
            sentFields = f
        }
        val t = topics
        if (t != sentTopics) {
            controller.setTopics(t.learn, t.speak, conference = topicsSlug)?.let { return@withLock failed(it) }
            sentTopics = t
        }
        error = null
        told = false
        null
    }

    private fun failed(message: String): String {
        error = message
        return message
    }
}

/**
 * True when [url] is not empty and not a LinkedIn profile link as the server accepts it. The rule
 * is the controller's own (`profileProblem`), asked with a name so only the link is judged.
 */
private fun linkedinMalformed(url: String): Boolean =
    url.isNotBlank() && PeopleController.profileProblem(Profile(displayName = "-", linkedinUrl = url)) != null

/** "**[lead]** [rest]": a bold first sentence, as the web's `<strong>`. */
private fun boldLead(lead: String, rest: String): AnnotatedString = buildAnnotatedString {
    withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(lead) }
    append(" ")
    append(rest)
}

/**
 * SaveStatus: "Saving…", "Saved" or the error, nothing while idle; [editError], an edit this device
 * could not keep, comes before them. On the web the error line is `.pp-status.pp-error`, and
 * `.pp-status` comes later in people.css, so it renders 13 sp in the secondary colour like the
 * other two, not in red; this keeps that.
 */
@Composable
private fun SaveStatus(sync: SyncStatus, editError: String?) {
    val text = editError ?: when (sync.state) {
        SyncStatus.State.Saving -> ProfileStrings.SAVING
        SyncStatus.State.Saved -> ProfileStrings.SAVED
        SyncStatus.State.Error -> sync.message ?: ProfileStrings.COULD_NOT_SAVE
        SyncStatus.State.Idle -> return
    }
    StatusLine(text, Modifier.testTag("profile-save-status"))
}

/** .pp-status: a 13 sp secondary line, right-aligned, at least 20 dp tall, read out as it changes. */
@Composable
private fun StatusLine(text: String, modifier: Modifier = Modifier) {
    Text(
        text,
        style = Caddie.type.note,
        color = Caddie.colors.text2,
        textAlign = TextAlign.End,
        modifier = modifier.fillMaxWidth().heightIn(min = 20.dp).semantics { liveRegion = LiveRegionMode.Polite },
    )
}

/** .pp-actions.pp-shared-row: "You also share your profile for {n} talks." and "Stop sharing for all talks" at either end. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SharedTalksRow(count: Int, enabled: Boolean, onStop: () -> Unit) {
    FlowRow(
        Modifier.fillMaxWidth().testTag("profile-shared-row"),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalArrangement = Arrangement.spacedBy(8.dp),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        HintText(ProfileStrings.alsoShared(count))
        CaddieButton(ProfileStrings.STOP_SHARING_ALL_TALKS, onStop, variant = ButtonVariant.Text, small = true, enabled = enabled)
    }
}

/**
 * PendingDelete: while a profile delete is unfinished, the warning banner (TriangleAlert, read out
 * as it appears) with what is held back, the reason the last attempt failed, and, once the delete
 * is stuck, why stopping may help and what it leaves behind. "Try again" runs the whole "Delete my
 * profile" again after that delete (so the device's data goes too), else
 * `controller.finishPendingDeletes()`; "Stop trying on this device" is `controller.stopTrying()`, a
 * text button in the accent ink as the web renders it. What either reports goes to [onResult], so
 * the Delete card shows it.
 *
 * The web names the number of conferences when more than one copy is unfinished, and says the copy
 * "may already be hidden" whenever a conference's copy is pending; the controller reports only
 * whether the selected conference is covered, so this names the conference or "another conference",
 * and says "may already be hidden" for a conference's delete.
 */
@Composable
private fun PendingDeleteBanner(state: PeopleUiState, host: PeopleHost, onResult: (String) -> Unit) {
    val d = state.deletes
    if (!d.unfinished) return
    val busy = host.isRunning(DELETE_ACTION)
    val all = d.deleteAll
    // As the web words it: "{n} conferences", this conference's name, or "another conference".
    val pending = d.pendingSlugs
    val where = when {
        pending.size > 1 -> ProfileStrings.conferences(pending.size)
        pending.isNotEmpty() && pending.first() == state.conference?.slug -> state.conference?.name ?: ProfileStrings.ANOTHER_CONFERENCE
        else -> ProfileStrings.ANOTHER_CONFERENCE
    }

    // On the app's scope (PeopleHost.scope), not one of the banner's own: a delete that finishes
    // takes the banner away as it publishes, before the action returns, which would cancel the
    // banner's scope and lose the result the Delete card shows ([onResult], a toast once the
    // profile screen has left). It runs under the Delete card's name (PeopleHost.launchOnce), so a
    // second tap, or a delete from the card, waits for it.
    fun run(action: suspend () -> String?) {
        host.launchOnce(DELETE_ACTION) { action()?.let(onResult) }
    }

    PeopleBanner(
        LucideIcon.TriangleAlert,
        Modifier.testTag("profile-pending-delete"),
        announce = true,
        actions = {
            CaddieButton(
                if (busy) ProfileStrings.WORKING else ProfileStrings.TRY_AGAIN,
                {
                    run {
                        if (all) {
                            host.controller.deleteMyProfile().message
                        } else {
                            host.controller.finishPendingDeletes()
                            null
                        }
                    }
                },
                Modifier.testTag("profile-try-again"),
                variant = ButtonVariant.Tonal,
                small = true,
                enabled = !busy,
            )
            if (d.stopTryingReason != null) {
                CaddieButton(
                    ProfileStrings.STOP_TRYING,
                    { run { host.controller.stopTrying() } },
                    Modifier.testTag("profile-stop-trying"),
                    variant = ButtonVariant.Text,
                    small = true,
                    enabled = !busy,
                )
            }
        },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val lead = if (all) ProfileStrings.DELETING_UNFINISHED else ProfileStrings.removingUnfinished(where)
            val rest = (if (pending.isNotEmpty()) "${ProfileStrings.PENDING_HIDDEN_COPY} " else "") +
                if (all) ProfileStrings.PENDING_DELETE_COPY else ProfileStrings.PENDING_DELETE_ONE_COPY
            Text(boldLead(lead, rest))
            d.detail?.let { ErrorText(it) }
            d.stopTryingReason?.let { reason ->
                val why = if (reason == StopTryingReason.Forbidden) ProfileStrings.STOP_FORBIDDEN_COPY else ProfileStrings.STOP_FAILING_COPY
                HintText("$why ${if (all) ProfileStrings.STOP_ALL_COPY else ProfileStrings.STOP_ONE_COPY}")
            }
        }
    }
}

/** The name the visibility actions run under ([PeopleHost.launchOnce]), Profile's and the People home's prompt's. */
internal const val VISIBILITY_ACTION = "visibility"

/** The name the deletes run under ([PeopleHost.launchOnce]): Delete and the pending delete banner. */
private const val DELETE_ACTION = "delete"
