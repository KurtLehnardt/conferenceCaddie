package app.conferencecaddie.ui.licenses

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.conferencecaddie.ui.theme.Caddie

/**
 * The licences screen's content: each section of Licenses.SECTIONS as a heading and its paragraphs.
 * The notices run to a couple of thousand lines, so they are a LazyColumn that lays out only what
 * is on screen; it scrolls on its own, so its sheet must not.
 */
@Composable
fun LicenceSections(modifier: Modifier = Modifier) {
    LazyColumn(modifier.fillMaxWidth()) {
        Licenses.SECTIONS.forEachIndexed { index, section ->
            item(key = "title-$index") {
                Text(
                    section.title,
                    style = Caddie.type.cardTitle,
                    color = Caddie.colors.text,
                    modifier = Modifier.padding(top = 8.dp, bottom = 8.dp).semantics { heading() },
                )
            }
            val paragraphs = section.body.split("\n\n")
            items(paragraphs.size, key = { "body-$index-$it" }) { i ->
                Text(
                    paragraphs[i],
                    style = Caddie.type.note,
                    color = Caddie.colors.text2,
                    modifier = Modifier.padding(bottom = if (i == paragraphs.lastIndex) 16.dp else 8.dp),
                )
            }
        }
    }
}
