package app.conferencecaddie.ui.talks

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.lifecycle.ViewModel
import app.conferencecaddie.shared.bundle.Conference
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.importer.ImportConfidence
import app.conferencecaddie.shared.importer.ImportInput
import app.conferencecaddie.shared.importer.ImportOutcome
import app.conferencecaddie.shared.importer.ImportRefusal
import app.conferencecaddie.shared.importer.ImportResult
import app.conferencecaddie.shared.importer.MAX_IMPORT_TEXT
import app.conferencecaddie.ui.components.ButtonVariant
import app.conferencecaddie.ui.components.CaddieButton
import app.conferencecaddie.ui.components.CaddieIconButton
import app.conferencecaddie.ui.components.LucideImage
import app.conferencecaddie.ui.components.FullScreenDialogBars
import app.conferencecaddie.ui.components.fullScreenDialogProperties
import app.conferencecaddie.ui.components.Pill
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.platform.PickedFile
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.job
import kotlinx.coroutines.launch

/**
 * Import my schedule's state (web/src/components/import.tsx): working, the error, the pasted text,
 * the matches with the ones ticked, and the confirmation after marking. [run] is the core's import,
 * on the device or through the backend as its capabilities say. Held by [ImportViewModel], it
 * survives a rotation; [reset] starts every opening clean, as the web's sheet does.
 */
class ImportModel(
    private var scope: CoroutineScope,
    private val run: suspend (ImportInput) -> ImportOutcome,
) {
    /** The talks marked after the review, and the local day of the earliest, for "View my schedule". */
    data class Done(val ids: List<String>, val day: String)

    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var pasteOpen by mutableStateOf(false)
    var pasteText by mutableStateOf("")
    var result by mutableStateOf<ImportResult?>(null)
        private set
    var checked by mutableStateOf(emptySet<String>())
        private set
    var done by mutableStateOf<Done?>(null)
        private set

    /**
     * A file another app handed over ("Open in", "Share"), waiting for the person to ask for it to
     * be read: nothing is parsed before that tap.
     */
    var offered by mutableStateOf<PickedFile?>(null)
        private set

    private var job: Job? = null

    // The import that is running, kept until it ends, so one that the old scope cut short (a
    // rotation on Android ends the composition's scope) runs again in the new one.
    private var unfinished: Pair<ImportInput, Set<String>>? = null

    /** Runs imports in [newScope] from now on, repeating one the previous scope cut short. */
    fun attach(newScope: CoroutineScope) {
        if (newScope === scope) return
        scope = newScope
        unfinished?.let { (input, interested) -> start(input, interested) }
    }

    fun reset() {
        unfinished = null
        offered = null
        job?.cancel()
        busy = false
        error = null
        pasteOpen = false
        pasteText = ""
        result = null
        checked = emptySet()
        done = null
    }

    /** Stops reading; the sheet stays open on its first page. */
    fun cancel() {
        unfinished = null
        job?.cancel()
        busy = false
    }

    /** Imports a file the person chose or opened in the app. */
    fun runFile(file: PickedFile, interested: Set<String>) {
        offered = null
        val bytes = file.bytes
        when {
            file.tooLarge -> showError(Strings.Import.TOO_LARGE)
            bytes == null -> showError(Strings.Import.UNOPENABLE)
            bytes.isEmpty() -> showError(Strings.Import.EMPTY_FILE)
            else -> start(ImportInput.File(bytes, file.name, file.mime), interested)
        }
    }

    /** Starts clean with [file] waiting on the first page for the person's tap ([runOffered]). */
    fun offer(file: PickedFile) {
        reset()
        offered = file
    }

    /** Reads the file another app handed over, once the person asked for it. */
    fun runOffered(interested: Set<String>) {
        val file = offered ?: return
        offered = null
        runFile(file, interested)
    }

    /** Imports the pasted text. */
    fun runText(interested: Set<String>) = start(ImportInput.Text(pasteText), interested)

    fun toggle(talkId: String) {
        checked = if (talkId in checked) checked - talkId else checked + talkId
    }

    /** Back to the first page, as the web's "Start over". */
    fun startOver() {
        result = null
        error = null
    }

    /** After marking: the confirmation with Undo and "View my schedule". */
    fun marked(ids: List<String>, talks: List<Talk>) {
        if (ids.isEmpty()) return
        val first = talks.filter { it.talkId in ids }.minByOrNull { it.startEpochMs } ?: return
        done = Done(ids, first.day)
    }

    fun undone() {
        done = null
    }

    private fun showError(message: String) {
        result = null
        error = message
    }

    private fun start(input: ImportInput, interested: Set<String>) {
        job?.cancel()
        unfinished = input to interested
        busy = true
        error = null
        // Started lazily, so [job] names this import before any of it runs: a cancelled earlier
        // import, whose cleanup can run after this one started, then leaves the state alone.
        val launched = scope.launch(start = CoroutineStart.LAZY) {
            try {
                when (val outcome = run(input)) {
                    is ImportOutcome.Done -> {
                        result = outcome.result
                        checked = outcome.result.matched
                            .filter { it.confidence.strong && it.talk.talkId !in interested }
                            .map { it.talk.talkId }
                            .toSet()
                    }
                    is ImportOutcome.Refused -> error = message(outcome)
                }
                unfinished = null
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                // Errors too: an import must never end the app.
                error = Strings.Import.UNAVAILABLE
                unfinished = null
            } finally {
                // An import cut short with its scope stays busy until attach runs it again.
                if (job === coroutineContext.job && unfinished == null) busy = false
            }
        }
        job = launched
        launched.start()
    }

    private fun message(r: ImportOutcome.Refused): String = when (r.reason) {
        ImportRefusal.TooLarge -> Strings.Import.TOO_LARGE
        ImportRefusal.Empty -> Strings.Import.EMPTY_FILE
        ImportRefusal.Unsupported -> Strings.Import.UNSUPPORTED
        ImportRefusal.Document -> Strings.Import.DOCUMENT
        ImportRefusal.Unreadable -> Strings.Import.UNREADABLE
        ImportRefusal.PasteEmpty -> Strings.Import.PASTE_EMPTY
        ImportRefusal.PasteTooLong -> Strings.Import.PASTE_TOO_LONG
        ImportRefusal.Server -> r.serverMessage ?: Strings.Import.UNAVAILABLE
        ImportRefusal.Unavailable -> Strings.Import.UNAVAILABLE
    }
}

