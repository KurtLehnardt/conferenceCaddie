package app.conferencecaddie.shared

/**
 * The words of the "Demo" label, which every screen shows wherever a demo conference's data
 * appears (a conference entry with `"demo": true`, read into
 * [app.conferencecaddie.shared.bundle.Conference.demo]). The web app keeps the same words in
 * web/src/components/demo.ts, so both say the same thing.
 *
 * Every notification about a demo conference, whether a server sends it or this device shows it,
 * follows one rule (docs/contracts/talk-bundle.md): its title is "Conference Caddie (Demo)" and
 * its body starts with "Demo: ".
 */
object Demo {
    /** The pill's visible text; the pill draws it in capitals, as the Sample pill does. */
    const val LABEL = "Demo"

    /** What screen readers hear for the pill. */
    const val SPOKEN = "Demo conference, invented data"

    /** The line beside the pill at the top of each screen of a demo conference. */
    const val NOTE = "A demo conference with invented talks and speakers, not a real event."

    /** What the body of a notification about a demo conference starts with. */
    const val BODY_PREFIX = "Demo: "

    /** [name] with "(Demo)" after it for a demo conference, as text outside the screens shows it (a share, a notification's title). */
    fun name(name: String, demo: Boolean): String = if (demo) "$name (Demo)" else name

    /** The title of a notification about a conference: [title] ("Conference Caddie"), with "(Demo)" after it for a demo conference. */
    fun notificationTitle(title: String, demo: Boolean): String = name(title, demo)

    /** The body of a notification about a conference: [body], after "Demo: " for a demo conference. */
    fun notificationBody(body: String, demo: Boolean): String = if (demo) BODY_PREFIX + body else body

    /**
     * The title and body of a notification whose own title says more than the app's name (Android's
     * ongoing Bluetooth notification, "Conference Caddie is finding people near you"). For a demo
     * conference the title becomes "Conference Caddie (Demo)" like every other, and the body keeps
     * the old title as its first sentence, after "Demo: ", so nothing it said is lost.
     */
    fun notification(appName: String, title: String, body: String, demo: Boolean): Pair<String, String> =
        if (demo) notificationTitle(appName, true) to notificationBody("$title. $body", true) else title to body
}
