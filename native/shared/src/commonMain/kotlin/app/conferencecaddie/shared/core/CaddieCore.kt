package app.conferencecaddie.shared.core

import app.conferencecaddie.shared.BackendUrl
import app.conferencecaddie.shared.Capabilities
import app.conferencecaddie.shared.CapabilitiesDiscovery
import app.conferencecaddie.shared.Embedder
import app.conferencecaddie.shared.asString
import app.conferencecaddie.shared.bundle.BundleEntry
import app.conferencecaddie.shared.bundle.BundleFiles
import app.conferencecaddie.shared.bundle.BundleStatus
import app.conferencecaddie.shared.bundle.BundleSync
import app.conferencecaddie.shared.bundle.IndexedConference
import app.conferencecaddie.shared.bundle.InterestedTalk
import app.conferencecaddie.shared.bundle.Publisher
import app.conferencecaddie.shared.bundle.Talk
import app.conferencecaddie.shared.bundle.TalkBundle
import app.conferencecaddie.shared.db.CaddieDatabase
import app.conferencecaddie.shared.importer.ImportInput
import app.conferencecaddie.shared.importer.ImportOutcome
import app.conferencecaddie.shared.importer.ImportRefusal
import app.conferencecaddie.shared.importer.LegacyInterested
import app.conferencecaddie.shared.importer.MAX_IMPORT_TEXT
import app.conferencecaddie.shared.importer.ScheduleImport
import app.conferencecaddie.shared.importer.ServerScheduleImport
import app.conferencecaddie.shared.net.Http
import app.conferencecaddie.shared.net.KtorPostJson
import app.conferencecaddie.shared.net.PostJson
import app.conferencecaddie.shared.search.ForYou
import app.conferencecaddie.shared.search.SearchRequest
import app.conferencecaddie.shared.search.SearchResult
import app.conferencecaddie.shared.search.TalkSearch
import kotlin.time.Clock
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Instant
import kotlin.time.TimeMark
import kotlin.time.TimeSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
    /** The ids of the selected conference's marked talks, in the order they were marked. */
    val interested: List<String> = emptyList(),
    /** The copies kept of the selected conference's marked talks, by talk id. */
    val interestedSnapshots: Map<String, InterestedTalk> = emptyMap(),
    /**
     * True when the data stored on this device could not be opened at start, so the app started
     * without it. The screens tell the person once and call [CaddieCore.dismissStorageReset].
     */
    val storageReset: Boolean = false,
    /** Whether meaning-based matching (the on-device query embedder) is available. */
    val semantic: SemanticState = SemanticState.Off,
    /** What the person wants to learn at the selected conference, for For you. */
    val learn: LearnInput = LearnInput(),
    /**
     * True when this launch keeps its data in memory only, because the stored database could not
     * be opened (one from a newer version of the app, or a disk that refuses it): marks made now are
     * lost when the app closes. The screens tell the person with the reset notice.
     */
    val storageInMemory: Boolean = false,
) {
    /**
     * The marked talks My schedule shows, in marking order: each from the bundle while it holds the
     * talk, else from the copy kept when it was marked. A marked talk with neither is left out.
     */
    fun interestedTalks(): List<Talk> {
        val bundle = (bundle as? BundleState.Ready)?.bundle?.takeIf { it.conference.slug == selectedSlug }
        return interested.mapNotNull { id -> bundle?.talksById?.get(id) ?: interestedSnapshots[id]?.toTalk() }
    }
}

/** The query embedder's state. Search and For you use keywords alone unless it is [Ready]. */
sealed interface SemanticState {
    /** No embedder was offered (tests, or a host without the model). */
    data object Off : SemanticState

    /** An embedder is offered but not loaded: nothing has needed it yet, or it was released. */
    data object Idle : SemanticState

    data object Loading : SemanticState

    data object Ready : SemanticState

    /** The last load failed (the model is missing or ONNX Runtime refused it); keyword search goes on, and a later search tries again. */
    data object Unavailable : SemanticState
}

/**
 * For you's input: the topic ids the person wants to learn about at the selected conference, and
 * the text of what they are trying to learn or figure out next, which is kept for every conference
 * (as the web keeps it in the profile).
 */
data class LearnInput(val topics: List<String> = emptyList(), val text: String = "") {
    val isEmpty: Boolean get() = topics.isEmpty() && text.isBlank()
}

sealed interface CapabilitiesState {
    data object Loading : CapabilitiesState

    /**
     * What the backend offers ([capabilities]) and what this app uses of it ([forThisApp]).
     * [cached] is true while the copy is the last good one stored on the device: because the backend
     * could not be reached, or, with [checking], while it is being asked again.
     * [updateApp] is true when the backend now serves only documents a newer app can read.
     */
    data class Ready(
        val capabilities: Capabilities,
        val source: CapabilitiesDiscovery.Source,
        val cached: Boolean,
        val updateApp: Boolean,
        /** True when the default backend was unreachable and the tier 1 demo answered instead. */
        val usingFallback: Boolean = false,
        /** True while the stored copy is shown and the backend is being asked again. */
        val checking: Boolean = false,
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

    /**
     * [offline] is true when the list is the cached copy because the network failed. [updateApp] is
     * true when it is the cached copy because the backend now publishes a list only a newer app
     * can read.
     */
    data class Ready(
        val conferences: List<IndexedConference>,
        val publisher: Publisher?,
        val offline: Boolean,
        val updateApp: Boolean = false,
    ) : ConferencesState

    /** The backend publishes no talk bundles. */
    data object NoBundles : ConferencesState

    /** The list could not be read: "update_app", "offline" or another reason, with nothing cached. */
    data class Failed(val reason: String) : ConferencesState
}

sealed interface BundleState {
    data object None : BundleState

    data class Loading(val slug: String) : BundleState

