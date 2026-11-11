package app.conferencecaddie.ui.components

import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.window.DialogProperties

// Without the platform insets the dialog spans the whole screen; the content pads for the safe area.
@OptIn(ExperimentalComposeUiApi::class)
internal actual fun fullScreenDialogProperties(scrim: Color): DialogProperties =
    DialogProperties(usePlatformDefaultWidth = false, usePlatformInsets = false, scrimColor = scrim)

@androidx.compose.runtime.Composable
internal actual fun FullScreenDialogBars(dark: Boolean) = Unit
