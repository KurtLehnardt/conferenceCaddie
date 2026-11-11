package app.conferencecaddie.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.window.DialogProperties

/**
 * The properties of a dialog that covers the whole window, system bars included (the web's
 * full-screen sheet, which reaches under the status bar and pads its content clear of it). The
 * content keeps clear of the insets itself. [scrim] dims what is behind it where the dialog does not
 * cover the window (a wide window, where it is a centred card).
 */
internal expect fun fullScreenDialogProperties(scrim: Color): DialogProperties

/**
 * Inside such a dialog's content: the system bars' icons dark on a light theme and light on a dark
 * one, as the app's own window has them. On Android a dialog has a window of its own, whose bars
 * would otherwise keep the default light icons over the white sheet; on iOS the status bar follows
 * the app's window, so this does nothing.
 */
@androidx.compose.runtime.Composable
internal expect fun FullScreenDialogBars(dark: Boolean)
