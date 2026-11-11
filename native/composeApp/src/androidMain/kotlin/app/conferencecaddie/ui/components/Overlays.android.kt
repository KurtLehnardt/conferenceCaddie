package app.conferencecaddie.ui.components

import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider

internal actual fun confirmDialogProperties(dismissOnScrim: Boolean, scrim: Color): DialogProperties =
    DialogProperties(dismissOnClickOutside = dismissOnScrim, usePlatformDefaultWidth = false)

/** Android dims behind a dialog's window by an amount of black: the scrim's alpha (0.4 light, 0.6 dark). */
@Composable
internal actual fun DialogScrim(scrim: Color) {
    val window = (LocalView.current.parent as? DialogWindowProvider)?.window ?: return
    SideEffect { window.setDimAmount(scrim.alpha) }
}
