package app.conferencecaddie.shared.core

import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.CapabilitiesDiscovery
import app.conferencecaddie.shared.asString
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.bundle.BundleStatus
import app.conferencecaddie.shared.bundle.BundleSync
import app.conferencecaddie.shared.bundle.IndexedConference
import app.conferencecaddie.shared.bundle.Publisher
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.net.Http
import app.conferencecaddie.shared.search.SearchRequest
import app.conferencecaddie.shared.search.SearchResult
import app.conferencecaddie.shared.search.TalkSearch
import kotlin.time.Clock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** The backends compiled into every build (docs/NATIVE_PLAN.md, decision 6). */
object Defaults {
    /** The live tier 3 server, the default backend until the official tier 2 passes its exit criteria. */
    const val BACKEND = "https://conference-caddie-265846417372.us-west1.run.app"

    /** The tier 1 demo on GitHub Pages, used when the default backend cannot be reached. */
    const val FALLBACK_BACKEND = "https://kurtlehnardt.github.io/conferenceCaddie"

    /**
     * The tier 1 bundles, used for a legacy backend (which publishes none, as the contract allows)
     * and for the default backend when its document names none.
     */
    const val FALLBACK_BUNDLE_BASE = "https://kurtlehnardt.github.io/conferenceCaddie/bundles/"
}

/** Everything the screens show, in one immutable value. */
data class CoreState(
    val backend: BackendUrl.Valid,
    val isDefaultBackend: Boolean,
    val capabilities: CapabilitiesState = CapabilitiesState.Loading,
    val conferences: ConferencesState = ConferencesState.Loading,
    val selectedSlug: String? = null,
    val bundle: BundleState = BundleState.None,
    val interested: List<String> = emptyList(),
)

sealed interface CapabilitiesState {
    data object Loading : CapabilitiesState

    /**
     * What the backend offers ([capabilities]) and what this app uses of it ([forThisApp]).
     * [cached] is true while the copy is the last good one because the backend could not be reached;
     * [updateApp] is true when the backend now serves only documents a newer app can read.
     */
    data class Ready(
        val capabilities: Capabilities,
        val source: CapabilitiesDiscovery.Source,
        val cached: Boolean,
        val updateApp: Boolean,
        /** True when the default backend was unreachable and the tier 1 demo answered instead. */
        val usingFallback: Boolean = false,
    ) : CapabilitiesState {
        val forThisApp: Capabilities get() = capabilities.forThisApp()
    }

    /** "This server needs a newer version of the app", with nothing cached to fall back on. */
    data object UpdateApp : CapabilitiesState

    /** Unreachable or not a Caddie backend, with nothing cached. */
    data object Unreachable : CapabilitiesState
}

sealed interface ConferencesState {
    data object Loading : ConferencesState

    /** [offline] is true when the list is the cached copy because the network failed. */
    data class Ready(
        val conferences: List<IndexedConference>,
        val publisher: Publisher?,
        val offline: Boolean,
    ) : ConferencesState

    /** The backend publishes no talk bundles. */
    data object NoBundles : ConferencesState

    /** The list could not be read: "update_app", "offline" or another reason, with nothing cached. */
    data class Failed(val reason: String) : ConferencesState
}

sealed interface BundleState {
    data object None : BundleState

    data class Loading(val slug: String) : BundleState

    data class Ready(val bundle: TalkBundle, val search: TalkSearch, val offline: Boolean = false) : BundleState

    /** The conference's bundle could not be loaded and none is installed. */
    data class Failed(val slug: String, val reason: Reason, val problems: List<String> = emptyList()) : BundleState

    enum class Reason { Offline, Invalid, UpdateApp, NotPublished }
}

/**
 * The shared core of the app: it owns the database, the bundle cache and the network client, and
 * publishes one [CoreState] for the screens. All work runs in [scope]; the screens call the
 * functions below and render [state].
 *
 * [allowLocalHttp] is true in debug builds only. It lets the backend and its bundle base be plain
 * http on the developer's machine (see [BackendUrl]).
 */
