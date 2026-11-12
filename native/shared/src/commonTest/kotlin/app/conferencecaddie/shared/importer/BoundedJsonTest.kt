package app.conferencecaddie.shared.importer

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.TimeSource
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// The import's JSON reader: JSON.parse's grammar, and a bound on what it builds, so a crafted 5 MB
// file cannot exhaust memory (it used to build some 2.5 million values, about 200 MB). On the JVM
// and the iOS simulator.
class BoundedJsonTest {
    private fun parse(text: String) = BoundedJson().parse(text)

    @Test
    fun readsWhatJsonParseReads() {
        val o = assertIs<JsonObject>(parse(" {\"a\": [1, -2.5e3, true, false, null, \"x\\\"y\\\\z\\/\\b\\f\\n\\r\\t\\u00e9\\ud83d\\ude00\"], \"b\": {}, \"c\": []}\n"))
        val a = o.getValue("a").jsonArray
        assertEquals(6, a.size)
        // Numbers keep the text they were written with.
        assertEquals("1", a[0].jsonPrimitive.content)
        assertEquals("-2.5e3", a[1].jsonPrimitive.content)
        assertTrue(!a[0].jsonPrimitive.isString)
        assertEquals(JsonPrimitive(true), a[2])
        assertEquals(JsonPrimitive(false), a[3])
        assertEquals(JsonNull, a[4])
        assertEquals("x\"y\\z/\b\u000C\n\r\té😀", a[5].jsonPrimitive.content)
        assertEquals(JsonObject(emptyMap()), o["b"])
        assertEquals(JsonArray(emptyList()), o["c"])
        // A repeated key keeps its first place and takes the last value, as JSON.parse does.
        val d = assertIs<JsonObject>(parse("{\"x\":1,\"y\":2,\"x\":3}"))
        assertEquals(listOf("x", "y"), d.keys.toList())
        assertEquals(3.0, d.getValue("x").jsonPrimitive.content.toDouble())
        assertIs<JsonArray>(parse("[[[[]]]]"))
        assertEquals(JsonPrimitive("only"), parse("\"only\""))
    }

    @Test
    fun refusesWhatJsonParseRefuses() {
        val bad = listOf(
            "", " ", "[", "]", "{", "[1,]", "[,1]", "{\"a\":1,}", "{\"a\" 1}", "{a:1}", "{'a':1}", "['a']", "[01]", "[1.]",
            "[.5]", "[+1]", "[1e]", "[-]", "[NaN]", "[Infinity]", "[tru]", "[nul]", "[\"a\nb\"]", "[\"a", "[\"\\x41\"]",
            "[\"\\u12\"]", "[\"\\u12G4\"]", "[] x", "[]]", "{}{}", "[1 2]", "[/* no */ 1]", "\u00a0[1]",
        )
        for (text in bad) assertNull(parse(text), "should not read: ${text.take(20)}")
    }

    @Test
    fun aHugeFlatArrayBuildsAtMostTheBound() {
        // 5 MB of "1,": about 2.6 million values in the text.
        val text = buildString(5 * 1024 * 1024 + 2) {
            append('[')
            while (length < 5 * 1024 * 1024 - 2) append("1,")
            append("1]")
        }
        val reader = BoundedJson()
        val mark = TimeSource.Monotonic.markNow()
        val value = assertIs<JsonArray>(reader.parse(text))
        assertTrue(reader.built <= BoundedJson.MAX_VALUES, "built ${reader.built} values")
        assertTrue(value.size < BoundedJson.MAX_VALUES)
        // The work is linear in the text, measured in characters examined rather than seconds: about
        // 6.5 steps per character for this text (13 per "1,"), at most about 10 for any JSON; 16
        // allows a few more looks per value, never a second pass over the text. The wall-clock bound
        // is only a backstop against a hang: a debug build on a busy iOS simulator runner once took
        // 31 s for this honest parse.
        assertTrue(reader.steps <= 16 * text.length, "${reader.steps} steps for ${text.length} characters")
        assertTrue(mark.elapsedNow().inWholeSeconds < 180, "took ${mark.elapsedNow()}")
        // So the import reads it as JSON with nothing to find, as the Worker does.
        val prepared = ScheduleImport.Prepared(text, "big.json", "application/json", isFile = true)
        assertTrue(ScheduleImport.candidatesOf(prepared, ImportConference("x", "2026-11-10", "UTC")).isEmpty())
    }

    @Test
    fun manyObjectsAndLongStringsStayWithinTheBound() {
        val text = buildString {
            append('[')
            repeat(300_000) { if (it > 0) append(','); append("{\"k\":\"v\"}") }
            append(']')
        }
        val reader = BoundedJson()
        assertNotNull(reader.parse(text))
        assertTrue(reader.built <= BoundedJson.MAX_VALUES, "built ${reader.built} values")
    }

    @Test
    fun theSessionsComeThroughWhenAFileGoesPastTheBound() {
        // A real export first, then a long tail of values: the walk's part is built.
        val text = buildString {
            append("{\"sessions\":[{\"title\":\"Kubernetes scheduling deep dive\"}],\"tail\":[")
            repeat(BoundedJson.MAX_VALUES + 10) { if (it > 0) append(','); append('0') }
            append("]}")
        }
        val o = assertIs<JsonObject>(BoundedJson().parse(text))
        assertEquals("Kubernetes scheduling deep dive", o.getValue("sessions").jsonArray[0].jsonObject.getValue("title").jsonPrimitive.content)
    }

    @Test
    fun nestingHasAnExplicitLimit() {
        fun nested(depth: Int) = "[".repeat(depth) + "]".repeat(depth)
        assertNotNull(parse(nested(BoundedJson.MAX_NESTING_DEPTH)))
        assertNull(parse(nested(BoundedJson.MAX_NESTING_DEPTH + 1)))
        // Five million levels: refused at level MAX_NESTING_DEPTH + 1, within milliseconds, without
        // recursion and without reading the rest.
        val mark = TimeSource.Monotonic.markNow()
        assertNull(parse("[".repeat(5_000_000)))
        assertTrue(mark.elapsedNow().inWholeSeconds < 10, "took ${mark.elapsedNow()}")
        // Objects count as levels too.
        assertNull(parse("{\"a\":".repeat(BoundedJson.MAX_NESTING_DEPTH + 1) + "1" + "}".repeat(BoundedJson.MAX_NESTING_DEPTH + 1)))
    }

    @Test
    fun valuesBelowTheKeptDepthAreReadButNotBuilt() {
        val depth = BoundedJson.KEEP_DEPTH + 4
        val text = "{\"a\":".repeat(depth) + "\"deep\"" + "}".repeat(depth)
        val reader = BoundedJson()
        var v = assertIs<JsonObject>(reader.parse(text))
        var levels = 1
        while (true) {
            v = v["a"] as? JsonObject ?: break
            levels++
        }
        assertEquals(BoundedJson.KEEP_DEPTH, levels)
        assertEquals(BoundedJson.KEEP_DEPTH, reader.built)
    }
}
