package app.conferencecaddie.ui.people

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import app.conferencecaddie.shared.ble.BleAccess
import app.conferencecaddie.ui.platform.IncomingHandoff
import kotlin.time.Instant
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

// The states of PeopleParityShots, one per web screenshot (parity-3/web/INDEX.md), each reached
// from a fresh app the way parity-3/scenarios.mjs reaches it on the web. The heights are the web
// screenshots' (CSS px = dp) at 390 and 320 wide, so the pictures line up.

private val AVERY = "Sample · Avery"
private val BLAKE = "Sample · Blake"
private val CASEY = "Sample · Casey"

/** The extra windows of the screens the brief names: twice the font size, landscape, and the wide layout. */
internal fun extras(tall: Int) = mapOf(
    "font2x" to ParityWindow(390, tall, fontScale = 2f),
    "landscape" to ParityWindow(844, 390),
    "wide" to ParityWindow(1024, 1366),
)

@OptIn(ExperimentalTestApi::class)
private fun ParityRun.pause(ms: Long) {
    runCatching { waitUntil(timeoutMillis = ms) { false } }
}

/** Waits for the People list to load a search for [query] (empty for none) and settle. */
@OptIn(ExperimentalTestApi::class)
private fun ParityRun.searched(query: String?, around: Boolean = false) {
    waitUntil(timeoutMillis = 20_000) {
        requests().any { r ->
            r.method == "POST" && r.path == "/api/people/matches" && r.body?.let { b ->
                (b["query"] as? JsonPrimitive)?.content == query && ((b["when"] as? JsonPrimitive)?.content == "around_now") == around
            } == true
        }
    }
    waitForIdle()
    pause(700)
}

@OptIn(ExperimentalTestApi::class)
private fun ParityRun.menuItem(label: String) =
    tap(hasText(label) and hasClickAction() and hasAnyAncestor(hasTestTag("overflow-menu")), scroll = false)

@OptIn(ExperimentalTestApi::class)
private fun ParityRun.openCardMenu(name: String, scroll: Boolean = true) {
    if (scroll) scrollToCard(name.removePrefix("Sample · "))
    tap(hasContentDescription(PeopleCommonStrings.optionsFor(name)) and hasClickAction(), scroll = false)
    waitFor(hasTestTag("overflow-menu"))
}

/** The block of Casey from their card, up to the confirmation. */
@OptIn(ExperimentalTestApi::class)
private fun ParityRun.blockCaseyConfirm() {
    openCardMenu(CASEY)
    menuItem(PeopleCommonStrings.BLOCK)
    waitFor(hasTestTag("block-confirm"))
}

@OptIn(ExperimentalTestApi::class)
private fun ParityRun.confirmBlock() {
    tap(hasText(PeopleCommonStrings.BLOCK) and hasClickAction() and hasAnyAncestor(hasTestTag("block-confirm")), scroll = false)
    waitGone(hasTestTag("block-confirm"))
}

@OptIn(ExperimentalTestApi::class)
private fun ParityRun.watchDevon() {
    scrollToCard("Devon")
    tap(inCard("Devon", hasText(PeopleStrings.WATCH) and hasClickAction()))
}

/** Presence on through the panel in [zone], with Sawyer (the broad match) joining me there. */
@OptIn(ExperimentalTestApi::class)
private fun ParityRun.aroundIn(zone: String, spot: String = "") {
    start()
    settleCards()
    await { sawyerJoins(zone) }
    presenceThroughPanel(zone, spot = spot)
    waitFor(hasText(PeopleStrings.AROUND_TITLE))
    searchedAround()
}

/** Waits for the Around list to be fetched with my zone and settle. */
@OptIn(ExperimentalTestApi::class)
private fun ParityRun.searchedAround() {
    searched(null, around = true)
    settleCards()
}

/** The Ask sheet for the first "Ask to talk shop" on the Around list in the Hallway. */
@OptIn(ExperimentalTestApi::class)
private fun ParityRun.askSheet() {
    aroundIn("Hallway")
    // The first "Ask to talk shop" of the list: Avery's, elsewhere at the venue.
    tap(inCard("Avery", hasText(PeopleStrings.ASK_TO_TALK_SHOP) and hasClickAction()))
    waitFor(hasTestTag("ask-sheet"))
    peopleTop()
    pause(600)
}