class ImportViewModel(scope: CoroutineScope, run: suspend (ImportInput) -> ImportOutcome) : ViewModel() {
    val model = ImportModel(scope, run)
}

/** True when the file is probably for another conference: almost nothing matched well (web fewMatched). */
internal fun fewMatched(result: ImportResult): Boolean {
    val strong = result.matched.count { it.confidence.strong }
    return strong == 0 || (result.unmatchedCount >= 5 && strong * 4 < result.unmatchedCount)
}

/**
 * Import my schedule (web ImportSheet): a full-screen sheet on phones and a centred dialog 560 dp wide
 * in a wide window. The person chooses a file or pastes text; the matches are reviewed, with strong
 * ones ticked and similar titles left for the person to check; "Mark N talks as Interested" marks
 * them on this device, and the confirmation offers Undo and "View my schedule". Nothing is shared.
 */
@Composable
fun ImportSheet(
    model: ImportModel,
    conference: Conference,
    interested: Set<String>,
    onPickFile: () -> Unit,
    onMark: (List<Talk>) -> List<String>,
    onUndo: (List<String>) -> Unit,
    onViewSchedule: (String) -> Unit,
    onSwitchConference: () -> Unit,
    onClose: () -> Unit,
) {
    val close = {
        model.cancel()
        onClose()
    }
    // The sheet reaches under the system bars on a phone, as the web's full-screen sheet does, and
    // keeps its own content clear of them.
    Dialog(
        onDismissRequest = close,
        properties = fullScreenDialogProperties(Caddie.colors.scrim),
    ) {
        BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            val wide = maxWidth >= Caddie.dimens.wideLayoutMinWidth
            val c = Caddie.colors
            FullScreenDialogBars(c.isDark)
            val shape = RoundedCornerShape(if (wide) Caddie.dimens.dialogRadius else 0.dp)
            Column(
                (if (wide) Modifier.widthIn(max = 560.dp).fillMaxWidth().heightIn(min = minOf(560.dp, maxHeight * 0.8f), max = maxHeight * 0.8f).shadow(8.dp, shape, ambientColor = c.shadowLg, spotColor = c.shadowLg) else Modifier.fillMaxSize())
                    .clip(shape)
                    .background(c.surface)
                    .then(if (wide) Modifier else Modifier.windowInsetsPadding(WindowInsets.safeDrawing))
                    .imePadding()
                    .testTag("import-sheet")
                    .semantics { paneTitle = Strings.Import.TITLE },
            ) {
                // .sheet-header
                Row(
                    Modifier.fillMaxWidth().padding(start = Caddie.dimens.gutter, end = 6.dp, top = 4.dp, bottom = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(Strings.Import.TITLE, style = Caddie.type.sheetTitle, color = c.text, modifier = Modifier.weight(1f).semantics { heading() })
                    CaddieIconButton(LucideIcon.X, Strings.Common.CLOSE, close, iconSize = 22.dp, modifier = Modifier.testTag("import-close"))
                }
                val done = model.done
                val result = model.result
                when {
                    done != null -> DonePage(done, onUndo = {
                        onUndo(done.ids)
                        model.undone()
                    }, onViewSchedule = { onViewSchedule(done.day) })
                    result != null -> ReviewPage(model, result, conference, interested, onSwitchConference) { talks ->
                        model.marked(onMark(talks), talks)
                    }
                    else -> StartPage(model, conference, interested, onPickFile)
                }
            }
        }
    }
}

