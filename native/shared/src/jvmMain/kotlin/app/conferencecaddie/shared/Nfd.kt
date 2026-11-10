package app.conferencecaddie.shared.search

import java.text.Normalizer

internal actual fun nfd(text: String): String = Normalizer.normalize(text, Normalizer.Form.NFD)