@OptIn(ExperimentalTestApi::class)
private fun ParityRun.typeNote(text: String) {
    onNodeWithTag("ask-note").performTextClearance()
    if (text.isNotEmpty()) onNodeWithTag("ask-note").performTextInput(text)
    waitForIdle()
}

/** A record edit: [key]'s object with [fields] put over it. */
private fun JsonObject.with(key: String, fields: Map<String, kotlinx.serialization.json.JsonElement>): JsonObject {
    val inner = (this[key] as? JsonObject) ?: JsonObject(emptyMap())
    return JsonObject(this + (key to JsonObject(inner + fields)))
}

private fun iso(ms: Long): String = Instant.fromEpochMilliseconds(ms).toString()

/** I'm around in [zone]; Blake asks me; Requests is open. */
@OptIn(ExperimentalTestApi::class)
private fun ParityRun.inboxWithBlake(zone: String, devon: Boolean = false): String {
    var id = ""
    start(prepare = {
        presence(zone)
        sawyerJoins(zone)
        if (devon) devonAsked()
        id = blakeAsks()
    })
    settleCards()
    openInbox()
    waitFor(hasTestTag("incoming-$id"))
    pause(400)
    return id
}

/** My open ask to Devon, made while Devon was around, who has since left (scenarios.mjs meetTo DEVON). */
private suspend fun ParityRun.devonAsked(): String = rig.locked {
    val devon = rig.person("Devon")
    devon.goAround("Registration")
    val me = me(ParitySample.SLUG)!!
    val answer = actAs(me.doc, "POST", "/api/meet", buildJsonObject {
        put("event", ParitySample.SLUG)
        put("ref", devon.ref)
        put("note", "I'd like to compare notes on Tuned eBPF probes in production")
    })
    devon.leave()
    (answer["meet_id"] as JsonPrimitive).content
}

/** The active meet with Blake, accepted from Requests, me in [zone] (with my position in the Hallway). */
@OptIn(ExperimentalTestApi::class)
private fun ParityRun.meetActive(sameZone: Boolean) {
    val zone = if (sameZone) "Expo hall" else "Hallway"
    var id = ""
    start(prepare = {
        presence(zone)
        sawyerJoins(zone)
        if (!sameZone) {
            val (lat, lon) = offsetFrom(ParityRun.MY_LAT, ParityRun.MY_LON, 240.0, 45.0)
            rig.locked { rig.person("Blake").goAround("Expo hall", "by the coffee cart", located = true, lat = lat, lon = lon) }
        }
    })
    settleCards()
    if (!sameZone) {
        tapText(ConnectStrings.USE_MY_POSITION)
        position()
        // The web screenshot has no toast left from turning the position on.
        runCatching { waitGone(hasText(ConnectStrings.USING_POSITION_TOAST)) }
    }
    id = await { blakeAsks() }
    if (!sameZone) {
        // The web mock's accept sets the meeting point to their zone (handler.ts activate).
        locked { actAs(rig.person("Blake").doc, "PUT", "/api/meet/$id/details", buildJsonObject { put("rendezvous", "Expo hall") }) }
    }
    openInbox()
    tapTag("accept-$id")
    waitFor(hasTestTag("meet-screen"))
    waitFor(hasTestTag("meet-them"))
    if (!sameZone) waitFor(hasTestTag("meet-distance"))
    pause(500)
}

@OptIn(ExperimentalTestApi::class)
private fun ParityRun.profileTop() {
    runCatching { onNodeWithTag("profile-screen").performScrollToNode(hasTestTag("profile-name")) }
    waitForIdle()
}