/** The first page: the lead, Choose a file, Paste text instead, the error and the privacy note. */
@Composable
private fun ColumnScope.StartPage(model: ImportModel, conference: Conference, interested: Set<String>, onPickFile: () -> Unit) {
    val c = Caddie.colors
    Column(
        Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = Caddie.dimens.gutter).padding(bottom = 16.dp),
    ) {
        Text(Strings.Import.lead(conference.name), style = Caddie.type.stateBody, color = c.text2, modifier = Modifier.padding(top = 4.dp, bottom = 16.dp))
        if (model.busy) {
            Column(
                Modifier.fillMaxWidth().padding(vertical = 32.dp).semantics { liveRegion = LiveRegionMode.Polite }.testTag("import-working"),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Spinner()
                Text(Strings.Import.READING, style = Caddie.type.stateBody, color = c.text2)
                CaddieButton(Strings.Import.CANCEL, model::cancel, variant = ButtonVariant.Text, small = true)
            }
        } else {
            model.offered?.let { file ->
                // A file from another app is read only once the person asks for it.
                Column(
                    Modifier
                        .fillMaxWidth()
                        .padding(bottom = 16.dp)
                        .background(c.fill, RoundedCornerShape(Caddie.dimens.radius))
                        .padding(12.dp)
                        .testTag("import-offered"),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(Strings.Import.offered(file.name.ifBlank { Strings.Import.UNNAMED_FILE }), style = Caddie.type.stateBody, color = c.text)
                    CaddieButton(
                        Strings.Import.FIND_TALKS,
                        onClick = { model.runOffered(interested) },
                        modifier = Modifier.fillMaxWidth().testTag("import-offered-find"),
                    )
                }
            }
            CaddieButton(
                Strings.Import.CHOOSE_FILE,
                onClick = onPickFile,
                icon = LucideIcon.FileUp,
                iconSize = 20.dp,
                modifier = Modifier.fillMaxWidth().testTag("import-choose"),
            )
            Text(
                Strings.Import.FORMATS,
                style = Caddie.type.note,
                color = c.text2,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 12.dp),
            )
            CaddieButton(
                Strings.Import.PASTE_TOGGLE,
                onClick = { model.pasteOpen = !model.pasteOpen },
                variant = ButtonVariant.Text,
                icon = LucideIcon.ClipboardPaste,
                iconSize = 20.dp,
                modifier = Modifier.fillMaxWidth().testTag("import-paste-toggle"),
            )
            if (model.pasteOpen) {
                Column(Modifier.fillMaxWidth().padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(Strings.Import.PASTE_LABEL, style = Caddie.type.note.copy(fontWeight = FontWeight.SemiBold), color = c.text2)
                    PasteField(model.pasteText, { model.pasteText = it.take(MAX_IMPORT_TEXT) })
                    CaddieButton(
                        Strings.Import.FIND_TALKS,
                        onClick = { model.runText(interested) },
                        enabled = model.pasteText.isNotBlank(),
                        modifier = Modifier.fillMaxWidth().testTag("import-find"),
                    )
                }
            }
        }
        model.error?.let { message ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .padding(top = 12.dp)
                    .background(c.dangerTint, RoundedCornerShape(Caddie.dimens.radius))
                    .padding(horizontal = 12.dp, vertical = 10.dp)
                    .testTag("import-error")
                    .semantics { liveRegion = LiveRegionMode.Assertive },
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                LucideImage(LucideIcon.CircleExclamationPoint, null, size = 18.dp, tint = c.danger, modifier = Modifier.padding(top = 1.dp))
                Text(message, style = Caddie.type.meta, color = c.danger)
            }
        }
        Row(Modifier.fillMaxWidth().padding(top = 20.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            LucideImage(LucideIcon.Info, null, size = 16.dp, modifier = Modifier.padding(top = 2.dp))
            Text(Strings.Import.NOTE, style = Caddie.type.note, color = c.text2)
        }
    }
}

