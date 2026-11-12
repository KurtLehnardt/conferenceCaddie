package app.conferencecaddie.ui.people

import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.runtime.rememberCoroutineScope
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
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Profile (web ProfileScreen.tsx, spec section 12; the Profile page, with the labelled "‹ Settings"
 * Back the shell draws). It works offline: everything is kept on this device and saved to the server
 * only while the profile is visible or shared. Top to bottom:
 *
 * 1. The save status (`state.sync`: Saving…, Saved, or the error), right-aligned; edits save by
 *    themselves through `controller.updateProfile { ... }` and `controller.setTopics(...)`.
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
    val controller = host.controller
    val scope = rememberCoroutineScope()
    val scroll = rememberScrollState()
    val editor = remember(controller) { ProfileEditor(controller, state.profile, state.topics) }
    // A change the user did not type (a delete clearing the device, another conference's topics)
    // replaces what the fields show, once every edit has reached the controller.
    LaunchedEffect(editor, state.profile, state.topics) { editor.adopt(state.profile, state.topics) }

    // Edits are handed to the controller on the app's scope, so leaving the screen at once still
    // saves the last keystroke.
    fun edit(change: (ProfileDraft) -> ProfileDraft) {
        editor.fields = change(editor.fields)
        host.scope.launch { editor.push() }
    }

    fun setTopics(learn: List<TopicRef>? = null, speak: List<TopicRef>? = null) {
        val t = editor.topics
        editor.topics = ConferenceTopics(learn ?: t.learn, speak ?: t.speak)
        host.scope.launch { editor.push() }
    }

    var visBusy by remember { mutableStateOf(false) }
    // The switch shows the requested state while the first save, which can take a second or two,
    // is running. If the save fails it falls back to the stored state and the message says why.
    var visPending by remember { mutableStateOf<Boolean?>(null) }
    var visMessage by remember { mutableStateOf<String?>(null) }
    var confirmDelete by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf(false) }
    var deleteMessage by remember { mutableStateOf<String?>(null) }

    // The busy flags are set before the launch, so a second tap in the same frame starts nothing.
    fun toggleVisible(on: Boolean) {
        if (visBusy) return
        visBusy = true
        visPending = on
        scope.launch {
            editor.push()
            visMessage = controller.setOpenToMeet(on)
            visPending = null
            visBusy = false
        }
    }

    // The device's data goes only once the server has confirmed the delete for every conference.
    fun removeEverything() {
        if (deleting) return
        deleting = true
        deleteMessage = null
        scope.launch {
            editor.push()
            val result = controller.deleteMyProfile()
            if (result.done) confirmDelete = false
            deleteMessage = result.message
            deleting = false
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
        SaveStatus(state.sync)
        PendingDeleteBanner(state, host, scope, onResult = { deleteMessage = it })
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
            if (shared > 0) SharedTalksRow(shared, enabled = !visBusy) { scope.launch { controller.unshareAll()?.let { visMessage = it } } }
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
private data class ProfileDraft(
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
 * controller, one at a time and in order.
 */
@Stable
private class ProfileEditor(private val controller: PeopleController, profile: Profile, topics: ConferenceTopics) {
    var fields by mutableStateOf(ProfileDraft.of(profile))
    var topics by mutableStateOf(topics)
    private var sentFields = fields
    private var sentTopics = topics
    private val mutex = Mutex()

    /** Takes what the controller holds now, unless an edit has not reached it yet. */
    fun adopt(profile: Profile, topics: ConferenceTopics) {
        if (fields != sentFields || this.topics != sentTopics) return
        val f = ProfileDraft.of(profile)
        fields = f
        sentFields = f
        this.topics = topics
        sentTopics = topics
    }

    /** Hands the latest edits to the controller; returns once it has them. */
    suspend fun push() = mutex.withLock {
        val f = fields
        if (f != sentFields) {
            controller.updateProfile { f.applyTo(it) }
            sentFields = f
        }
        val t = topics
        if (t != sentTopics) {
            controller.setTopics(t.learn, t.speak)
            sentTopics = t
        }
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
 * SaveStatus: "Saving…", "Saved" or the error, nothing while idle. On the web the error line is
 * `.pp-status.pp-error`, and `.pp-status` comes later in people.css, so it renders 13 sp in the
 * secondary colour like the other two, not in red; this keeps that.
 */
@Composable
private fun SaveStatus(sync: SyncStatus) {
    val text = when (sync.state) {
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
private fun PendingDeleteBanner(state: PeopleUiState, host: PeopleHost, scope: CoroutineScope, onResult: (String) -> Unit) {
    val d = state.deletes
    if (!d.unfinished) return
    var busy by remember { mutableStateOf(false) }
    val all = d.deleteAll
    // As the web words it: "{n} conferences", this conference's name, or "another conference".
    val pending = d.pendingSlugs
    val where = when {
        pending.size > 1 -> ProfileStrings.conferences(pending.size)
        pending.isNotEmpty() && pending.first() == state.conference?.slug -> state.conference?.name ?: ProfileStrings.ANOTHER_CONFERENCE
        else -> ProfileStrings.ANOTHER_CONFERENCE
    }

    // On the profile screen's scope ([scope]), not one of the banner's own: a delete that finishes
    // takes the banner away as it publishes, before the action returns, which would cancel the
    // banner's scope and lose the result the Delete card shows. busy is set before the launch, so a
    // second tap in the same frame starts nothing.
    fun run(action: suspend () -> String?) {
        if (busy) return
        busy = true
        scope.launch {
            val result = try {
                action()
            } finally {
                busy = false
            }
            result?.let(onResult)
        }
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