@OptIn(ExperimentalTestApi::class)
internal val PARITY_STATES: List<ParityState> = listOf(
    // --- The People home ---------------------------------------------------------------------
    ParityState("people-home", 1037, 1101) {
        start(visible = false)
        waitFor(hasTestTag("people-visibility-prompt"))
        shoot()
    },
    ParityState("people-home-noprofile", 961, 1004) {
        start(profile = false)
        waitFor(hasTestTag("people-create-profile"))
        shoot()
    },
    ParityState("people-home-visible", 2400, 2400, extras = extras(2400)) {
        start()
        settleCards()
        searched(null)
        shoot()
    },
    ParityState("people-search", 2400, 2400) {
        start()
        settleCards()
        onNodeWithTag("people-search-field").performTextInput("kubernetes")
        waitFor(hasText(PeopleStrings.PEOPLE_WHO_MATCH))
        searched("kubernetes")
        settleCards()
        peopleTop()
        shoot()
    },
    ParityState("people-search-empty", 844, 700) {
        start()
        settleCards()
        onNodeWithTag("people-search-field").performTextInput("zzqqxx")
        waitFor(hasText(PeopleStrings.SEARCH_EMPTY))
        peopleTop()
        shoot()
    },
    ParityState("people-around-chip-nobody-around", 2400, 2400) {
        start()
        settleCards()
        tapTag("around-now-chip", scroll = false)
        waitFor(hasText(PeopleStrings.PEOPLE_AROUND_NOW))
        searched(null, around = true)
        settleCards()
        shoot()
    },
    ParityState("person-card-menu", 2400, 2400) {
        start()
        settleCards()
        searched(null)
        openCardMenu(AVERY, scroll = false)
        pause(400)
        shoot()
    },
    ParityState("report-sheet", 844, 700) {
        start()
        settleCards()
        openCardMenu(AVERY)
        menuItem(PeopleCommonStrings.REPORT)
        waitFor(hasTestTag("report-sheet"))
        peopleTop()
        pause(600)
        shoot()
    },
    ParityState("report-sheet-selected", 844, 700) {
        start()
        settleCards()
        openCardMenu(AVERY)
        menuItem(PeopleCommonStrings.REPORT)
        waitFor(hasTestTag("report-sheet"))
        tapTag("report-reason-harassment", scroll = false)
        peopleTop()
        pause(600)
        shoot()
    },
    ParityState("person-card-watching-toast", 844, 700) {
        start()
        settleCards()
        watchDevon()
        peopleTop()
        shoot()
    },
    ParityState("block-confirm", 844, 700) {
        start()
        settleCards()
        blockCaseyConfirm()
        peopleTop()
        pause(400)
        shoot()
    },
    ParityState("block-toast-undo", 844, 700) {
        start()
        settleCards()
        watchDevon()
        blockCaseyConfirm()
        confirmBlock()
        waitFor(hasText(PeopleCommonStrings.blocked(CASEY)))
        shoot()
    },
    ParityState("settings-people", 2275, 2471) {
        start(prepare = {
            controller.saveMet(AVERY, "Placeholder profile 1 for local development.")
            controller.saveMet(CASEY, "Placeholder profile 3 for local development.")
        })
        settleCards()
        watchDevon()
        blockCaseyConfirm()
        confirmBlock()
        openSettings()
        waitFor(hasText(CASEY) and hasAnyAncestor(hasTestTag("set-blocked")))
        waitFor(hasTestTag("set-watch"))
        shoot()
    },

    // --- Presence -----------------------------------------------------------------------------
    ParityState("presence-zone-picker", 2400, 2400) {
        start()
        settleCards()
        tap(isToggleable() and hasText(ConnectStrings.PRESENCE_LABEL), scroll = false)
        waitFor(hasTestTag("presence-setup"))
        pause(400)
        shoot()
    },
    ParityState("presence-zone-picker-day-spot", 2400, 2400) {
        start()
        settleCards()
        tap(isToggleable() and hasText(ConnectStrings.PRESENCE_LABEL), scroll = false)
        waitFor(hasTestTag("presence-setup"))
        tapText(ParityRun.ConnectStrings_DAY, scroll = false)
        onNodeWithTag("presence-spot").performTextInput("by the coffee cart")
        peopleTop()
        pause(400)
        shoot()
    },
    ParityState("around", 2400, 2400) {
        aroundIn("Expo hall", spot = "by the coffee cart")
        peopleTop()
        shoot()
    },
    ParityState("around-find-open", 2400, 2400) {
        aroundIn("Expo hall", spot = "by the coffee cart")
        tapTag("people-find")
        waitFor(hasTestTag("people-back-to-around"))
        pause(800)
        settleCards()
        peopleTop()
        shoot()
    },
    ParityState("position-notice", 2400, 2400) {
        aroundIn("Hallway", spot = "near the registration desk")
        waitFor(hasTestTag("position-step"))
        peopleTop()
        shoot()
    },
    ParityState("presence-position-on", 2400, 2400) {
        aroundIn("Hallway", spot = "by the coffee cart")
        tapText(ConnectStrings.USE_MY_POSITION)
        position()
        waitFor(hasText(ConnectStrings.USING_POSITION))
        pause(800)
        settleCards()
        peopleTop()
        shoot()
    },
    ParityState("ask-sheet", 844, 700) {
        askSheet()
        shoot()
    },
    ParityState("ask-sheet-error", 844, 700) {
        askSheet()
        typeNote("")
        tapTag("ask-send", scroll = false)
        waitFor(hasText(ConnectStrings.NOTE_EMPTY))
        shoot()
    },
    ParityState("ask-sheet-sent", 844, 700) {
        askSheet()
        typeNote("I'd like to compare notes on Postgres failover")
        tapTag("ask-send", scroll = false)
        waitFor(hasText(ConnectStrings.ASKED))
        pause(400)
        shoot()
    },
    ParityState("around-after-ask", 2400, 2400) {
        askSheet()
        typeNote("I'd like to compare notes on Postgres failover")
        tapTag("ask-send", scroll = false)
        waitFor(hasText(ConnectStrings.ASKED))
        tapText(ConnectStrings.DONE, scroll = false)
        waitGone(hasTestTag("ask-sheet"))
        waitFor(hasText(PeopleCommonStrings.NO_REPLY_YET))
        peopleTop()
        shoot()
    },
    ParityState("wave-toast", 844, 700) {
        aroundIn("Expo hall")
        // As on the web, Blake (the mock's requester) has already asked me, so the wave meets that ask.
        await { blakeAsks() }
        tap(inCard("Blake", hasText(PeopleStrings.WAVE) and hasClickAction()))
        peopleTop()
        pause(500)
        shoot()
    },
    ParityState("still-in", 2400, 2400) {
        stillIn()
        shoot()
    },
    ParityState("still-in-other", 2400, 2400) {
        stillIn()
        tapText(ConnectStrings.OTHER_ZONE, scroll = false)
        pause(400)
        shoot()
    },
    ParityState("nudge-banner", 2400, 2400) {
        start(prepare = {
            presence("Hallway")
            sawyerJoins("Hallway")
            // Rowan, a specific match, walks into my zone (fixtures.ts joins_me_after_ms) before the
            // first check, as on the web, where the check runs with the inbox poll.
            rig.locked { rig.person("Rowan").goAround("Hallway") }
            controller.backgroundCheck()
        })
        waitFor(hasTestTag("nudge-banner"))
        searchedAround()
        peopleTop()
        shoot()
    },
    ParityState("push-notice", 2400, 2400) {
        start()
        settleCards()
        tapTag("push-switch", scroll = false)
        waitFor(hasTestTag("push-notice"))
        pause(400)
        shoot()
    },

    // --- Requests and Meet up -----------------------------------------------------------------
    ParityState("inbox", 844, 700) {
        inboxWithBlake("Hallway", devon = true)
        shoot()
    },
    ParityState("inbox-empty", 844, 700) {
        start()
        settleCards()
        openInbox()
        waitFor(hasTestTag("inbox-empty"))
        shoot()
    },
    ParityState("inbox-samezone", 844, 700) {
        inboxWithBlake("Expo hall")
        shoot()
    },
    ParityState("meet-requested", 886, 926) {
        var devon = ""
        start(prepare = {
            presence("Hallway")
            devon = devonAsked()
        })
        settleCards()
        IncomingHandoff.offerLink("caddie://meet/$devon")
        waitFor(hasTestTag("meet-screen"))
        waitFor(hasTestTag("meet-waiting"))
        pause(500)
        shoot()
    },
    ParityState("meet-active", 1048, 1077, extras = extras(1600)) {
        meetActive(sameZone = false)
        shoot()
    },
    ParityState("meet-active-menu", 1048, 1077) {
        meetActive(sameZone = false)
        tap(hasContentDescription(PeopleCommonStrings.optionsFor(BLAKE)) and hasClickAction(), scroll = false)
        waitFor(hasTestTag("overflow-menu"))
        pause(400)
        shoot()
    },
    ParityState("report-sheet-meet", 844, 700) {
        meetActive(sameZone = false)
        tap(hasContentDescription(PeopleCommonStrings.optionsFor(BLAKE)) and hasClickAction(), scroll = false)
        menuItem(PeopleCommonStrings.REPORT)
        waitFor(hasTestTag("report-sheet"))
        pause(600)
        shoot()
    },
    ParityState("meet-cancel-confirm", 844, 700) {
        meetActive(sameZone = false)
        tapTag("meet-cancel")
        waitFor(hasText(ConnectStrings.CANCEL_MEET_TITLE))
        topOf("meet-screen")
        pause(400)
        shoot()
    },
    ParityState("meet-cancelled", 844, 700) {
        meetActive(sameZone = false)
        tapTag("meet-cancel")
        waitFor(hasText(ConnectStrings.CANCEL_MEET_TITLE))
        tapText(ConnectStrings.CANCEL_MEET_CONFIRM, scroll = false)
        waitFor(hasText(ConnectStrings.MEET_CANCELLED))
        pause(400)
        shoot()
    },
    ParityState("meet-active-samezone", 1067, 1117) {
        meetActive(sameZone = true)
        val picker = hasClickAction() and (hasText(ConnectStrings.CHANGE_MEETING_POINT) or hasText(ConnectStrings.SET_MEETING_POINT))
        tap(picker)
        waitFor(hasTestTag("meet-rendezvous-set"))
        topOf("meet-screen")
        pause(400)
        shoot()
    },
    ParityState("meet-found", 844, 700) {
        meetActive(sameZone = true)
        tapTag("meet-found")
        waitFor(hasTestTag("meet-found-card"))
        pause(400)
        shoot()
    },
    ParityState("meet-found-saved", 844, 700) {
        meetActive(sameZone = true)
        tapTag("meet-found")
        waitFor(hasTestTag("meet-found-card"))
        tapText(ConnectStrings.SAVE_PERSON)
        waitFor(hasText(ConnectStrings.SAVED_UNDER_SETTINGS))
        pause(400)
        shoot()
    },
    ParityState("meet-error", 844, 700) {
        start()
        settleCards()
        IncomingHandoff.offerLink("caddie://meet/doesnotexist")
        waitFor(hasText(ConnectStrings.MEET_NOT_FOUND))
        pause(400)
        shoot()
    },

    // --- Profile ------------------------------------------------------------------------------
    ParityState("profile-empty", 2434, 2675) {
        start(profile = false, tab = null)
        openProfile()
        pause(600)
        shoot()
    },
    ParityState("profile-filled", 2629, 2870, extras = extras(3000)) {
        start(tab = null)
        openProfile()
        waitSuggested()
        pause(600)
        shoot()
    },
    // Native only: Profile from the People tab's Profile button, whose Back says "‹ People".
    ParityState("profile-from-people", 2629, 2870) {
        start()
        tapTag("profile-button", scroll = false)
        waitFor(hasTestTag("profile-screen"))
        waitSuggested()
        pause(600)
        shoot()
    },
    ParityState("profile-topics", 2301, 2472) {
        start(tab = null)
        openProfile()
        onNodeWithTag("picker-learn-search").performTextReplacement("e")
        waitFor(hasTestTag("picker-learn-matching"))
        profileTop()
        pause(400)
        shoot()
    },
    ParityState("profile-topics-nomatch", 2277, 2448) {
        start(tab = null)
        openProfile()
        onNodeWithTag("picker-learn-search").performTextReplacement("zzzz")
        waitFor(hasText("No topic matches that. Try another word."))
        profileTop()
        pause(400)
        shoot()
    },
    ParityState("profile-delete-confirm", 2764, 3026) {
        start(tab = null)
        openProfile()
        tapTag("profile-delete")
        waitFor(hasTestTag("profile-delete-confirm"))
        profileTop()
        waitSuggested()
        pause(400)
        shoot()
    },
    ParityState("profile-hidden-banner", 2746, 3009) {
        start(tab = null, prepare = {
            val me = rig.locked { me(ParitySample.SLUG)!!.ref }
            rig.locked {
                rig.person("Avery").report(me)
                rig.person("Blake").report(me)
            }
            // The next profile write learns that the profile is hidden.
            controller.updateProfile { it.copy(about = it.about + " ") }
            controller.updateProfile { it.copy(about = JORDAN.about) }
        })
        openProfile()
        waitFor(hasTestTag("profile-hidden-banner"))
        waitSuggested()
        pause(400)
        shoot()
    },
    ParityState("profile-delete-pending", 2913, 3198) {
        val now = rig.clock.ms
        start(tab = null, record = { r ->
            JsonObject(r + ("delete_pending" to buildJsonObject {
                put("attempts", 2)
                put("next_at", now + 3_000_000_000L)
                put("forbidden", 0)
                put("last", "offline")
                put("since", now - 600_000L)
            }))
        })
        openProfile()
        waitFor(hasTestTag("profile-pending-delete"))
        waitSuggested()
        pause(400)
        shoot()
    },
    ParityState("profile-delete-stuck", 3043, 3421) {
        val now = rig.clock.ms
        start(tab = null, record = { r ->
            JsonObject(r + ("delete_pending" to buildJsonObject {
                put("attempts", 6)
                put("next_at", now + 3_000_000_000L)
                put("forbidden", 3)
                put("last", "forbidden")
                put("since", now - 600_000L)
            }))
        })
        openProfile()
        waitFor(hasTestTag("profile-stop-trying"))
        waitSuggested()
        pause(400)
        shoot()
    },

    // --- Talk circles and sharing -------------------------------------------------------------
    ParityState("ended-talk-banner", 2400, 2400) {
        start(interested = listOf(1, 3), shared = listOf(1))
        waitFor(hasTestTag("ended-talk-banner"))
        settleCards()
        searched(null)
        peopleTop()
        shoot()
    },
    ParityState("ended-talk-banner-open", 2400, 2400) {
        start(interested = listOf(1), shared = listOf(1))
        waitFor(hasTestTag("ended-talk-banner"))
        settleCards()
        tapTag("ended-see-who", scroll = false)
        waitFor(hasTestTag("circle-${ParitySample.talk(1).id}"))
        waitGone(hasText("Loading…"))
        pause(600)
        peopleTop()
        shoot()
    },
    ParityState("talk-circle-collapsed", 844, 700) {
        start(interested = listOf(1, 3), shared = listOf(1))
        waitFor(hasTestTag("ended-talk-banner"))
        settleCards()
        tapTag("ended-open-talk", scroll = false)
        waitFor(hasTestTag("talk-sheet"))
        waitFor(hasTestTag("see-who-${ParitySample.talk(1).id}"))
        pause(800)
        shoot()
    },
    ParityState("talk-circle", 844, 700) {
        start(interested = listOf(1, 3), shared = listOf(1))
        waitFor(hasTestTag("ended-talk-banner"))
        settleCards()
        tapTag("ended-open-talk", scroll = false)
        waitFor(hasTestTag("talk-sheet"))
        tapTag("see-who-${ParitySample.talk(1).id}")
        waitFor(hasTestTag("circle-${ParitySample.talk(1).id}"))
        waitGone(hasText("Loading…"))
        pause(600)
        // The web scrolls the sheet so that "See who's here" sits near its top.
        runCatching { onNodeWithTag("see-who-${ParitySample.talk(1).id}").performScrollTo() }
        pause(600)
        shoot()
    },
    ParityState("share-all", 1382, 1499) {
        start(interested = listOf(1, 3), shareNoticeSeen = false, tab = "tab-Interested")
        waitFor(hasTestTag("share-all"))
        pause(600)
        shoot()
    },
    ParityState("share-all-notice", 1593, 1752) {
        start(interested = listOf(1, 3), shareNoticeSeen = false, tab = "tab-Interested")
        waitFor(hasTestTag("share-all"))
        tapTag("share-all-button")
        waitFor(hasTestTag("share-notice"))
        pause(600)
        shoot()
    },

    // --- Offline and Settings -----------------------------------------------------------------
    ParityState("people-offline", 844, 700) {
        start()
        settleCards()
        rig.backend.offline = true
        rig.core.refresh(force = true)
        waitFor(hasTestTag("people-offline"))
        pause(400)
        shoot()
    },
    ParityState("settings-people-fresh", 1681, 1831) {
        start(tab = null)
        openSettings()
        waitFor(hasTestTag("set-blocked"))
        pause(600)
        shoot()
    },

    // --- Bluetooth (phase 4; parity-4/scenarios.mjs) --------------------------------------------
    ParityState("ble-presence-off", 2400, 2400, ble = true) {
        start()
        settleCards()
        waitFor(hasTestTag("ble-card"))
        peopleTop()
        pause(400)
        shoot()
    },
    ParityState("ble-card-off", 2400, 2400, ble = true) {
        aroundWithBluetooth()
        shoot()
    },
    ParityState("ble-notice", 2400, 2400, ble = true) {
        aroundWithBluetooth()
        bleSwitch()
        waitFor(hasTestTag("ble-setup"))
        peopleTop()
        pause(400)
        shoot()
    },
    ParityState("ble-on", 2400, 2400, ble = true) {
        aroundWithBluetooth()
        bleSwitch()
        tapTag("ble-turn-on")
        waitUntil(timeoutMillis = 20_000) { controller.state.value.ble.on }
        waitGone(hasTestTag("ble-setup"))
        peopleTop()
        pause(400)
        shoot()
    },
    ParityState("ble-permission", 2400, 2400, ble = true) {
        // Refused at the prompt for good: the web's words, and the way to the system settings.
        rig.radio.access = BleAccess.NotAsked
        rig.radio.afterRequest = BleAccess.Blocked
        aroundWithBluetooth()
        bleSwitch()
        tapTag("ble-turn-on")
        waitFor(hasTestTag("ble-open-settings"))
        peopleTop()
        pause(400)
        shoot()
    },
    ParityState("settings-ble", 2000, 2200, ble = true) {
        aroundWithBluetooth()
        openSettings()
        waitFor(hasTestTag("set-ble"))
        pause(600)
        shoot()
    },
)

