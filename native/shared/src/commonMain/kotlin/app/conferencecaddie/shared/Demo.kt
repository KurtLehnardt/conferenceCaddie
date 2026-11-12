package app.conferencecaddie.shared

/**
 * The words of the "Demo" label, which every screen shows wherever a demo conference's data
 * appears (a conference entry with `"demo": true`, read into
 * [app.conferencecaddie.shared.bundle.Conference.demo]). The web app keeps the same words in
 * web/src/components/demo.tsx, so both say the same thing.
 */
object Demo {
    /** The pill's visible text; the pill draws it in capitals, as the Sample pill does. */
    const val LABEL = "Demo"

    /** What screen readers hear for the pill. */
    const val SPOKEN = "Demo conference, invented data"

    /** The line beside the pill at the top of the people screens and For you. */
    const val NOTE = "A demo conference with invented talks and speakers, not a real event."

    /** The title of a notification this device shows for a demo conference. */
    const val NOTIFICATION_TITLE = "Conference Caddie · Demo conference"

    /** [name] with "(Demo)" after it for a demo conference, as text outside the screens shows it (a share). */
    fun name(name: String, demo: Boolean): String = if (demo) "$name (Demo)" else name

    /** The title of a local notification about a conference: [NOTIFICATION_TITLE] for a demo conference, else [default]. */
    fun notificationTitle(default: String, demo: Boolean): String = if (demo) NOTIFICATION_TITLE else default
}
