// Whether a URL hostname (as URL.hostname gives it, so IPv6 keeps its brackets) is this machine:
// localhost and *.localhost, 127.0.0.0/8, 0.0.0.0, [::1] and IPv4-mapped loopback ([::ffff:7fxx:xxxx],
// the form URL normalises ::ffff:127.0.0.1 to).
export function isLoopbackHost(hostname) {
  const h = String(hostname).toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost')
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
    || h === '0.0.0.0'
    || h === '[::1]'
    || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(h);
}
