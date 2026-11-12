package app.conferencecaddie.shared.people

import kotlinx.serialization.KSerializer
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer

/**
 * Where the people records live: a small key-value store. The app's is [PeopleDatabase], a file of
 * its own that no backup carries (never [app.conferencecaddie.shared.db.CaddieDatabase], whose main
 * file is in iOS backups); tests use a map.
 */
interface PeopleKeyValue {
    suspend fun get(key: String): String?

    /** Stores [value] under [key], or removes the key when [value] is null. */
    suspend fun set(key: String, value: String?)

    /**
     * True when this launch keeps the records in memory only, because the stored ones could not be
     * opened. Known once the first [get] or [set] has returned, which loading the records does.
     */
    val inMemory: Boolean get() = false
}

/**
 * The device-side people records of one backend (web/src/people/storage.ts), kept in memory and
 * written through to [PeopleKeyValue] as JSON. Every key starts with `people:v1:` and the
 * normalised backend base, so two backends never share a record, even when they share an origin
 * under different paths (a base never contains '#'):
 *
 * - `people:v1:{base}#profile`: the [Profile].
 * - `people:v1:{base}#delete-all`: "Delete my profile" while it is unfinished.
 * - `people:v1:{base}#slugs`: the conferences that have a record.
 * - `people:v1:{base}#conference:{slug}`: everything else of one conference ([ConferenceRecord]).
 *
 * Only one controller writes these, so the in-memory copy is always current. A write updates
 * memory first and returns once storage holds it, so a delete marked here is stored before its
 * request is sent.
 */
internal class PeopleStore(private val kv: PeopleKeyValue, val backend: String) {
    private val prefix = "people:v1:$backend#"
    private var profileMem: Profile? = null
    private var deleteAllMem: DeleteRetry? = null
    private val records = LinkedHashMap<String, ConferenceRecord>()
    private var loaded = false

    suspend fun load() {
        if (loaded) return
        profileMem = read(KEY_PROFILE, Profile.serializer())?.sanitized()
        deleteAllMem = read(KEY_DELETE_ALL, DeleteRetry.serializer())
        val slugs = read(KEY_SLUGS, ListSerializer(String.serializer())) ?: emptyList()
        for (slug in slugs) {
            records[slug] = read(KEY_CONFERENCE + slug, ConferenceRecord.serializer())?.sanitized() ?: ConferenceRecord()
        }
        loaded = true
    }

    // ---------------------------------------------------------------------------------------------
    // Profile and "Delete my profile"

    val profile: Profile? get() = profileMem

    /**
     * Stores [p], then holds it in memory: a write that fails leaves the profile as it was, on the
     * device and in memory alike, so an edit reported as not saved is not sent or shown later.
     */
    suspend fun setProfile(p: Profile?) {
        write(KEY_PROFILE, p, Profile.serializer())
        profileMem = p
    }

    val deleteAll: DeleteRetry? get() = deleteAllMem

    suspend fun setDeleteAll(value: DeleteRetry?) {
        deleteAllMem = value
        write(KEY_DELETE_ALL, value, DeleteRetry.serializer())
    }

    /** Changes the stored "Delete my profile" record, only if it is still stored. */
    suspend fun updateDeleteAll(transform: (DeleteRetry) -> DeleteRetry): Boolean {
        val current = deleteAllMem ?: return false
        setDeleteAll(transform(current))
        return true
    }

    // ---------------------------------------------------------------------------------------------
    // Conferences

    /** The conferences that have a record. */
    val slugs: Set<String> get() = records.keys.toSet()

    fun record(slug: String): ConferenceRecord = records[slug] ?: EMPTY_RECORD

    suspend fun update(slug: String, transform: (ConferenceRecord) -> ConferenceRecord): ConferenceRecord {
        val before = records[slug]
        val next = transform(before ?: EMPTY_RECORD)
        if (next == before) return next
        val listed = before != null
        if (next.isEmpty) {
            records.remove(slug)
            kv.set(prefix + KEY_CONFERENCE + slug, null)
            if (listed) writeSlugs()
        } else {
            records[slug] = next
            write(KEY_CONFERENCE + slug, next, ConferenceRecord.serializer())
            if (!listed) writeSlugs()
        }
        return next
    }

