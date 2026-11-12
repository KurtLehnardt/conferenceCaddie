package app.conferencecaddie.ui.people

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.conferencecaddie.shared.people.ApiResult
import app.conferencecaddie.shared.people.PeopleError
import app.conferencecaddie.shared.people.ReportReason
import app.conferencecaddie.ui.components.ButtonVariant
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.components.CaddieSheet
import app.conferencecaddie.ui.strings.Strings
import kotlinx.coroutines.launch

/**
 * ReportSheet (web ReportSheet.tsx, spec section 11), opened by `host.report(target)` from a person's
 * card (U2) or Meet up (U3) and drawn once by the People layer: "Report {name}", the hint "What's
 * wrong with {their profile | their spot line | this meet-up}? They are not told who reported.",
 * the five reasons as [RadioRow]s in the [RadioVariant.Option] variant (48 dp, nothing chosen at
 * first), the two-reports hint or the error, and Report (red; "Sending…" while it is sent) and
 * Cancel. Report without a reason says "Pick a reason."; with one it sends
 * `controller.report(target.ref, target.kind, target.id, reason)`, then toasts "Thanks. We'll look at
 * it." and closes. The report is sent from the app's scope, so closing the sheet meanwhile does not
 * stop it, as on the web. Owner U2.
 */
@Composable
fun ReportSheet(target: ReportTarget, host: PeopleHost, onClose: () -> Unit) {
    var reason by remember(target) { mutableStateOf<ReportReason?>(null) }
    var error by remember(target) { mutableStateOf<String?>(null) }
    val close by rememberUpdatedState(onClose)
    // One report at a time (PeopleHost.launchOnce), also across a sheet opened again meanwhile; an
    // error after the sheet has gone goes in a toast ([shown]).
    val busy = host.isRunning("report")
    val shown = rememberInComposition()

    val send: () -> Unit = send@{
        val chosen = reason
        if (chosen == null) {
            error = PeopleStrings.PICK_A_REASON
            return@send
        }
        if (host.isRunning("report")) return@send
        error = null
        host.launchOnce("report") {
            when (val res = host.controller.report(target.ref, target.kind, target.id, chosen)) {
                is ApiResult.Ok -> {
                    host.showToast(PeopleStrings.REPORT_THANKS)
                    close()
                }
                is ApiResult.Failed -> {
                    val message = reportProblem(res.error)
                    if (shown.value) error = message else host.showMessage(message)
                }
            }
        }
    }

    CaddieSheet(title = PeopleStrings.reportTitle(target.name), onClose = onClose, modifier = Modifier.testTag("report-sheet")) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            HintText(PeopleStrings.reportQuestion(target.kind))
            Column(Modifier.fillMaxWidth().selectableGroup().semantics { contentDescription = PeopleStrings.REPORT_REASON }) {
                PeopleStrings.REPORT_REASONS.forEach { (value, label) ->
                    RadioRow(
                        label,
                        selected = reason == value,
                        onClick = {
                            reason = value
                            if (error != null) error = null
                        },
                        modifier = Modifier.testTag("report-reason-${value.name.lowercase()}"),
                        variant = RadioVariant.Option,
                    )
                }
            }
            val message = error
            if (message != null) ErrorText(message) else HintText(PeopleStrings.REPORT_HINT)
            ActionsRow {
                CaddieButton(
                    if (busy) PeopleStrings.SENDING else PeopleCommonStrings.REPORT,
                    send,
                    Modifier.testTag("report-send"),
                    variant = ButtonVariant.Danger,
                    enabled = !busy,
                )
                CaddieButton(Strings.Common.CANCEL, onClose, variant = ButtonVariant.Text)
            }
        }
    }
}

/** ReportSheet.tsx problem(): 404 and a missing profile have their own words; else the error's own line. */
internal fun reportProblem(error: PeopleError): String = when {
    error.status == 404 -> PeopleStrings.REPORT_NOT_FOUND
    error.status == 403 && error.code == "profile_required" -> PeopleStrings.REPORT_PROFILE_REQUIRED
    else -> error.message.ifBlank { PeopleStrings.REPORT_NOT_SENT }
}
