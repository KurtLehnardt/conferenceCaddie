package app.conferencecaddie.ui.shell

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.conferencecaddie.ui.components.CaddieChip
import app.conferencecaddie.ui.components.CardLink
import app.conferencecaddie.ui.components.ChipKind
import app.conferencecaddie.ui.components.ChipRow
import app.conferencecaddie.ui.components.FiltersChip
import app.conferencecaddie.ui.components.SearchField
import app.conferencecaddie.ui.components.SuggestionChip
import app.conferencecaddie.ui.components.TalkCard
import app.conferencecaddie.ui.components.TimePhraseChip
import app.conferencecaddie.ui.components.highlight
import app.conferencecaddie.ui.format.Format
import app.conferencecaddie.ui.icons.LucideIcon
import app.conferencecaddie.ui.strings.Strings
import app.conferencecaddie.ui.theme.Caddie

/**
 * Debug builds only (`-caddie.tab Search -caddie.gallery 1`): the Search screen's components drawn
 * with the web app's first mock talk (web/src/mock/fixtures.ts), so they can be compared with the
 * web app side by side before the real Search screen exists.
 */
@Composable
fun ComponentGallery() {
    var query by rememberSaveable { mutableStateOf("kubernetes tuesday afternoon") }
    var interested by rememberSaveable { mutableStateOf(false) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        SearchField(query, { query = it }, onSubmit = {})
        ChipRow {
            TimePhraseChip("Tuesday", Format.day("2026-11-10"), onRemove = {})
            TimePhraseChip("Afternoon", null, onRemove = {})
            FiltersChip(0, onClick = {})
            CaddieChip(Strings.Chips.HAPPENING_NOW, active = false, onClick = {}, leadingIcon = LucideIcon.Clock)
            CaddieChip(Strings.Chips.DAY, active = false, onClick = {}, kind = ChipKind.Dropdown)
        }
        ChipRow(lead = Strings.Search.DID_YOU_MEAN) {
            SuggestionChip(Strings.Search.SUGGESTION_TRACK, "Sample Track 1", onClick = {})
        }
        Text(
            Strings.Search.count(12, browse = false, includeEvents = false),
            style = Caddie.type.meta.copy(fontWeight = Caddie.type.chip.fontWeight),
            color = Caddie.colors.text2,
            modifier = Modifier.padding(horizontal = Caddie.dimens.gutter).padding(bottom = 8.dp),
        )
        Column(Modifier.padding(horizontal = Caddie.dimens.gutter), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            TalkCard(
                title = "Sample talk 1 on Kubernetes security",
                whenText = Format.`when`("2026-11-09", 540, 570, "CST"),
                speakers = "Sample Speaker One, Sample Speaker Two",
                room = "Sample Room 1",
                tags = listOf("Sample Track 1", "Beginner", "Talk"),
                evidence = highlight(
                    "Placeholder abstract for sample talk 1. It mentions kubernetes, security & observability so mock searches find something.",
                    listOf("kubernetes"),
                ),
                interested = interested,
                onToggleInterested = { interested = !interested },
                ended = true,
                links = listOf(CardLink(Strings.Talk.ADD_ON_OFFICIAL, LucideIcon.ExternalLink, "https://example.invalid/")),
            )
            TalkCard(
                title = "Sample showcase",
                whenText = Format.`when`("2026-11-09", 600, 660, "CST"),
                room = "Expo hall",
                isEvent = true,
                links = listOf(CardLink(Strings.Talk.EVENT_LINK, LucideIcon.ExternalLink, "https://example.invalid/")),
            )
        }
    }
}
