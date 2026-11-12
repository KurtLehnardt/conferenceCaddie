package app.conferencecaddie.ui.people

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.people.ApiResult
import app.conferencecaddie.shared.people.PeopleError
import app.conferencecaddie.shared.people.PeopleText
import app.conferencecaddie.shared.people.PeopleUiState
import app.conferencecaddie.shared.people.Person
import app.conferencecaddie.ui.components.ButtonVariant
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.components.CaddieSheet
import app.conferencecaddie.ui.theme.Caddie
import kotlinx.coroutines.launch

/**
 * "Ask to talk shop" (web AskSheet.tsx, spec section 8), opened by `host.ask(person)` from U2's
 * card and drawn once by the People layer: the hint "To {name}. They see your name, your profile
 * and this note, and have 15 minutes to answer.", the Note field ([PeopleTextField], multiline, 140,
 * prefilled with `PeopleText.askPrefill(person)`, counter "{n} of 140"), Send
 * (`controller.ask(person, note, topicId)`; the errors by `PeopleError.kind`) and Cancel; once sent,
 * "Asked. You'll hear back here if they accept." and Done. A 409 `meet_open` also offers "Open
 * meet-up" for the meet the server named. Owner U3.
 */
@Composable
fun AskSheet(person: Person, state: PeopleUiState, host: PeopleHost, onClose: () -> Unit) {
    // The ask runs on the app's scope (PeopleHost.scope): the sheet can be closed, or the activity
    // re-created, while it is sent, and its answer then goes in a toast ([shown]). It runs once per
    // person at a time (PeopleHost.launchOnce), so a second tap, or a sheet opened again meanwhile,
    // sends one ask.
    val shown = rememberInComposition()
    val prefill = remember(person.ref) { PeopleText.askPrefill(person) }
    var note by rememberSaveable(person.ref) { mutableStateOf(prefill.first) }
    val busy = host.isRunning("ask:${person.ref}")
    var error by remember { mutableStateOf<String?>(null) }
    var openMeetId by remember { mutableStateOf<String?>(null) }
    // In the host's memory, which an answer after a re-creation still reaches (PeopleHost.askSent).
    val sent = host.askSent(person.ref)

    fun send() {
        val text = note.trim()
        if (text.isEmpty()) {
            error = ConnectStrings.NOTE_EMPTY
            return
        }
        if (host.isRunning("ask:${person.ref}")) return
        error = null
        openMeetId = null
        host.launchOnce("ask:${person.ref}") {
            val res = host.controller.ask(person, text, prefill.second)
            when (res) {
                is ApiResult.Ok -> {
                    host.markAskSent(person.ref)
                    // A toast only when no sheet shows "Asked": this one has gone, and none was
                    // opened for them again (as after a re-creation, where the sheet comes back).
                    if (!shown.value && host.askingRef != person.ref) host.showToast(ConnectStrings.ASKED)
                }
                is ApiResult.Failed -> {
                    val message = connectAskProblem(res.error)
                    val meetId = res.error.meetId?.takeIf { res.error.kind == PeopleError.Kind.MeetOpen }
                    when {
                        shown.value -> {
                            error = message
                            openMeetId = meetId
                        }
                        meetId != null -> host.showToast(message, PeopleToastAction(PeopleCommonStrings.OPEN_MEET_UP) { host.openMeet(meetId) })
                        else -> host.showMessage(message)
                    }
                }
            }
        }
    }

    CaddieSheet(title = ConnectStrings.ASK_TITLE, onClose = onClose, modifier = Modifier.testTag("ask-sheet")) {
        // .pp-ask-body: 14 dp between its parts, 16 dp below.
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            if (sent) {
                Text(
                    ConnectStrings.ASKED,
                    style = Caddie.type.stateBody.copy(fontWeight = FontWeight.SemiBold),
                    color = Caddie.colors.text,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(Caddie.colors.accentTint, RoundedCornerShape(Caddie.dimens.radius))
                        .padding(horizontal = 14.dp, vertical = 12.dp)
                        .semantics { liveRegion = LiveRegionMode.Polite },
                )
                CaddieButton(ConnectStrings.DONE, onClose, variant = ButtonVariant.Tonal)
            } else {
                HintText(ConnectStrings.askTo(person.displayName))
                PeopleTextField(
                    note,
                    {
                        note = it
                        error = null
                        openMeetId = null
                    },
                    ConnectStrings.NOTE,
                    hint = ConnectStrings.noteCount(note.length),
                    error = error,
                    maxLength = PeopleText.NOTE_MAX,
                    multiline = true,
                    fieldModifier = Modifier.testTag("ask-note"),
                )
                openMeetId?.let { id ->
                    CaddieButton(
                        PeopleCommonStrings.OPEN_MEET_UP,
                        {
                            onClose()
                            host.openMeet(id)
                        },
                        variant = ButtonVariant.Tonal,
                        small = true,
                    )
                }
                ActionsRow {
                    CaddieButton(if (busy) ConnectStrings.SENDING else ConnectStrings.SEND, ::send, Modifier.testTag("ask-send"), enabled = !busy)
                    CaddieButton(ConnectStrings.CANCEL, onClose, variant = ButtonVariant.Text)
                }
            }
        }
    }
}

/**
 * "Wave" (web PersonCard.tsx, spec section 4c): a one-tap ask to someone in my zone
 * (`controller.wave(person)`). On success it marks them waved (`host.markWaved`), so their card says
 * "Waved", and toasts "Waved. You'll hear back here."; a failure toasts the error, and a 409
 * `meet_open` is taken as the open meet (the controller notes it). Returns true when the wave was
 * sent. U2's [PersonCard] calls it while showing "Waving…". Owner U3.
 */
suspend fun sendWave(person: Person, host: PeopleHost): Boolean = when (val res = host.controller.wave(person)) {
    is ApiResult.Ok -> {
        host.markWaved(person.ref)
        host.showToast(ConnectStrings.WAVED)
        true
    }
    is ApiResult.Failed -> {
        host.showToast(connectAskProblem(res.error))
        false
    }
}

/** AskSheet.tsx problem(): the line for an ask or a wave the server refused. */
private fun connectAskProblem(error: PeopleError): String = when {
    error.kind == PeopleError.Kind.Filtered -> error.message
    error.status == 403 && error.code == "blocked" -> ConnectStrings.ASK_BLOCKED
    // Asks are now-only: these two carry the server's own wording.
    error.code == "not_around" || error.code == "presence_required" -> error.message
    error.status == 409 -> ConnectStrings.ASK_OPEN
    // 429, among them "paused" with the server's own words, and everything else.
    else -> error.message.ifBlank { ConnectStrings.NOT_SENT }
}