    /**
     * The bundle in use. [offline] is true when a newer one could not be fetched; [updateApp] is
     * true when the conference's current bundle needs a newer app, so this is the last one this app
     * could read.
     */
    data class Ready(
        val bundle: TalkBundle,
        val search: TalkSearch,
        val offline: Boolean = false,
        val updateApp: Boolean = false,
    ) : BundleState {
        val forYou: ForYou = ForYou(bundle, search)
    }

    /** The conference's bundle could not be loaded and none is installed. */
    data class Failed(val slug: String, val reason: Reason, val problems: List<String> = emptyList()) : BundleState

    enum class Reason { Offline, Invalid, UpdateApp, NotPublished }
}

/**
 * The shared core of the app: it owns the database, the bundle cache and the network client, and
 * publishes one [CoreState] for the screens. All work runs in [scope]; the screens call the
 * functions below and render [state].
 *
 * Everything stored is shown first and fetched again behind it (stale while revalidate): at start
 * the cached capabilities, the cached conference list, the stored conference, its installed bundle
 * and the marked talks appear before any request is sent, and a network that never answers only
 * keeps the "checking" marks on. The calls below run one after another, in the order they were
 * made, under one lock that is never held across a request: requests run in jobs that take the lock
 * only to publish what they found, and only if the backend and the conference they worked for are
 * still the selected ones.
 *
 * [allowLocalHttp] is true in debug builds only. It lets the backend and its bundle base be plain
 * http on the developer's machine (see [BackendUrl]).
 *
 * [postJson] sends the schedule import to a backend that offers it ([importSchedule]); without one,
 * a Ktor client is made the first time it is needed, so a core that never imports through its
 * backend makes no client for it.
 */
class CaddieCore(
    private val database: CaddieDatabase,
    private val files: BundleFiles,
    private val http: Http,
    private val scope: CoroutineScope,
    private val allowLocalHttp: Boolean,
    private val clock: Clock = Clock.System,
    /** Times the pause before a failed model load is tried again; monotonic, unlike [clock]. */
    private val timeSource: TimeSource = TimeSource.Monotonic,
    private val postJson: PostJson? = null,
) {
    private val sync = BundleSync(http, database, files) { nowMs() }
    private val mutex = Mutex()
    private val serial = Dispatchers.Default.limitedParallelism(1)
    private val defaultBackend = BackendUrl.normalise(Defaults.BACKEND) as BackendUrl.Valid
    private val _state = MutableStateFlow(CoreState(defaultBackend, isDefaultBackend = true))
    val state: StateFlow<CoreState> = _state.asStateFlow()

    // Guarded by mutex. A session is one backend's state; it changes with the backend and when the
    // cache is cleared, and a job publishes only into the session it started in.
    private var session = 0L
    private var backendJob: Job? = null
    private var bundleJob: Job? = null
    private var bundleJobKey: String? = null

    // Test hooks, which do nothing in the app. They let a test hold the core at the edge of a race:
    // afterSelectionRead runs in a revalidation between reading the newly chosen conference's stored
    // state and taking the lock to publish it; afterEmbedderLoad at the end of a load of the query
    // embedder, after its state is queued and before its job ends; beforeSemanticPublish in each
    // queued publish of the embedder's state, before it is checked and written.
    @kotlin.concurrent.Volatile
    internal var afterSelectionRead: suspend () -> Unit = {}

    @kotlin.concurrent.Volatile
    internal var afterEmbedderLoad: suspend () -> Unit = {}

    @kotlin.concurrent.Volatile
    internal var beforeSemanticPublish: suspend () -> Unit = {}

    /** Shows what is stored, then fetches everything again behind it. Call once at start-up. */
    fun start() = command {
        val reset = database.wasReset()
        val inMemory = database.runsInMemory()
        val chosen = database.setting(KEY_BACKEND)?.let { BackendUrl.normalise(it, allowLocalHttp) as? BackendUrl.Valid }
        openBackend(chosen ?: defaultBackend, storageReset = reset, storageInMemory = inMemory)
    }

    /**
     * Fetches again what is due: the capabilities when the stored copy is older than its max-age
     * (an hour without one) or could not be refreshed, and the conference list when it is older than
     * 15 minutes or is the offline copy. [force] fetches both. Nothing happens while a fetch runs.
     */
    fun refresh(force: Boolean = false) = command {
        if (backendJob?.isActive == true) return@command
        val s = _state.value
        val caps = s.capabilities
        val capsDue = force || caps !is CapabilitiesState.Ready || caps.cached || capabilitiesExpired(s.backend.base)
        val fetchedAt = bundleBase(caps, s.backend)?.let { sync.indexFetchedAt(it) }
        val conferences = s.conferences
        val indexDue = force || conferences !is ConferencesState.Ready || conferences.offline ||
            fetchedAt == null || nowMs() - fetchedAt > INDEX_REFRESH_MS
        if (!capsDue && !indexDue) return@command
        val id = session
        backendJob = launchGuarded { revalidate(s.backend, id, capsDue, indexDue) }
    }

    /**
     * Switches to [backend] after the person confirmed it (Settings, or the confirmation screen of a
     * connect link). Everything stored for the previous backend stays, so switching back finds it.
     * Null returns to the build's default backend.
     *
     * [typed] is false for a server that came from a link or QR code. Only a typed server (in a
     * debug build, where [allowLocalHttp] is true) may name a plain http bundle base on a local
     * host; the mark is kept per backend base, so a link can never turn it on.
     */
    fun setBackend(backend: BackendUrl.Valid?, typed: Boolean = true) = command {
        database.setSetting(KEY_BACKEND, backend?.base)
        if (backend != null) database.setSetting(KEY_TYPED + backend.base, if (typed) "1" else null)
        openBackend(backend ?: defaultBackend)
    }

    /**
     * Selects the conference [slug] of the current backend: its installed bundle and marked talks
     * appear together, then its bundle is fetched if a newer one is listed. A list being fetched
     * meanwhile keeps this choice.
     */
    fun selectConference(slug: String) = command {
        val s = _state.value
        database.setSetting(KEY_CONFERENCE + s.backend.base, slug)
        val selected = if (s.selectedSlug != slug || s.bundle !is BundleState.Ready) {
            bundleJob?.cancel()
            bundleJobKey = null
            withSelection(s, slug)
        } else {
            s
        }
        _state.value = ensureBundle(selected)
    }

    /** Searches the selected conference's bundle, off the main thread; null while no bundle is ready. */
    suspend fun search(request: SearchRequest): SearchResult? {
        val ready = _state.value.bundle as? BundleState.Ready ?: return null
        // The model is needed only for a text whose embedding is not cached, so a released model is
        // not loaded again by a search that only changes filters.
        val text = ready.search.embeddedText(request)
        if (text.isNotEmpty() && !ready.search.hasQueryVector(text)) ensureEmbedder()
        return withContext(Dispatchers.Default) { ready.search.search(request) }
    }

    // The query embedder. It is loaded only once something needs meaning-based matching (a text
    // search, or For you with learn text), not at every start, and is guarded by embedderMutex.
    // embedderGeneration counts the loads and releases, so a state written for one of them is
    // dropped once another has happened; releaseRequested is a release asked for during a load.
    // embedderJob is the load in progress until it has recorded its result.
    @kotlin.concurrent.Volatile
    private var embedder: Embedder? = null
    private var loader: (suspend () -> Embedder?)? = null
    private var embedderJob: Job? = null
    private var embedderFailures = 0
    private var embedderRetryAt: TimeMark? = null
    private var embedderGeneration = 0L
    private var releaseRequested = false
    private val embedderMutex = Mutex()

    /**
     * Offers the query embedder. Nothing is loaded yet ([SemanticState.Idle]): [load] runs, in the
     * background, on the first text search or For you request that needs it. While it runs, and if it
     * returns null or throws, search and For you use keywords alone; a failed load is tried again
     * by a later search after a pause that doubles each time (from [RETRY_FIRST_MS] up to
     * [RETRY_MAX_MS]). [CoreState.semantic] says which, so the screens can search again once the
     * model is ready.
     */
    fun useEmbedder(load: suspend () -> Embedder?) = command {
        // Through the core's queue, so of two offers the first one made is the one kept.
        embedderMutex.withLock {
            if (loader != null) return@command
            loader = load
        }
        _state.update { if (it.semantic == SemanticState.Off) it.copy(semantic = SemanticState.Idle) else it }
    }

    /**
     * Gives the embedder's memory back (the platform asked for memory). A load still running is
     * released as soon as it finishes. The next text search that needs the model loads it again.
     * The returned job ends once the release is done or recorded.
     */
    fun releaseEmbedder(): Job =
        scope.launch {
            val (released, generation) = embedderMutex.withLock {
                val e = embedder
                if (e == null) {
                    if (embedderJob?.isActive == true) releaseRequested = true
                    return@launch
                }
                embedder = null
                e to ++embedderGeneration
            }
            released.close()
            embedderMutex.withLock {
                // Worked out under the lock. With no load running, the model is gone, so the state
                // is Idle, Loading included: the load that loaded it may have had its Ready dropped
                // for this release. A load started meanwhile keeps its own state.
                val running = embedderJob?.isActive == true
                publishSemantic(generation) { if (!running && (it == SemanticState.Ready || it == SemanticState.Loading)) SemanticState.Idle else it }
            }
        }

    /** Starts loading the embedder when it is offered, not loaded, not loading and not resting after a failure. */
    private suspend fun ensureEmbedder() {
        embedderMutex.withLock {
            val load = loader ?: return
            if (embedder != null || embedderJob?.isActive == true) return
            if (embedderRetryAt?.hasNotPassedNow() == true) return
            embedderJob = scope.launch { loadEmbedder(load) }
        }
    }

    private suspend fun loadEmbedder(load: suspend () -> Embedder?) {
        val started = embedderMutex.withLock { embedderGeneration }
        publishSemantic(started) { SemanticState.Loading }
        val loaded = try {
            load()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            null
        }
        // One section records the result, ends the load and queues its state. The load is over
        // here, a little before this job ends: without clearing embedderJob, a search made as soon
        // as the state is seen could find the job still active and start no load. A release finds
        // either this load or its model, never neither, and the state is queued before that of any
        // load started after this one.
        val unwanted = embedderMutex.withLock {
            val unwanted = loaded?.takeIf { releaseRequested }
            releaseRequested = false
            embedder = if (unwanted != null) null else loaded
            if (loaded == null) {
                embedderFailures++
                val pause = RETRY_FIRST_MS shl (embedderFailures - 1).coerceAtMost(10)
                embedderRetryAt = timeSource.markNow() + pause.coerceAtMost(RETRY_MAX_MS).milliseconds
            } else {
                embedderFailures = 0
                embedderRetryAt = null
            }
            embedderJob = null
            val next = when {
                loaded == null -> SemanticState.Unavailable
                unwanted != null -> SemanticState.Idle
                else -> SemanticState.Ready
            }
            publishSemantic(++embedderGeneration) { next }
            unwanted
        }
        // A model released during its load is closed outside the lock, so closing holds up no search.
        unwanted?.close()
        afterEmbedderLoad()
    }

    // Publishes the embedder's state for [generation], unless a later load or release has happened.
    private fun publishSemantic(generation: Long, next: (SemanticState) -> SemanticState) = command {
        beforeSemanticPublish()
        if (embedderMutex.withLock { embedderGeneration } != generation) return@command
        _state.update { it.copy(semantic = next(it.semantic)) }
    }

    /**
     * Talks for you at the selected conference, from [CoreState.learn] and the marked talks, worked
     * out off the main thread; null while no bundle is ready.
     */
    suspend fun forYou(size: Int = 20): ForYou.Result? {
        val s = _state.value
        val ready = s.bundle as? BundleState.Ready ?: return null
        if (ready.bundle.conference.slug != s.selectedSlug) return null
        val request = ForYou.Request(s.learn.topics, s.learn.text, s.interested.toSet(), size)
        val text = ready.forYou.embeddedText(request)
        if (text.isNotEmpty() && !ready.search.hasQueryVector(text)) ensureEmbedder()
        return withContext(Dispatchers.Default) { ready.forYou.recommend(request, nowMs()) }
    }

    /** Sets the topics the person wants to learn about at the selected conference. */
    fun setLearnTopics(topicIds: List<String>) = command {
        val s = _state.value
        val slug = s.selectedSlug ?: return@command
        val topics = topicIds.distinct().take(ForYou.MAX_TOPICS)
        database.setSetting(KEY_LEARN_TOPICS + BundleSync.scope(s.backend.base, slug), JsonArray(topics.map { JsonPrimitive(it) }).toString())
        _state.update { if (it.selectedSlug == slug && it.backend == s.backend) it.copy(learn = it.learn.copy(topics = topics)) else it }
    }

    /** Sets what the person is trying to learn or figure out next (for every conference). */
    fun setLearnText(text: String) = command {
        val value = text.take(ForYou.MAX_TEXT)
        database.setSetting(KEY_LEARN_TEXT, value.ifEmpty { null })
        _state.update { it.copy(learn = it.learn.copy(text = value)) }
    }

    private suspend fun learnInput(key: String): LearnInput {
        val topics = database.setting(KEY_LEARN_TOPICS + key)?.let { text ->
            runCatching { (Capabilities.parseJson(text) as? JsonArray)?.mapNotNull { it.asString() } }.getOrNull()
        }.orEmpty()
        return LearnInput(topics, database.setting(KEY_LEARN_TEXT).orEmpty())
    }

    /**
     * Marks or unmarks a talk. The conference comes from the talk id (`{slug}:{id}`), so a tap that
     * races a conference switch still lands in the talk's own conference.
     */
    fun setInterested(talkId: String, interested: Boolean) = mark(talkId, null, interested)

    /** As [setInterested], keeping a copy of [talk] with the mark. */
    fun setInterested(talk: Talk, interested: Boolean) = mark(talk.talkId, talk, interested)

    /**
     * Marks or unmarks every talk of [talks] in one call, in their order, keeping a copy of each
     * marked talk as [setInterested] does, and publishes the selected conference's list once at the end, so the
     * screens never show half of an import (or of a cleared list) in between. Each talk lands in its
     * own conference, from its id.
     */
    fun setInterested(talks: List<Talk>, interested: Boolean) = command {
        if (talks.isEmpty()) return@command
        val s = _state.value
        val bySlug = talks.withIndex().groupBy { it.value.talkId.substringBefore(':', "") }.filterKeys { it.isNotEmpty() }
        val now = nowMs()
        for ((slug, list) in bySlug) {
            val key = BundleSync.scope(s.backend.base, slug)
            // One millisecond apart, in the order given, so the list keeps that order (the marks are
            // read back by when they were made): an import in the file's order, an Undo of Clear
            // list in the order the talks had been marked.
            for ((index, talk) in list) {
                database.setInterested(key, talk.talkId, interested, now + index, if (interested) InterestedTalk.from(talk) else null)
            }
        }
        val selected = s.selectedSlug
        if (selected != null && selected in bySlug) {
            val key = BundleSync.scope(s.backend.base, selected)
            _state.value = _state.value.copy(interested = database.interested(key), interestedSnapshots = database.interestedSnapshots(key))
        }
    }

    /**
     * Keeps the Interested lists the Capacitor app left in its WebView's local storage ([lists]:
     * each storage key with its value, as the host read them), then sets the UI setting [doneKey], so
     * the host does not read them again. The marks and the setting are written in one transaction
     * after everything was read, so the setting is never there without the marks: a failure (a full
     * disk, a process ended midway) leaves neither, and the next start tries again.
     *
     * That app always talked to the official server, so the marks go to the build's default backend,
     * each conference's in the order they were made and before the first mark made in this app; a
     * talk already marked here keeps its own mark. Keys and values are untrusted; [LegacyInterested]
     * checks and bounds them.
     */
    fun importLegacyInterested(lists: Map<String, String>, doneKey: String) = command {
        val base = defaultBackend.base
        val now = nowMs()
        val rows = ArrayList<CaddieDatabase.NewMark>()
        for ((key, value) in lists.entries.take(100)) {
            val slug = LegacyInterested.slugOf(key) ?: continue
            val scope = BundleSync.scope(base, slug)
            val have = database.interested(scope).toSet()
            val marks = LegacyInterested.read(slug, value).filter { it.talkId !in have }
            // Strictly before the first mark made in this app, one millisecond apart, in their order.
            val first = database.firstInterestedAt(scope) ?: now
            var at = first - marks.size
            for (mark in marks) rows += CaddieDatabase.NewMark(scope, mark.talkId, at++, mark.copy)
        }
        database.addMarksThenSet(rows, KEY_UI + doneKey, "1")
        val s = _state.value
        val selected = s.selectedSlug
        if (s.backend.base == base && selected != null) {
            val scope = BundleSync.scope(base, selected)
            _state.value = s.copy(interested = database.interested(scope), interestedSnapshots = database.interestedSnapshots(scope))
        }
    }

    // The client for the backend's schedule import, made on first use.
    private val importPoster: PostJson by lazy { postJson ?: KtorPostJson() }

    /**
     * Imports a schedule for the selected conference: finds its talks in [input] and returns them for
     * the person to review, without marking or storing anything (DECISIONS.md, "Import my schedule").
     *
     * The input is checked first, as the backends check it ([ScheduleImport.check]). Then, when the
     * backend's capabilities say `imports.schedule: server`, the backend's `POST /api/import/schedule`
     * reads it; otherwise, and whenever the backend gives no usable answer (no network, a timeout, a
     * server error or limit, an unexpected body), the device reads it over the installed bundle with
     * the same rules, so the import works offline and on every tier. A refusal the backend words
     * itself (a file too large or unreadable for it) is passed on. A file whose text is longer than
     * the 200,000 characters the backend takes as text is read on the device, and so is everything
     * while the app is using its stored capabilities because the backend did not answer.
     *
     * Parsing and matching run off the main thread. [ImportRefusal.Unavailable] when no bundle of the
     * selected conference is ready.
     */
    suspend fun importSchedule(input: ImportInput): ImportOutcome = try {
        importOrRefuse(input)
    } catch (e: CancellationException) {
        throw e
    } catch (_: Throwable) {
        // A file or answer the bounds did not foresee (an allocation that fails included) refuses the
        // import instead of ending the app.
        ImportOutcome.Refused(ImportRefusal.Unavailable)
    }

    private suspend fun importOrRefuse(input: ImportInput): ImportOutcome {
        val s = _state.value
        val ready = s.bundle as? BundleState.Ready ?: return ImportOutcome.Refused(ImportRefusal.Unavailable)
        val slug = s.selectedSlug
        if (slug == null || ready.bundle.conference.slug != slug) return ImportOutcome.Refused(ImportRefusal.Unavailable)
        val prepared = when (val checked = withContext(Dispatchers.Default) { ScheduleImport.check(input) }) {
            is ScheduleImport.Checked.Refused -> return ImportOutcome.Refused(checked.reason)
            is ScheduleImport.Checked.Ok -> checked.prepared
        }
        val caps = s.capabilities as? CapabilitiesState.Ready
        val onServer = caps != null && !caps.updateApp && caps.capabilities.imports.schedule == Capabilities.ImportSite.Server &&
            !caps.usingFallback && !(caps.cached && !caps.checking) && prepared.text.length <= MAX_IMPORT_TEXT
        if (onServer) {
            val hints = caps.source != CapabilitiesDiscovery.Source.Legacy
            when (val answer = ServerScheduleImport(importPoster).run(s.backend.base, slug, prepared, hints, ready.bundle)) {
                is ServerScheduleImport.Answer.Done -> return ImportOutcome.Done(answer.result, onServer = true)
                is ServerScheduleImport.Answer.Refused -> return answer.outcome
                ServerScheduleImport.Answer.Fallback -> Unit
            }
        }
        val result = withContext(Dispatchers.Default) { ScheduleImport.onDevice(prepared, ready.bundle) }
        return ImportOutcome.Done(result, onServer = false)
    }

    /** Clears [CoreState.storageReset] once the person has been told, in order with every other call. */
    fun dismissStorageReset() = command {
        _state.value = _state.value.copy(storageReset = false)
    }

    /**
     * Waits until every call made before it has run and every fetch they started has finished, as
     * the next call would see it. For tests, and for a host that must close the database. It does
     * not wait for the query embedder to load or be released; [CoreState.semantic] tells that.
     */
    suspend fun awaitIdle() {
        while (true) {
            // Through the same queue and lock as the calls, so the ones made earlier run first.
            val running = withContext(serial) { mutex.withLock { listOfNotNull(backendJob, bundleJob).filter { it.isActive } } }
            if (running.isEmpty()) return
            running.joinAll()
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
    fun clearCache() = command {
        // A running download may be writing files; let it stop before they are deleted.
        backendJob?.cancelAndJoin()
        bundleJob?.cancelAndJoin()
        bundleJobKey = null
        database.clearBundles()
        database.run { files.clear() }
        session++
        val id = session
        val s = _state.value
        _state.value = s.copy(conferences = ConferencesState.Loading, bundle = BundleState.None)
        backendJob = launchGuarded { revalidate(s.backend, id, refreshCapabilities = true, refreshIndex = true) }
    }

    // ---------------------------------------------------------------------------------------------
    // Under the lock

    // Runs [block] under the lock, after every call made before it. A failure leaves the state as
    // it was rather than ending the app. It never runs [block] inline: publishSemantic calls it while
    // holding embedderMutex, and the block takes embedderMutex again.
    private fun command(block: suspend () -> Unit) {
        scope.launch(serial) {
            try {
                mutex.withLock { block() }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Throwable) {
                // The next call or refresh starts again from the stored state. Errors are caught
                // too: an allocation a hostile bundle makes fail must not end the app at every start.
            }
        }
    }

    private fun launchGuarded(block: suspend () -> Unit): Job = scope.launch {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Throwable) {
            // As in command(): the state stays as it was.
        }
    }

    /** Shows what is stored for [backend], then starts fetching it again. */
    private suspend fun openBackend(
        backend: BackendUrl.Valid,
        storageReset: Boolean = _state.value.storageReset,
        storageInMemory: Boolean = _state.value.storageInMemory,
    ) {
        backendJob?.cancel()
        bundleJob?.cancel()
        bundleJobKey = null
        session++
        val id = session
        val caps = storedCapabilities(backend.base)?.state?.copy(checking = true)
        // The embedder belongs to the app, not to a backend, so its state carries over.
        var s = CoreState(
            backend,
            isDefault(backend),
            capabilities = caps ?: CapabilitiesState.Loading,
            storageReset = storageReset,
            semantic = _state.value.semantic,
            storageInMemory = storageInMemory,
        )
        val index = caps?.let { bundleBase(it, backend) }?.let { sync.cachedIndex(it) }
        if (index != null) {
            val list = index.conferences
            s = s.copy(conferences = ConferencesState.Ready(list, index.publisher, offline = false))
            chooseSlug(backend, list, current = null)?.let { s = withSelection(s, it) }
        } else {
            // No stored list: still show the stored conference's bundle when it is installed.
            database.setting(KEY_CONFERENCE + backend.base)?.let { s = withSelection(s, it) }
        }
        _state.value = s
        backendJob = launchGuarded { revalidate(backend, id, refreshCapabilities = true, refreshIndex = true) }
    }

    /** [s] with [slug] selected: its installed bundle and its marked talks, in one value. */
    private suspend fun withSelection(s: CoreState, slug: String): CoreState = withStoredMarks(withInstalledBundle(s, slug))

    /** [s] with [slug] selected and its installed bundle, but not yet its marks ([withStoredMarks]). */
    private suspend fun withInstalledBundle(s: CoreState, slug: String): CoreState {
        val key = BundleSync.scope(s.backend.base, slug)
        val current = (s.bundle as? BundleState.Ready)?.takeIf { s.selectedSlug == slug }
        val installed = current?.bundle ?: sync.installed(s.backend.base, key)
        if (installed != null) database.refreshInterested(key, installed)
        return s.copy(
            selectedSlug = slug,
            bundle = installed?.let { current ?: ready(it, key, offline = false, updateApp = false, previous = null) } ?: BundleState.Loading(slug),
        )
    }

    /** [s] with the marked talks and the learn input stored for its selected conference. */
    private suspend fun withStoredMarks(s: CoreState): CoreState {
        val key = BundleSync.scope(s.backend.base, s.selectedSlug ?: return s)
        return s.copy(interested = database.interested(key), interestedSnapshots = database.interestedSnapshots(key), learn = learnInput(key))
    }

    /**
     * [s] with the selected conference's bundle in line with the conference list: the installed
     * one when it is current or cannot be replaced, else its download is started (once per bundle).
     * The caller publishes the result in one write, so no one sees a list and a bundle that
     * disagree.
     */
    private fun ensureBundle(s: CoreState): CoreState {
        val slug = s.selectedSlug ?: return s
        val conferences = s.conferences
        if (conferences is ConferencesState.Loading) return s
        val list = conferences as? ConferencesState.Ready
        val key = BundleSync.scope(s.backend.base, slug)
        val installed = s.bundle as? BundleState.Ready
        val entry = list?.conferences?.firstOrNull { it.conference.slug == slug }
        val bundleBase = bundleBase(s.capabilities, s.backend)
        val offline = list?.offline ?: true
        val next: BundleState? = when {
            entry == null || bundleBase == null ->
                installed?.copy(offline = true, updateApp = false) ?: BundleState.Failed(slug, BundleState.Reason.Offline)
            entry.bundleStatus == BundleStatus.Unsupported ->
                installed?.copy(offline = offline, updateApp = true) ?: BundleState.Failed(slug, BundleState.Reason.UpdateApp)
            entry.bundle == null ->
                installed?.copy(offline = offline, updateApp = false) ?: BundleState.Failed(slug, BundleState.Reason.NotPublished)
            installed != null && installed.bundle.contentHash == entry.bundle.contentHash -> installed.copy(offline = offline, updateApp = false)
            else -> null
        }
        if (next != null) {
            bundleJob?.cancel()
            bundleJobKey = null
            return s.copy(bundle = next)
        }
        val bundle = entry!!.bundle!!
        val jobKey = key + "\n" + bundle.contentHash
        if (bundleJobKey == jobKey && bundleJob?.isActive == true) return s
        bundleJob?.cancel()
        bundleJobKey = jobKey
        val id = session
        bundleJob = launchGuarded { download(id, s.backend, slug, bundleBase!!, bundle, installed, offline, jobKey) }
        return s.copy(bundle = installed?.copy(offline = offline, updateApp = false) ?: BundleState.Loading(slug))
    }

    private fun mark(talkId: String, talk: Talk?, on: Boolean) = command {
        val slug = talkId.substringBefore(':', "")
        if (slug.isEmpty()) return@command
        val s = _state.value
        val key = BundleSync.scope(s.backend.base, slug)
        val snapshot = if (!on) {
            null
        } else {
            (talk ?: (s.bundle as? BundleState.Ready)?.bundle?.talksById?.get(talkId))?.let(InterestedTalk::from)
                ?: s.interestedSnapshots[talkId]
        }
        database.setInterested(key, talkId, on, nowMs(), snapshot)
        if (s.selectedSlug == slug) {
            _state.value = _state.value.copy(interested = database.interested(key), interestedSnapshots = database.interestedSnapshots(key))
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Jobs: requests without the lock, then a publish under it

    /** Fetches the capabilities and the conference list of [backend] again, as asked. */
    private suspend fun revalidate(backend: BackendUrl.Valid, id: Long, refreshCapabilities: Boolean, refreshIndex: Boolean) {
        val before = _state.value
        var caps = before.capabilities
        if (refreshCapabilities || caps !is CapabilitiesState.Ready) {
            val fresh = capabilities(backend)
            caps = fresh
            if (!publish(id) { it.copy(capabilities = fresh) }) return
        }
        val bundleBase = bundleBase(caps, backend)
        if (bundleBase == null) {
            val conferences = when (caps) {
                is CapabilitiesState.Ready -> ConferencesState.NoBundles
                CapabilitiesState.UpdateApp -> ConferencesState.Failed("update_app")
                else -> ConferencesState.Failed("offline")
            }
            publish(id) { it.copy(conferences = conferences, bundle = BundleState.None) }
            return
        }
        val baseChanged = bundleBase != bundleBase(before.capabilities, backend)
        if (!refreshIndex && !baseChanged && before.conferences is ConferencesState.Ready) {
            mutex.withLock { if (session == id) _state.value = ensureBundle(_state.value) }
            return
        }
        val result = sync.index(bundleBase, refresh = true)
        val conferences = conferencesState(result)
        val seen = _state.value
        val list = (conferences as? ConferencesState.Ready)?.conferences
        val wanted = list?.let { chooseSlug(backend, it, current = seen.selectedSlug) } ?: seen.selectedSlug
        // The newly chosen conference's installed bundle, read before taking the lock; its marks are
        // read under the lock, below.
        val selection = if (wanted != null && wanted != seen.selectedSlug) withInstalledBundle(seen, wanted) else null
        afterSelectionRead()
        mutex.withLock {
            if (session != id) return
            val now = _state.value
            var next = now.copy(conferences = conferences)
            // A conference the person chose meanwhile wins over the list's choice.
            if (selection != null && now.selectedSlug == seen.selectedSlug) {
                // The marks and the learn text are read under the lock: a call made since the read
                // above stored its change but showed it in no list, as this conference was not
                // selected yet (a talk marked, or the Capacitor app's marks kept, at the first start).
                next = withStoredMarks(next.copy(selectedSlug = selection.selectedSlug, bundle = selection.bundle))
            }
            _state.value = ensureBundle(next)
        }
    }

    /** Downloads and installs a conference's bundle, then publishes it if it is still selected. */
    private suspend fun download(
        id: Long,
        backend: BackendUrl.Valid,
        slug: String,
        bundleBase: String,
        entry: BundleEntry,
        installed: BundleState.Ready?,
        listOffline: Boolean,
        jobKey: String,
    ) {
        val key = BundleSync.scope(backend.base, slug)
        val r = sync.install(backend.base, key, bundleBase, slug, entry, installed?.bundle)
        if (r is BundleSync.InstallResult.Installed && r.updated) database.refreshInterested(key, r.bundle)
        mutex.withLock {
            if (bundleJobKey == jobKey) bundleJobKey = null
            val s = _state.value
            if (session != id || s.selectedSlug != slug) return
            val previous = s.bundle as? BundleState.Ready
            val next: BundleState = when (r) {
                is BundleSync.InstallResult.Installed -> ready(r.bundle, key, offline = listOffline, updateApp = false, previous = previous)
                is BundleSync.InstallResult.Failed -> r.kept?.let { ready(it, key, offline = true, updateApp = false, previous = previous) }
                    ?: BundleState.Failed(
                        slug,
                        if (r.problems.any { it.endsWith(BundleSync.DOWNLOAD_FAILED) }) BundleState.Reason.Offline else BundleState.Reason.Invalid,
                        r.problems,
                    )
            }
            _state.value = s.copy(bundle = next, interestedSnapshots = database.interestedSnapshots(key))
        }
    }

    // Publishes [change] if the session is still [id]; false when it is not.
    private suspend fun publish(id: Long, change: (CoreState) -> CoreState): Boolean = mutex.withLock {
        if (session != id) return@withLock false
        _state.update(change)
        true
    }

    // ---------------------------------------------------------------------------------------------

    private fun nowMs(): Long = clock.now().toEpochMilliseconds()

    private fun isDefault(backend: BackendUrl.Valid): Boolean = backend.base == defaultBackend.base

    /** The selected conference of [list]: [current], else the stored one, else [defaultConference]. */
    private suspend fun chooseSlug(backend: BackendUrl.Valid, list: List<IndexedConference>, current: String?): String? {
        if (current != null && list.any { it.conference.slug == current }) return current
        val stored = database.setting(KEY_CONFERENCE + backend.base)
        return list.firstOrNull { it.conference.slug == stored }?.conference?.slug ?: defaultConference(list, nowMs()) ?: stored
    }

    private fun conferencesState(result: BundleSync.IndexResult): ConferencesState {
        val index = result.index
        val updateApp = result.error == "update_app"
        return when {
            index != null && index.ok -> ConferencesState.Ready(index.conferences, index.publisher, offline = !result.fresh && !updateApp, updateApp = updateApp)
            index != null && index.reason == "update_app" -> ConferencesState.Failed("update_app")
            // The backend names a bundle base but has published nothing there yet.
            result.error == "status 404" -> ConferencesState.NoBundles
            else -> ConferencesState.Failed(result.error ?: "invalid")
        }
    }

    // The bundle's search is kept when the bundle did not change, so a search in progress is not
    // thrown away by a refresh that found nothing new.
    private fun ready(bundle: TalkBundle, key: String, offline: Boolean, updateApp: Boolean, previous: BundleState.Ready?): BundleState.Ready {
        val search = previous?.takeIf { it.bundle.contentHash == bundle.contentHash && it.bundle.conference.slug == bundle.conference.slug }?.search
            ?: TalkSearch(
                bundle,
                key,
                database,
                now = { clock.now() },
                embedder = { embedder },
                embedderFailed = { _state.value.semantic == SemanticState.Unavailable },
            )
        return BundleState.Ready(previous?.bundle?.takeIf { it.contentHash == bundle.contentHash } ?: bundle, search, offline, updateApp)
    }

    /** Discovers [backend]'s capabilities, keeping the last good result per backend base. */
    private suspend fun capabilities(backend: BackendUrl.Valid): CapabilitiesState {
        val base = backend.base
        val hadDocument = database.setting(KEY_HAD_DOCUMENT + base) == "1"
        val cached = storedCapabilities(base)?.state
        return when (val r = CapabilitiesDiscovery.discover(base, http, hadDocument, localBundleBase(base))) {
            is CapabilitiesDiscovery.Result.Found -> {
                if (r.source != CapabilitiesDiscovery.Source.Legacy) database.setSetting(KEY_HAD_DOCUMENT + base, "1")
                database.setSetting(KEY_CAPABILITIES + base, encode(r.source, r.document, fallback = false, r.maxAgeSeconds))
                CapabilitiesState.Ready(r.capabilities, r.source, cached = false, updateApp = false)
            }
            CapabilitiesDiscovery.Result.UpdateApp -> cached?.copy(updateApp = true) ?: CapabilitiesState.UpdateApp
            CapabilitiesDiscovery.Result.Unreachable -> cached ?: fallback(backend)
        }
    }

    // The default backend could not be reached and nothing is cached: try the tier 1 demo for talks.
    // A demo answer is stored under the default backend, marked as the fallback, so an offline start
    // later still finds its conference list and bundle.
    private suspend fun fallback(backend: BackendUrl.Valid): CapabilitiesState {
        if (!isDefault(backend)) return CapabilitiesState.Unreachable
        val demo = BackendUrl.normalise(Defaults.FALLBACK_BACKEND) as BackendUrl.Valid
        val r = CapabilitiesDiscovery.discover(demo.base, http, hadDocument = true)
        if (r !is CapabilitiesDiscovery.Result.Found) return CapabilitiesState.Unreachable
        database.setSetting(KEY_CAPABILITIES + backend.base, encode(r.source, r.document, fallback = true, r.maxAgeSeconds))
        return CapabilitiesState.Ready(fallbackCapabilities(r.capabilities), r.source, cached = false, updateApp = false, usingFallback = true)
    }

    // Only the talk features come from the demo; it offers no people features anyway.
    private fun fallbackCapabilities(demo: Capabilities) = Capabilities.None.copy(tier = demo.tier, talks = demo.talks)

    private class Stored(val state: CapabilitiesState.Ready, val fetchedAtMs: Long?, val maxAgeSeconds: Long?)

    private suspend fun storedCapabilities(base: String): Stored? {
        val text = database.setting(KEY_CAPABILITIES + base) ?: return null
        val o = Capabilities.parseJson(text) as? JsonObject ?: return null
        val source = CapabilitiesDiscovery.Source.entries.firstOrNull { it.name == o["source"].asString() } ?: return null
        val fallback = o["fallback"]?.toString() == "true"
        val caps = if (source == CapabilitiesDiscovery.Source.Legacy) {
            Capabilities.Legacy
        } else {
            val doc = o["document"] as? JsonObject ?: return null
            if (Capabilities.negotiate(doc) !is Capabilities.Negotiation.Ok) return null
            if (fallback) fallbackCapabilities(Capabilities.effective(doc)) else Capabilities.effective(doc, localBundleBase(base))
        }
        return Stored(
            CapabilitiesState.Ready(caps, source, cached = true, updateApp = false, usingFallback = fallback),
            fetchedAtMs = o["fetched_at"].asLong(),
            maxAgeSeconds = o["max_age"].asLong(),
        )
    }

    // A plain http bundle base on a local host: debug builds only, and only for a server typed in
    // Settings (or passed as a debug launch option), never for one from a link.
    private suspend fun localBundleBase(base: String): Boolean = allowLocalHttp && database.setting(KEY_TYPED + base) == "1"

    private suspend fun capabilitiesExpired(base: String): Boolean {
        val stored = storedCapabilities(base) ?: return true
        val at = stored.fetchedAtMs ?: return true
        return nowMs() - at > (stored.maxAgeSeconds ?: DEFAULT_CAPABILITIES_MAX_AGE_S) * 1000
    }

    private fun encode(source: CapabilitiesDiscovery.Source, document: JsonObject?, fallback: Boolean, maxAgeSeconds: Long?): String =
        buildJsonObject {
            put("source", source.name)
            if (document != null) put("document", document)
            if (fallback) put("fallback", true)
            put("fetched_at", nowMs())
            if (maxAgeSeconds != null) put("max_age", maxAgeSeconds)
        }.toString()

    private fun JsonElement?.asLong(): Long? = (this as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toLongOrNull()

    private fun bundleBase(caps: CapabilitiesState, backend: BackendUrl.Valid): String? {
        val ready = caps as? CapabilitiesState.Ready ?: return null
        return ready.capabilities.talks.bundleBase
            ?: if (ready.source == CapabilitiesDiscovery.Source.Legacy || isDefault(backend)) Defaults.FALLBACK_BUNDLE_BASE else null
    }

    companion object {
        private const val KEY_BACKEND = "backend"
        private const val KEY_CONFERENCE = "conference:"
        private const val KEY_CAPABILITIES = "capabilities:"
        private const val KEY_HAD_DOCUMENT = "had_document:"
        private const val KEY_TYPED = "typed:"
        private const val KEY_UI = "ui:"
        private const val KEY_LEARN_TOPICS = "learn_topics:"
        private const val KEY_LEARN_TEXT = "learn_text"

        /** The pause before a failed embedder load is tried again, doubled after each failure up to [RETRY_MAX_MS]. */
        const val RETRY_FIRST_MS = 30_000L
        const val RETRY_MAX_MS = 30 * 60_000L

        /** The conference list is fetched at most this often in the foreground. */
        const val INDEX_REFRESH_MS = 15 * 60 * 1000L

        /** How long a capabilities document without a max-age is used before it is fetched again. */
        const val DEFAULT_CAPABILITIES_MAX_AGE_S = 3600L

        /**
         * The conference to open when none was chosen: the next searchable conference that has not
         * ended on today's date in its own time zone, else the most recent one with a bundle.
         */
        fun defaultConference(list: List<IndexedConference>, nowMs: Long): String? {
            val withBundle = list.filter { it.bundle != null }
            if (withBundle.isEmpty()) return list.firstOrNull()?.conference?.slug
            val now = Instant.fromEpochMilliseconds(nowMs)
            return (
                withBundle.firstOrNull { c ->
                    (c.conference.endDate ?: c.conference.startDate ?: "") >= today(now, c.conference.timeZone)
                } ?: withBundle.last()
                ).conference.slug
        }

        private fun today(now: Instant, zone: String?): String {
            val tz = zone?.let { runCatching { TimeZone.of(it) }.getOrNull() } ?: TimeZone.UTC
            return now.toLocalDateTime(tz).date.toString()
        }
    }
}