/** .imp-textarea: at least 160 dp tall, the web's border and 16 sp text. */
@Composable
private fun PasteField(value: String, onChange: (String) -> Unit) {
    val c = Caddie.colors
    val shape = RoundedCornerShape(Caddie.dimens.radius)
    BasicTextField(
        value = value,
        onValueChange = onChange,
        textStyle = Caddie.type.body.copy(color = c.text),
        cursorBrush = SolidColor(c.accent),
        // Talk titles are matched word for word, so the keyboard must not correct or capitalise them.
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 160.dp)
            .background(c.surfaceRaised, shape)
            .border(1.dp, c.borderStrong, shape)
            .padding(horizontal = 12.dp, vertical = 10.dp)
            .testTag("import-paste")
            .semantics { contentDescription = Strings.Import.PASTE_LABEL },
        decorationBox = { inner ->
            Box {
                if (value.isEmpty()) Text(Strings.Import.PASTE_PLACEHOLDER, style = Caddie.type.body, color = c.text2)
                inner()
            }
        },
    )
}

/** .imp-spin: the loader circle turning while the schedule is read. */
@Composable
private fun Spinner() {
    val turn = rememberInfiniteTransition()
    val angle by turn.animateFloat(0f, 360f, infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart))
    LucideImage(LucideIcon.LoaderCircle, null, Modifier.rotate(angle), size = 28.dp, tint = Caddie.colors.accent)
}

/** The review: the summary, the hint for another conference, and the matches to tick. */
@Composable
private fun ColumnScope.ReviewPage(
    model: ImportModel,
    result: ImportResult,
    conference: Conference,
    interested: Set<String>,
    onSwitchConference: () -> Unit,
    onMark: (List<Talk>) -> Unit,
) {
    val c = Caddie.colors
    val matched = result.matched
    val fresh = matched.filter { it.talk.talkId !in interested }
    val toMark = fresh.filter { it.talk.talkId in model.checked }
    Column(
        Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = Caddie.dimens.gutter).padding(bottom = 16.dp).testTag("import-review"),
    ) {
        val summary = (if (matched.isNotEmpty()) Strings.Import.found(matched.size, conference.name) else Strings.Import.noneFound(conference.name)) +
            (if (result.unmatchedCount > 0) Strings.Import.unmatched(result.unmatchedCount) else "")
        Text(
            summary,
            style = Caddie.type.stateBody,
            color = c.text,
            modifier = Modifier.padding(top = 4.dp, bottom = 12.dp).testTag("import-summary").semantics { liveRegion = LiveRegionMode.Polite },
        )
        if (fewMatched(result)) {
            Column(
                Modifier.fillMaxWidth().padding(bottom = 12.dp).background(c.fill, RoundedCornerShape(Caddie.dimens.radius)).padding(12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(Strings.Import.FEW, style = Caddie.type.meta, color = c.text)
                CaddieButton(Strings.Import.SWITCH, onSwitchConference, variant = ButtonVariant.Tonal, small = true, modifier = Modifier.testTag("import-switch"))
            }
        }
        if (fresh.any { !it.confidence.strong }) {
            Text(Strings.Import.HELP, style = Caddie.type.note, color = c.text2, modifier = Modifier.padding(bottom = 4.dp))
        }
        matched.forEachIndexed { i, m ->
            if (i > 0) HorizontalDivider(color = c.border)
            val id = m.talk.talkId
            val already = id in interested
            val on = already || id in model.checked
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .toggleable(value = on, enabled = !already, role = Role.Checkbox, onValueChange = { model.toggle(id) })
                    .padding(vertical = 12.dp)
                    .testTag("import-row-$id"),
                horizontalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                CheckMark(on, enabled = !already, modifier = Modifier.padding(top = 1.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(m.talk.title, style = Caddie.type.cardTitle.copy(fontSize = 15.sp, lineHeight = 19.5.sp), color = c.text)
                    Text(whenText(m.talk, conference), style = Caddie.type.note, color = c.text2)
                    val strong = m.confidence.strong
                    Text(
                        if (already) Strings.Import.ALREADY else label(m.confidence),
                        style = Caddie.type.tag.copy(fontWeight = FontWeight.SemiBold),
                        color = when {
                            already -> c.text2
                            strong -> c.accentInk
                            else -> c.warning
                        },
                        modifier = Modifier
                            .background(if (strong && !already) c.accentTint else c.fill, Pill)
                            .padding(horizontal = 8.dp, vertical = 2.dp),
                    )
                    Text(Strings.Import.fromFile(m.excerpt), style = Caddie.type.note, color = c.text2)
                }
            }
        }
    }
    Footer {
        CaddieButton(Strings.Import.START_OVER, model::startOver, variant = ButtonVariant.Text, modifier = Modifier.testTag("import-start-over"))
        CaddieButton(
            if (toMark.isNotEmpty()) Strings.Import.mark(toMark.size) else Strings.Import.NOTHING,
            onClick = { onMark(toMark.map { it.talk }) },
            enabled = toMark.isNotEmpty(),
            modifier = Modifier.weight(1f).testTag("import-mark"),
        )
    }
}

