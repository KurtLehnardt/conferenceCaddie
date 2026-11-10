// The "Find people near me by Bluetooth" row under the "I'm around" switch. Android app only:
// nothing renders on the web or on a phone without Bluetooth LE. Off by default; the first time it
// is turned on, the notice explains what the phone sends and what can be learned.
import { useEffect, useState } from 'preact/hooks';
import { Bluetooth } from 'lucide-preact';
import { BLE_LABEL, BLE_NOTICE, bleRunning, resumeBle, rotateNow, startBle, stopBle, useBleAvailable, useBleState } from './ble';
import { getPresence, usePeopleStore } from './storage';
import type { ConferenceLike } from './types';
import './ble.css';

export function BleControls({ conference }: { conference: ConferenceLike }) {
  const slug = conference.slug;
  const available = useBleAvailable();
  usePeopleStore();
  const presence = getPresence(slug);
  const ble = useBleState(slug);
  const [panel, setPanel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Opening the tab with the feature on: pick the running service back up, or record it as off.
  useEffect(() => {
    if (available) void resumeBle(slug);
  }, [available, slug]);

  // Presence off takes the feature with it; a longer or moved presence reaches the service at the
  // next token, so it stops when presence does and not before.
  useEffect(() => {
    if (!available) return;
    if (!presence.on && (ble.on || bleRunning(slug))) void stopBle(slug, { tellServer: false });
    else if (presence.on && bleRunning(slug)) void rotateNow(slug);
  }, [available, slug, presence.on, presence.until, presence.zone]);

  if (!available) return null;

  const turnOn = async () => {
    setBusy(true);
    setError(null);
    const err = await startBle(slug);
    setBusy(false);
    if (err) setError(err);
    else setPanel(false);
  };

  const onSwitch = (on: boolean) => {
    if (!on) {
      setPanel(false);
      setError(null);
      void stopBle(slug);
      return;
    }
    if (!ble.notice_seen) {
      setPanel(true);
      return;
    }
    void turnOn();
  };

  const disabled = busy || !presence.on;

  return (
    <div class="pp-ble" aria-label="Find people near me by Bluetooth">
      <label class={`pp-switch-row${!presence.on ? ' pp-ble-off' : ''}`}>
        <span class="pp-ble-label">
          <Bluetooth size={16} aria-hidden="true" />
          {BLE_LABEL}
        </span>
        <input
          type="checkbox"
          role="switch"
          class="switch"
          checked={ble.on || panel}
          disabled={disabled}
          aria-describedby="pp-ble-hint"
          onChange={(e) => onSwitch((e.target as HTMLInputElement).checked)}
        />
      </label>
      {panel && (
        <div class="pp-ble-setup">
          <div class="pp-notice" role="region" aria-label="About finding people by Bluetooth">
            <p>{BLE_NOTICE}</p>
          </div>
          <div class="pp-actions">
            <button type="button" class="btn btn-primary btn-small" disabled={busy} onClick={turnOn}>
              {busy ? 'Starting…' : 'Turn on'}
            </button>
            <button type="button" class="btn btn-text btn-small" disabled={busy} onClick={() => setPanel(false)}>
              Not now
            </button>
          </div>
        </div>
      )}
      <p id="pp-ble-hint" class={error ? 'pp-error' : 'pp-hint'}>
        {error ??
          (!presence.on
            ? 'Turn on being around first.'
            : ble.on
              ? 'Listening. You’ll get one notification when a strong match is within a few metres; it stops when being around does.'
              : 'Only people who also turned this on can be found.')}
      </p>
    </div>
  );
}
