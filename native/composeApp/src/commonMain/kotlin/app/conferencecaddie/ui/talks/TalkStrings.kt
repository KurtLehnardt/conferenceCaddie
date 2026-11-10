package app.conferencecaddie.ui.talks

/**
 * Wording the talk screens need beyond the web app's ([app.conferencecaddie.ui.strings.Strings]):
 * what only the native apps show, because they search a downloaded bundle on the device.
 */
object TalkStrings {
    const val SPEAKERS = "Speakers"
    const val ABSTRACT = "About this talk"

    /** The CC BY attribution the bundle carries, shown with every talk. */
    fun attribution(licensor: String, license: String) = "Schedule content © $licensor, $license."

    const val BUNDLE_INVALID = "This conference's schedule could not be checked, so it was not used. Try again later."
    const val UPDATE_APP_TITLE = "This schedule needs a newer version of the app"
    const val UPDATE_APP_BODY = "Update Conference Caddie to open this conference."
    const val LIST_OFFLINE = "You're offline, and no conference list is saved on this phone yet."
    const val LIST_FAILED = "The conference list could not be loaded."

    /** Shown above the talk screens while the list or the bundle in use is the last this app can read. */
    const val UPDATE_APP_NOTICE = "Update Conference Caddie to get the latest schedule. Until then, this is the copy saved on this phone."

    /** A toast at start when the stored data could not be opened (CoreState.storageReset). */
    const val STORAGE_RESET = "The data saved on this phone could not be opened, so the app started without it."
}
