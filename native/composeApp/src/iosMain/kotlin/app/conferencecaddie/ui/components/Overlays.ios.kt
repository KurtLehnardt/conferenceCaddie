package app.conferencecaddie.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.window.DialogProperties

internal actual fun confirmDialogProperties(dismissOnScrim: Boolean, scrim: Color): DialogProperties =
    DialogProperties(dismissOnClickOutside = dismissOnScrim, usePlatformDefaultWidth = false, scrimColor = scrim)

/** On iOS the dialog's properties carry the scrim colour. */
@Composable
internal actual fun DialogScrim(scrim: Color) = Unit