/**
 * I'm around in the Hallway with the position step answered "Zone only" (parity-4/scenarios.mjs
 * aroundForBle), Sawyer joining me there, at a backend and on a phone with Bluetooth.
 */
@OptIn(ExperimentalTestApi::class)
private fun ParityRun.aroundWithBluetooth() {
    start(prepare = {
        presence("Hallway")
        sawyerJoins("Hallway")
        controller.sharePosition(false)
    })
    waitFor(hasTestTag("ble-card"))
    searchedAround()
    peopleTop()
    pause(400)
}

/** Taps the Bluetooth switch in the presence card. */
@OptIn(ExperimentalTestApi::class)
private fun ParityRun.bleSwitch() {
    tap(isToggleable() and hasText(app.conferencecaddie.shared.people.PeopleText.BLE_LABEL))
}

/**
 * Waits for Profile's "Suggested for you" topics (from Jordan's free text), which the topic picker
 * shows only after its debounce (ProfileTopicPicker), so the shot has them as the web's has.
 */
@OptIn(ExperimentalTestApi::class)
private fun ParityRun.waitSuggested() = waitFor(hasText(ProfileStrings.SUGGESTED_FOR_YOU, ignoreCase = true))

/** I'm around in the Expo hall, back after twenty minutes: "Still in Expo hall?" (scenarios.mjs still-in). */
@OptIn(ExperimentalTestApi::class)
private fun ParityRun.stillIn() {
    val now = rig.clock.ms
    start(
        prepare = {
            presence("Expo hall")
            sawyerJoins("Expo hall")
        },
        record = { r ->
            r.with(
                "presence",
                mapOf(
                    "confirm_pending" to JsonPrimitive(true),
                    "confirmed_at" to JsonPrimitive(iso(now - 20 * 60_000L)),
                    "recent_zones" to JsonArray(listOf("Expo hall", "Hallway", "Registration").map { JsonPrimitive(it) }),
                ),
            )
        },
    )
    waitFor(hasTestTag("still-here"))
    searchedAround()
    peopleTop()
}
