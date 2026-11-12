// Whether a URL hostname (as URL.hostname gives it, so IPv6 keeps its brackets) is this machine:
// localhost and *.localhost, 127.0.0.0/8, 0.0.0.0, [::1] and IPv4-mapped loopback ([::ffff:7fxx:xxxx],
// the form URL normalises ::ffff:127.0.0.1 to).
// "localhost." (a trailing dot) is the same name. [::] and 0.0.0.0 differ: 0.0.0.0 is accepted because a
// connection to it reaches this machine on the platforms that run the smoke, but [::] is the IPv6
// unspecified address and stays false.
export function isLoopbackHost(hostname) {
  const h = String(hostname).toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost')
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
    || h === '0.0.0.0'
    || h === '[::1]'
    || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(h);
}