/** A 22 dp checkbox in the accent colour, as the web's `accent-color` draws it. */
@Composable
private fun CheckMark(on: Boolean, enabled: Boolean, modifier: Modifier = Modifier) {
    val c = Caddie.colors
    val shape = RoundedCornerShape(4.dp)
    Box(
        modifier
            .size(22.dp)
            .alpha(if (enabled) 1f else 0.45f)
            .then(if (on) Modifier.background(c.accent, shape) else Modifier.border(2.dp, c.text2, shape)),
        contentAlignment = Alignment.Center,
    ) {
        if (on) LucideImage(LucideIcon.Check, null, size = 16.dp, tint = c.onAccent, strokeWidth = 3f)
    }
}

private fun label(c: ImportConfidence): String = when (c) {
    ImportConfidence.ExactTitle -> Strings.Import.EXACT_TITLE
    ImportConfidence.TitleAndSpeaker -> Strings.Import.TITLE_AND_SPEAKER
    ImportConfidence.TitleAndTime -> Strings.Import.TITLE_AND_TIME
    ImportConfidence.TitleWords -> Strings.Import.TITLE_WORDS
}

/** The confirmation after marking, with Undo and "View my schedule". */
@Composable
private fun ColumnScope.DonePage(done: ImportModel.Done, onUndo: () -> Unit, onViewSchedule: () -> Unit) {
    val c = Caddie.colors
    Column(
        Modifier.weight(1f).fillMaxWidth().padding(horizontal = Caddie.dimens.gutter).testTag("import-done").semantics { liveRegion = LiveRegionMode.Polite },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterVertically),
    ) {
        LucideImage(LucideIcon.CircleCheck, null, size = 44.dp, tint = c.accent)
        Text(Strings.Import.marked(done.ids.size), style = Caddie.type.stateTitle.copy(fontSize = 18.sp, fontWeight = FontWeight.Bold), color = c.text, textAlign = TextAlign.Center)
        Text(Strings.Import.DONE_BODY, style = Caddie.type.stateBody, color = c.text2, textAlign = TextAlign.Center, modifier = Modifier.widthIn(max = 320.dp))
    }
    Footer {
        CaddieButton(Strings.Import.UNDO, onUndo, variant = ButtonVariant.Text, modifier = Modifier.testTag("import-undo"))
        CaddieButton(Strings.Import.VIEW_SCHEDULE, onViewSchedule, modifier = Modifier.weight(1f).testTag("import-view"))
    }
}

/** .sheet-footer: a hairline, then the buttons with the primary one taking the rest of the row. */
@Composable
private fun Footer(content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    HorizontalDivider(color = Caddie.colors.border)
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Caddie.dimens.gutter, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
    Spacer(Modifier.size(0.dp))
}
