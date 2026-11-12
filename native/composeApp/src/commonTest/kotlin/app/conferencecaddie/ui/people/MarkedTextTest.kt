package app.conferencecaddie.ui.people

import androidx.compose.ui.graphics.Color
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

// The server's evidence is HTML-escaped text whose only markup is <mark>. Only those two tags are
// ever read as markup; everything else, escaped or not, is shown as it is written.
class MarkedTextTest {
    @Test
    fun marksBecomeRangesOfThePlainText() {
        val m = MarkedText.parse("I ran <mark>Postgres</mark> failover on <mark>bare metal</mark>.")
        assertEquals("I ran Postgres failover on bare metal.", m.text)
        assertEquals(listOf(6..13, 27..36), m.marks)
        assertEquals("Postgres", m.text.substring(m.marks[0]))
        assertEquals("bare metal", m.text.substring(m.marks[1]))
    }

    @Test
    fun escapedMarkupStaysLiteral() {
        // An escaped <mark> is text, not a highlight.
        val escaped = MarkedText.parse("&lt;mark&gt;x&lt;/mark&gt;")
        assertEquals("<mark>x</mark>", escaped.text)
        assertTrue(escaped.marks.isEmpty())

        // Any other markup, escaped or not, is never interpreted.
        val raw = "<b>bold</b> <script>alert(1)</script> <img src=x onerror=alert(1)> <a href=\"javascript:x\">link</a>"
        val literal = MarkedText.parse(raw)
        assertEquals(raw, literal.text)
        assertTrue(literal.marks.isEmpty())

        // Only the exact lowercase tags count.
        assertEquals("<MARK>a</MARK> <mark class=\"x\">b", MarkedText.parse("<MARK>a</MARK> <mark class=\"x\">b").text)
        assertTrue(MarkedText.parse("<MARK>a</MARK> <mark class=\"x\">b").marks.isEmpty())
    }

    @Test
    fun entitiesAreDecodedOnceAsTheWebDoes() {
        assertEquals("& < > \" ' ' A", MarkedText.parse("&amp; &lt; &gt; &quot; &#39; &apos; &#x41;").text)
        // Decoded once only: &amp;lt; is the text "&lt;".
        assertEquals("&lt; &amp;", MarkedText.parse("&amp;lt; &amp;amp;").text)
        // A non-breaking space entity reads as a space, as on the web.
        assertEquals("a b", MarkedText.parse("a&nbsp;b").text)
        // Astral characters arrive as one code point.
        assertEquals("😀", MarkedText.parse("&#x1F600;").text)
    }

    @Test
    fun unknownAndInvalidEntitiesStayAsWritten() {
        val raw = "&foo; &#0; &#xD800; &#99999999999; &#X41; &amp &"
        assertEquals(raw, MarkedText.parse(raw).text)
    }

    @Test
    fun unbalancedTagsOnlySwitchHighlightingOnAndOff() {
        val m = MarkedText.parse("</mark>a<mark>b")
        assertEquals("ab", m.text)
        assertEquals(listOf(1..1), m.marks)
        val inside = MarkedText.parse("<mark>&lt;b&gt;</mark>")
        assertEquals("<b>", inside.text)
        assertEquals(listOf(0..2), inside.marks)
    }

    @Test
    fun theAnnotatedStringColoursOnlyTheMarks() {
        val annotated = MarkedText.parse("x <mark>y</mark> z").toAnnotatedString(Color.Red)
        assertEquals("x y z", annotated.text)
        assertEquals(1, annotated.spanStyles.size)
        assertEquals(2, annotated.spanStyles[0].start)
        assertEquals(3, annotated.spanStyles[0].end)
        assertEquals(Color.Red, annotated.spanStyles[0].item.color)
        assertTrue(annotated.getLinkAnnotations(0, annotated.length).isEmpty())
    }
}