    fun visibility(slug: String): Visibility = record(slug).visibility

    suspend fun setVisibility(slug: String, transform: (Visibility) -> Visibility): Visibility =
        update(slug) { it.copy(visibility = transform(it.visibility).sanitized()) }.visibility

    fun presence(slug: String): Presence = record(slug).presence

    suspend fun setPresence(slug: String, transform: (Presence) -> Presence): Presence =
        update(slug) { it.copy(presence = transform(it.presence)) }.presence

    fun deletePending(slug: String): DeleteRetry? = record(slug).deletePending

    suspend fun setDeletePending(slug: String, value: DeleteRetry?) {
        update(slug) { it.copy(deletePending = value) }
    }

    /** Changes the stored mark for one conference, only if it is still stored. */
    suspend fun updateDeletePending(slug: String, transform: (DeleteRetry) -> DeleteRetry): Boolean {
        val current = deletePending(slug) ?: return false
        setDeletePending(slug, transform(current))
        return true
    }

    fun slugsWhere(test: (ConferenceRecord) -> Boolean): List<String> = records.filter { test(it.value) }.keys.toList()

    /** Slugs whose visibility says the server holds a document. */
    fun slugsOnServer(): List<String> = slugsWhere { it.visibility.onServer }

    /** Slugs where the server holds a document, or may hold one because a first write went unanswered. */
    fun slugsMaybeOnServer(): List<String> = slugsWhere { it.visibility.onServer || it.visibility.maybeOnServer }

    /** The conferences with an unfinished profile delete. */
    fun slugsDeletePending(): List<String> = slugsWhere { it.deletePending != null }

    /** The conferences whose push state is on. */
    fun slugsWithPush(): List<String> = slugsWhere { it.push.on }

    /**
     * True while a delete covers this conference: "Delete my profile" is unfinished, or the delete
     * of this conference's copy is. Nothing that could make the device visible again is sent then.
     */
    fun deleteCovers(slug: String): Boolean = deleteAllMem != null || deletePending(slug) != null

    /**
     * Removes the profile and every visibility, presence, push, block, watch, nudge and
     * unfinished-delete record, the "Delete my profile" one included. "People I met" is the user's
     * own notes and stays, like the Interested list. Only for after the server confirmed every
     * delete. The "Delete my profile" mark goes last: a wipe that fails half way leaves the mark,
     * so the delete is tried again instead of the profile coming back without it.
     */
    suspend fun clearAllPeopleData() {
        for (slug in records.keys.toList()) {
            update(slug) { ConferenceRecord(met = it.met) }
        }
        setProfile(null)
        setDeleteAll(null)
    }

    // ---------------------------------------------------------------------------------------------

    private suspend fun writeSlugs() {
        write(KEY_SLUGS, records.keys.toList().takeIf { it.isNotEmpty() }, ListSerializer(String.serializer()))
    }

    private suspend fun <T> read(name: String, serializer: KSerializer<T>): T? {
        val text = kv.get(prefix + name) ?: return null
        return try {
            PeopleJson.responses.decodeFromString(serializer, text)
        } catch (e: Exception) {
            // An unreadable record is as good as none.
            null
        }
    }

    private suspend fun <T> write(name: String, value: T?, serializer: KSerializer<T>) {
        kv.set(prefix + name, value?.let { PeopleJson.responses.encodeToString(serializer, it) })
    }

    companion object {
        private const val KEY_PROFILE = "profile"
        private const val KEY_DELETE_ALL = "delete-all"
        private const val KEY_SLUGS = "slugs"
        private const val KEY_CONFERENCE = "conference:"
        private val EMPTY_RECORD = ConferenceRecord()
    }
}
