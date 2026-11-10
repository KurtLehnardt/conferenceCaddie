package app.conferencecaddie.ui.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import app.conferencecaddie.ui.components.ConfirmDialog
import app.conferencecaddie.ui.components.LucideImage
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie

/**
 * The confirmation before the app switches to another server (docs/contracts/capabilities.md,
 * "Backend URLs and switching backends"). Its question names the server's base URL exactly, origin
 * and path, so two tier 1 sites on one origin cannot be confused; a server that is not the build's
 * official one gets a warning. Nothing changes unless the person taps Switch.
 *
 * It serves both a server typed in Settings and a `caddie://connect?url=...` link or QR code.
 * TODO(phase 2c): register the caddie:// scheme (Android intent filter, iOS URL type), parse links
 * with ConnectLink.parse() in :shared, and put the base into ShellState.pendingConnect.
 */
@Composable
fun ConnectConfirmation(base: String, official: Boolean, onConfirm: () -> Unit, onDecline: () -> Unit) {
    ConfirmDialog(
        title = Strings.Connect.TITLE,
        body = null,
        confirmLabel = Strings.Connect.SWITCH,
        onConfirm = onConfirm,
        onDismiss = onDecline,
        destructive = false,
        // No tap on the scrim answers this question; Cancel, Switch and the system Back do.
        dismissOnScrim = false,
        testTag = "connect-confirmation",
    ) {
        ConnectDetails(base, official)
    }
}

/** The confirmation's question, the warning for a server that is not the official one, and the note. */
@Composable
internal fun ColumnScope.ConnectDetails(base: String, official: Boolean) {
    Text(
        Strings.Connect.prompt(base),
        style = Caddie.type.stateBody,
        color = Caddie.colors.text,
        modifier = Modifier.padding(top = 8.dp).testTag("connect-prompt"),
    )
    if (!official) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(top = 12.dp)
                .background(Caddie.colors.dangerTint, RoundedCornerShape(Caddie.dimens.radius))
                .padding(12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.Top,
        ) {
            LucideImage(LucideIcon.TriangleAlert, null, size = 18.dp, tint = Caddie.colors.danger)
            Text(Strings.Connect.NOT_OFFICIAL, style = Caddie.type.meta, color = Caddie.colors.danger)
        }
    }
    Text(Strings.Connect.KEPT, style = Caddie.type.meta, color = Caddie.colors.text2, modifier = Modifier.padding(top = 12.dp))
}
