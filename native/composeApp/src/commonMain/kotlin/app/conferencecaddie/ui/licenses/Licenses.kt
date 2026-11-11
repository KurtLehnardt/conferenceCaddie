package app.conferencecaddie.ui.licenses

/** One titled block of the licences screen. */
data class LicenceSection(val title: String, val body: String)

/**
 * The licences the apps show in Settings under "Open-source licences": the app's own, the lucide
 * icons' ([LUCIDE]: ISC, and MIT for the icons that came from Feather; the text of
 * native/licenses/lucide.txt, to be updated together with it), and every third-party licence in
 * [ThirdPartyNotices], whose notices must travel with every copy.
 */
object Licenses {
    const val LUCIDE = """ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

The following Lucide icons are derived from the Feather project:

airplay, alert-circle, alert-octagon, alert-triangle, aperture, arrow-down-circle, arrow-down-left, arrow-down-right, arrow-down, arrow-left-circle, arrow-left, arrow-right-circle, arrow-right, arrow-up-circle, arrow-up-left, arrow-up-right, arrow-up, at-sign, calendar, cast, check, chevron-down, chevron-left, chevron-right, chevron-up, chevrons-down, chevrons-left, chevrons-right, chevrons-up, circle, clipboard, clock, code, columns, command, compass, corner-down-left, corner-down-right, corner-left-down, corner-left-up, corner-right-down, corner-right-up, corner-up-left, corner-up-right, crosshair, database, divide-circle, divide-square, dollar-sign, download, external-link, feather, frown, hash, headphones, help-circle, info, italic, key, layout, life-buoy, link-2, link, loader, lock, log-in, log-out, maximize, meh, minimize, minimize-2, minus-circle, minus-square, minus, monitor, moon, more-horizontal, more-vertical, move, music, navigation-2, navigation, octagon, pause-circle, percent, plus-circle, plus-square, plus, power, radio, rss, search, server, share, shopping-bag, sidebar, smartphone, smile, square, table-2, tablet, target, terminal, trash-2, trash, triangle, tv, type, upload, x-circle, x-octagon, x-square, x, zoom-in, zoom-out

The MIT License (MIT) (for the icons listed above)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE."""

    /**
     * Joins a text's hard line breaks (and the indentation after them) so its paragraphs wrap to the
     * screen. Only the short lucide text needs it here: scripts/third-party-notices.py does the same
     * to the generated notices, so nothing scans their hundreds of kilobytes on the phone.
     */
    private fun unwrap(text: String): String {
        val out = StringBuilder(text.length)
        var i = 0
        while (i < text.length) {
            val c = text[i]
            val lone = c == '\n' && (i == 0 || text[i - 1] != '\n') && (i + 1 >= text.length || text[i + 1] != '\n')
            if (lone) {
                out.append(' ')
                i++
                while (i < text.length && (text[i] == ' ' || text[i] == '\t')) i++
            } else {
                out.append(c)
                i++
            }
        }
        return out.toString()
    }

    /** The modules a licence covers, grouped by the platforms that ship them, as the lines shown above its text. */
    private fun moduleLines(notice: ThirdPartyNotices.Notice): String {
        val both = notice.android.filter { it in notice.ios }
        val androidOnly = notice.android.filter { it !in notice.ios }
        val iosOnly = notice.ios.filter { it !in notice.android }
        return listOf("Android and iOS" to both, "Android only" to androidOnly, "iOS only" to iosOnly)
            .filter { (_, modules) -> modules.isNotEmpty() }
            .joinToString("\n\n") { (platforms, modules) ->
                "$platforms:\n" + modules.joinToString("\n") { "${it.coordinate} ${it.version}" }
            }
    }

    /**
     * What the licences screen shows: the app's own licence, the lucide icons, then every third-party
     * licence with the modules it covers on each platform and its full text.
     */
    val SECTIONS: List<LicenceSection> = listOf(
        LicenceSection(
            "Conference Caddie",
            "Conference Caddie is open source under the Apache License 2.0. The libraries and components it is " +
                "built with are listed below with their licences.",
        ),
        LicenceSection("Lucide icons", unwrap(LUCIDE)),
    ) + ThirdPartyNotices.NOTICES.map { notice ->
        LicenceSection(notice.title, moduleLines(notice) + "\n\n" + notice.text)
    }
}
