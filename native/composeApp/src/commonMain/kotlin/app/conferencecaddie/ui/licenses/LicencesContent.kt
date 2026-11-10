package app.conferencecaddie.ui.licenses

import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.conferencecaddie.ui.theme.Caddie

/** The licences screen's content: each section of Licenses.SECTIONS as a heading and its text. */
@Composable
fun ColumnScope.LicenceSections() {
    Licenses.SECTIONS.forEach { section ->
        Text(
            section.title,
            style = Caddie.type.cardTitle,
            color = Caddie.colors.text,
            modifier = Modifier.padding(top = 8.dp, bottom = 8.dp).semantics { heading() },
        )
        Text(section.body, style = Caddie.type.note, color = Caddie.colors.text2, modifier = Modifier.padding(bottom = 16.dp))
    }
}
