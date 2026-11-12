package app.conferencecaddie.shared.ble

/**
 * The devices this phone connects out to in order to read their token ([BleInterrogation]), which
 * may not read this phone's token over that link. Android always lets the peer of a connection this
 * phone made read the phone's GAP Device Name (the name the person gave it), however the phone
 * advertises; a peer that could also read the token over the same link would tie that name to the
 * token without the server. Anything can advertise Caddie's public service UUID and be connected to,
 * so the GATT server refuses such a read with [BleGattAnswer.READ_NOT_PERMITTED].
 *
 * The rule, by the device's address on the link: a device is refused from the moment this phone
 * starts to connect to it until the stack reports that its link has ended after the read finished.
 * A link end reported while the connection is still being made is not taken, because it may be the
 * end of an earlier link of the same address. If no end is ever reported (a connection that never
 * formed), the device is forgotten once the window after the one it was connected to in has ended;
 * by then this phone has long closed its side, which ends the link.
 *
 * This is a rule about links, not addresses: after the link has ended, the same address is served
 * like any other on a new connection, which reaches this phone only through its own advertisement
 * (non-discoverable, so the name is not readable there). An iPhone uses one address for both roles,
 * so a rule by address would keep an iPhone that this phone has read from reading this phone back.
 *
 * Thread-safe: reads arrive on a GATT binder thread, everything else on the main thread. Addresses
 * are kept in memory only and never logged.
 */
internal class BleOutboundLinks {
    /** Device address to the token window in which this phone last connected to it. */
    private val links = HashMap<String, Long>()

    /** The device this phone is connecting to now, or null. */
    private var connecting: String? = null

    /** This phone is about to connect to [device] in token window [window]. */
    fun connecting(device: String, window: Long) {
        synchronized(links) {
            links[device] = window
            connecting = device
        }
    }

    /** The connection to [device] is over on this phone's side: its read finished or was cancelled. */
    fun finished(device: String) {
        synchronized(links) {
            if (connecting == device) connecting = null
        }
    }

    /** The connection being made was cancelled without a result (the radio replaced its policy). */
    fun cancelled() {
        synchronized(links) { connecting = null }
    }

    /** The stack reports that [device]'s link to this phone has ended. */
    fun disconnected(device: String) {
        synchronized(links) {
            if (connecting != device) links.remove(device)
        }
    }

    /** Whether [device] may not read this phone's token now. */
    fun refuses(device: String): Boolean = synchronized(links) { device == connecting || device in links }

    /** Token window [window] has started: devices whose link end was never reported are forgotten after one more window. */
    fun windowStarted(window: Long) {
        synchronized(links) {
            links.entries.removeAll { (device, connectedIn) -> connectedIn < window - 1 && device != connecting }
        }
    }

    /** Forgets everything: the radio has stopped. */
    fun clear() {
        synchronized(links) {
            links.clear()
            connecting = null
        }
    }
}
