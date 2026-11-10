package app.conferencecaddie.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie

/**
 * .sheet: a bottom sheet with the web's handle, a header with [title] and a close button named
 * [closeLabel], a scrolling body, and an optional [footer] row above a hairline (the Filters sheet's
 * "Clear all" and "Show 12 talks").
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CaddieSheet(
    title: String,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    closeLabel: String = Strings.Common.CLOSE,
    footer: (@Composable RowScope.() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = Caddie.colors
    val d = Caddie.dimens
    ModalBottomSheet(
        onDismissRequest = onClose,
        // Opened fully, as the web's sheet is. The replacement API is still settling in Material3
        // 1.12 alphas, so the deprecated one stays until a stable release.
        sheetState = @Suppress("DEPRECATION") rememberModalBottomSheetState(skipPartiallyExpanded = true),
        shape = RoundedCornerShape(topStart = d.sheetRadius, topEnd = d.sheetRadius),
        containerColor = c.surface,
        contentColor = c.text,
        scrimColor = c.scrim,
        tonalElevation = 0.dp,
        dragHandle = {
            Box(Modifier.padding(top = 8.dp).width(36.dp).height(4.dp).background(c.borderStrong, RoundedCornerShape(2.dp)))
        },
        modifier = modifier.semantics { paneTitle = title },
    ) {
        Row(
            Modifier.fillMaxWidth().padding(start = d.gutter, end = 6.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(title, style = Caddie.type.sheetTitle, color = c.text, modifier = Modifier.weight(1f).semantics { heading() })
            CaddieIconButton(LucideIcon.X, closeLabel, onClose, iconSize = 22.dp)
        }
        Column(
            Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(horizontal = d.gutter),
            content = content,
        )
        if (footer != null) {
            HorizontalDivider(color = c.border)
            Row(
                Modifier.fillMaxWidth().padding(horizontal = d.gutter, vertical = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
                content = footer,
            )
        }
        Spacer(Modifier.windowInsetsPadding(WindowInsets.navigationBars))
    }
}

/**
 * .dialog: a centred card on the scrim with a title, a body and two buttons, Cancel and
 * [confirmLabel] (a danger button when [destructive], else primary). [content] goes under the body.
 * A tap on the scrim cancels unless [dismissOnScrim] is false.
 */
@Composable
fun ConfirmDialog(
    title: String,
    body: String?,
    confirmLabel: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    destructive: Boolean = true,
    dismissOnScrim: Boolean = true,
    testTag: String = "confirm-dialog",
    content: (@Composable ColumnScope.() -> Unit)? = null,
) {
    val c = Caddie.colors
    val shape = RoundedCornerShape(Caddie.dimens.dialogRadius)
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(dismissOnClickOutside = dismissOnScrim)) {
        Column(
            Modifier
                .testTag(testTag)
                .widthIn(max = 400.dp)
                .fillMaxWidth()
                .shadow(8.dp, shape, ambientColor = c.shadowLg, spotColor = c.shadowLg)
                .background(c.surfaceRaised, shape)
                .padding(start = 24.dp, end = 24.dp, top = 24.dp, bottom = 16.dp)
                .semantics { paneTitle = title },
        ) {
            Text(title, style = Caddie.type.sheetTitle, color = c.text, modifier = Modifier.semantics { heading() })
            if (body != null) Text(body, style = Caddie.type.stateBody, color = c.text2, modifier = Modifier.padding(top = 8.dp))
            content?.invoke(this)
            Row(
                Modifier.fillMaxWidth().padding(top = 24.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
            ) {
                CaddieButton(Strings.Common.CANCEL, onDismiss, variant = ButtonVariant.Text)
                CaddieButton(
                    confirmLabel,
                    onClick = onConfirm,
                    variant = if (destructive) ButtonVariant.Danger else ButtonVariant.Primary,
                )
            }
        }
    }
}

/** A thin rule between rows, in the border colour. */
@Composable
fun Hairline(modifier: Modifier = Modifier) = HorizontalDivider(modifier, thickness = 1.dp, color = Caddie.colors.border)

/** A square gap. */
@Composable
fun Gap(size: androidx.compose.ui.unit.Dp) = Spacer(Modifier.size(size))