class CaddieCore(
    private val database: CaddieDatabase,
    private val files: BundleFiles,
    private val http: Http,
    private val scope: CoroutineScope,
    private val allowLocalHttp: Boolean,
    private val clock: Clock = Clock.System,
) {
    private val sync = BundleSync(http, database, files) { clock.now().toEpochMilliseconds() }
    private val mutex = Mutex()
    private val defaultBackend = BackendUrl.normalise(Defaults.BACKEND) as BackendUrl.Valid
    private val _state = MutableStateFlow(CoreState(defaultBackend, isDefaultBackend = true))
    val state: StateFlow<CoreState> = _state.asStateFlow()
    private var refreshJob: Job? = null

    /** Loads what is stored, then refreshes from the network. Call once at start-up. */
    fun start() {
        refreshJob = scope.launch {
            mutex.withLock {
                val chosen = database.setting(KEY_BACKEND)?.let { BackendUrl.normalise(it, allowLocalHttp) as? BackendUrl.Valid }
                val backend = chosen ?: defaultBackend
                _state.value = CoreState(backend, isDefaultBackend = chosen == null)
                loadBackend(backend, refresh = true)
            }
        }
    }

    /**
     * Fetches the capabilities, the conference list and the selected bundle again. Without [force],
     * the conference list is fetched only when the stored copy is older than 15 minutes.
     */
    fun refresh(force: Boolean = false) {
        if (refreshJob?.isActive == true) return
        refreshJob = scope.launch {
            mutex.withLock {
                val backend = _state.value.backend
                val fetchedAt = (bundleBase(_state.value.capabilities, backend))?.let { sync.indexFetchedAt(it) }
                val stale = fetchedAt == null || clock.now().toEpochMilliseconds() - fetchedAt > INDEX_REFRESH_MS
                if (force || stale) loadBackend(backend, refresh = true)
            }
        }
    }

    /**
     * Switches to [backend] after the person confirmed it (Settings, or the confirmation screen of a
     * connect link). Everything stored for the previous backend stays, so switching back finds it.
     * Null returns to the build's default backend.
     */
    fun setBackend(backend: BackendUrl.Valid?) {
        refreshJob?.cancel()
        refreshJob = scope.launch {
            mutex.withLock {
                database.setSetting(KEY_BACKEND, backend?.base)
                val target = backend ?: defaultBackend
                _state.value = CoreState(target, isDefaultBackend = backend == null || backend.base == defaultBackend.base)
                loadBackend(target, refresh = true)
            }
        }
    }

    /** Selects the conference [slug] of the current backend and loads its bundle. */
    fun selectConference(slug: String) {
        scope.launch {
            mutex.withLock {
                val s = _state.value
                database.setSetting(KEY_CONFERENCE + s.backend.base, slug)
                _state.update { it.copy(selectedSlug = slug) }
                loadBundle(s.backend, slug, refresh = true)
            }
        }
    }

    suspend fun search(request: SearchRequest): SearchResult? =
        (_state.value.bundle as? BundleState.Ready)?.search?.search(request)

    /** Marks or unmarks a talk of the selected conference. */
    fun setInterested(talkId: String, interested: Boolean) {
        scope.launch {
            val s = _state.value
            val slug = s.selectedSlug ?: return@launch
            val key = BundleSync.scope(s.backend.base, slug)
            database.setInterested(key, talkId, interested, clock.now().toEpochMilliseconds())
            val list = database.interested(key)
            _state.update { if (it.selectedSlug == slug && it.backend == s.backend) it.copy(interested = list) else it }
        }
    }

    /** A setting of the screens (such as the theme), kept on this device for every backend. */
    suspend fun uiSetting(name: String): String? = database.setting(KEY_UI + name)

    fun setUiSetting(name: String, value: String?) {
        scope.launch { database.setSetting(KEY_UI + name, value) }
    }

    /** Bytes of stored bundles. */
    suspend fun cacheSizeBytes(): Long = database.run { files.sizeBytes() }

    /**
     * Deletes every downloaded bundle and cached list, then downloads the selected conference again.
     * Interested lists and settings stay.
     */
    fun clearCache() {
        refreshJob?.cancel()
        refreshJob = scope.launch {
            mutex.withLock {
                database.clearBundles()
                database.run { files.clear() }
                val s = _state.value
                _state.value = s.copy(conferences = ConferencesState.Loading, bundle = BundleState.None)
                loadBackend(s.backend, refresh = true)
            }
        }
    }

    // ---------------------------------------------------------------------------------------------

    private suspend fun loadBackend(backend: BackendUrl.Valid, refresh: Boolean) {
        val caps = capabilities(backend)
        _state.update { if (it.backend == backend) it.copy(capabilities = caps) else it }
        val bundleBase = bundleBase(caps, backend)
        if (bundleBase == null) {
            _state.update {
                it.copy(
                    conferences = if (caps is CapabilitiesState.Ready) ConferencesState.NoBundles else ConferencesState.Failed("offline"),
                    bundle = BundleState.None,
                )
            }
            return
        }
        val result = sync.index(bundleBase, refresh)
        val index = result.index
        val conferences = when {
            index != null && index.ok -> ConferencesState.Ready(index.conferences, index.publisher, offline = !result.fresh)
            index != null && index.reason == "update_app" -> ConferencesState.Failed("update_app")
            // The backend names a bundle base but has published nothing there yet.
            result.error == "status 404" -> ConferencesState.NoBundles
            else -> ConferencesState.Failed(result.error ?: "invalid")
        }
        val stored = database.setting(KEY_CONFERENCE + backend.base)
        val slug = (conferences as? ConferencesState.Ready)?.conferences?.let { list ->
            list.firstOrNull { it.conference.slug == stored }?.conference?.slug ?: defaultConference(list, clock.now().toEpochMilliseconds())
        } ?: stored
        _state.update { if (it.backend == backend) it.copy(conferences = conferences, selectedSlug = slug) else it }
        if (slug != null) loadBundle(backend, slug, refresh)
    }

    private suspend fun loadBundle(backend: BackendUrl.Valid, slug: String, refresh: Boolean) {
        val key = BundleSync.scope(backend.base, slug)
        val interested = database.interested(key)
        val installed = sync.installed(backend.base, key)
        _state.update {
            if (it.backend != backend) return@update it
            it.copy(
                interested = interested,
                bundle = if (installed != null) ready(installed, key, offline = false) else BundleState.Loading(slug),
            )
        }
        val conferences = _state.value.conferences as? ConferencesState.Ready
        val entry = conferences?.conferences?.firstOrNull { it.conference.slug == slug }
        val bundleBase = bundleBase(_state.value.capabilities, backend)
        val next: BundleState = when {
            entry == null || bundleBase == null ->
                installed?.let { ready(it, key, offline = true) } ?: BundleState.Failed(slug, BundleState.Reason.Offline)
            entry.bundleStatus == BundleStatus.Unsupported ->
                installed?.let { ready(it, key, offline = false) } ?: BundleState.Failed(slug, BundleState.Reason.UpdateApp)
            entry.bundle == null ->
                installed?.let { ready(it, key, offline = false) } ?: BundleState.Failed(slug, BundleState.Reason.NotPublished)
            !refresh && installed != null -> ready(installed, key, offline = false)
            else -> when (val r = sync.install(backend.base, key, bundleBase, slug, entry.bundle)) {
                is BundleSync.InstallResult.Installed -> ready(r.bundle, key, offline = conferences.offline)
                is BundleSync.InstallResult.Failed -> r.kept?.let { ready(it, key, offline = true) }
                    ?: BundleState.Failed(
                        slug,
                        if (r.problems.any { it.endsWith("download failed") }) BundleState.Reason.Offline else BundleState.Reason.Invalid,
                        r.problems,
                    )
            }
        }
        _state.update { if (it.backend == backend && it.selectedSlug == slug) it.copy(bundle = next) else it }
    }

    private fun ready(bundle: TalkBundle, key: String, offline: Boolean) =
        BundleState.Ready(bundle, TalkSearch(bundle, key, database) { clock.now() }, offline)

    /** Discovers [backend]'s capabilities, keeping the last good result per backend base. */
    private suspend fun capabilities(backend: BackendUrl.Valid): CapabilitiesState {
        val base = backend.base
        val hadDocument = database.setting(KEY_HAD_DOCUMENT + base) == "1"
        val cached = cachedCapabilities(base)
        return when (val r = CapabilitiesDiscovery.discover(base, http, hadDocument, allowLocalHttp)) {
            is CapabilitiesDiscovery.Result.Found -> {
                if (r.source != CapabilitiesDiscovery.Source.Legacy) database.setSetting(KEY_HAD_DOCUMENT + base, "1")
                database.setSetting(KEY_CAPABILITIES + base, encode(r.source, r.document))
                CapabilitiesState.Ready(r.capabilities, r.source, cached = false, updateApp = false)
            }
            CapabilitiesDiscovery.Result.UpdateApp ->
                cached?.copy(updateApp = true) ?: CapabilitiesState.UpdateApp
            CapabilitiesDiscovery.Result.Unreachable -> cached?.copy(cached = true) ?: fallback(backend)
        }
    }

    // The default backend could not be reached and nothing is cached: try the tier 1 demo for talks.
    private suspend fun fallback(backend: BackendUrl.Valid): CapabilitiesState {
        if (backend.base != defaultBackend.base) return CapabilitiesState.Unreachable
        val demo = BackendUrl.normalise(Defaults.FALLBACK_BACKEND) as BackendUrl.Valid
        val r = CapabilitiesDiscovery.discover(demo.base, http, hadDocument = true)
        return if (r is CapabilitiesDiscovery.Result.Found) {
            // Only the talk features come from the demo; it offers no people features anyway.
            CapabilitiesState.Ready(
                Capabilities.None.copy(tier = r.capabilities.tier, talks = r.capabilities.talks),
                r.source,
                cached = false,
                updateApp = false,
                usingFallback = true,
            )
        } else {
            CapabilitiesState.Unreachable
        }
    }

    private suspend fun cachedCapabilities(base: String): CapabilitiesState.Ready? {
        val text = database.setting(KEY_CAPABILITIES + base) ?: return null
        val o = Capabilities.parseJson(text) as? JsonObject ?: return null
        val source = CapabilitiesDiscovery.Source.entries.firstOrNull { it.name == o["source"].asString() } ?: return null
        val caps = if (source == CapabilitiesDiscovery.Source.Legacy) {
            Capabilities.Legacy
        } else {
            val doc = o["document"] as? JsonObject ?: return null
            if (Capabilities.negotiate(doc) !is Capabilities.Negotiation.Ok) return null
            Capabilities.effective(doc, allowLocalHttp)
        }
        return CapabilitiesState.Ready(caps, source, cached = true, updateApp = false)
    }

    private fun encode(source: CapabilitiesDiscovery.Source, document: JsonObject?): String = buildJsonObject {
        put("source", source.name)
        if (document != null) put("document", document)
    }.toString()

    private fun bundleBase(caps: CapabilitiesState, backend: BackendUrl.Valid): String? {
        val ready = caps as? CapabilitiesState.Ready ?: return null
        return ready.capabilities.talks.bundleBase
            ?: if (ready.source == CapabilitiesDiscovery.Source.Legacy || backend.base == defaultBackend.base) Defaults.FALLBACK_BUNDLE_BASE else null
    }

    companion object {
        private const val KEY_BACKEND = "backend"
        private const val KEY_CONFERENCE = "conference:"
        private const val KEY_CAPABILITIES = "capabilities:"
        private const val KEY_HAD_DOCUMENT = "had_document:"
        private const val KEY_UI = "ui:"

        /** The conference list is fetched at most this often in the foreground. */
        const val INDEX_REFRESH_MS = 15 * 60 * 1000L

        /**
         * The conference to open when none was chosen: the next searchable conference that has not
         * ended, else the most recent one with a bundle.
         */
        fun defaultConference(list: List<IndexedConference>, nowMs: Long): String? {
            val withBundle = list.filter { it.bundle != null }
            if (withBundle.isEmpty()) return list.firstOrNull()?.conference?.slug
            val today = kotlin.time.Instant.fromEpochMilliseconds(nowMs).toString().substring(0, 10)
            return (withBundle.firstOrNull { (it.conference.endDate ?: it.conference.startDate ?: "") >= today } ?: withBundle.last())
                .conference.slug
        }
    }
}
