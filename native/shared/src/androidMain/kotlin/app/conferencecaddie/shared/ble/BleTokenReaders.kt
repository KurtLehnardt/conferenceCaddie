package app.conferencecaddie.shared.ble

/**
 * Which connections have read this phone's token, and which token, so that no connection ever reads
 * two of them (docs/contracts/ble-tokens.md, mitigation 4). Rotation hides that the tokens of two
 * windows belong to one phone; a peer that stayed connected across a window change and read again
 * would get both tokens over one link and undo that. So a connection is served one payload only, the
 * first it read: a read of any other (a later window, or a new key) is refused with
 * [BleGattAnswer.READ_NOT_PERMITTED], and [BleRadioService] ends those connections whenever the
 * payload changes. A device that never read the token (a watch or earbuds bonded to this phone) is
 * not tracked here and is never disconnected.
 *
 * Keyed by the device's address on its connection and forgotten when that connection ends, so a peer
 * that connects again through the new advertisement reads the new token like any other phone.
 * Thread-safe: reads arrive on a GATT binder thread, everything else on the main thread. The payloads
 * are kept in memory only, for as long as the connection, and never logged.
 */
internal class BleTokenReaders {
    private val served = HashMap<String, ByteArray>()

    /** The answer to [device]'s read at [offset] while the payload of now is [payload]. */
    fun answer(device: String, offset: Int, payload: ByteArray?): BleGattAnswer {
        // Nothing to serve: nothing is recorded either, so the next read with a payload is the first.
        if (payload == null) return BleGattAnswer.of(null, offset)
        synchronized(served) {
            val first = served.getOrPut(device) { payload.copyOf() }
            if (!first.contentEquals(payload)) return BleGattAnswer(BleGattAnswer.READ_NOT_PERMITTED, null)
        }
        return BleGattAnswer.of(payload, offset)
    }

    /** The devices that were served another payload than [payload] (every one when it is null): their connections must end. */
    fun servedOtherThan(payload: ByteArray?): List<String> = synchronized(served) {
        served.filterValues { payload == null || !it.contentEquals(payload) }.keys.toList()
    }

    /** [device]'s connection ended: a new connection from it starts afresh. */
    fun disconnected(device: String) {
        synchronized(served) { served.remove(device) }
    }

    /** The GATT server closed, which ended every connection to it. */
    fun clear() {
        synchronized(served) { served.clear() }
    }
}
