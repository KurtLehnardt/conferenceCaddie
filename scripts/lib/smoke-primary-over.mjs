// Pure decisions behind the SKIPs of scripts/smoke.mjs that depend on the clock, taking `nowMs` so they
// can be tested. The server filters For-you suggestions and Happening now with end > now.

// True when the conference has talks and none of them is still to come. An empty list is not "over":
// it means the data could not say, and the check runs.
export function primaryOver(talks, nowMs) {
  return talks.length > 0 && !talks.some((d) => Date.parse(d.end) > nowMs);
}

// n2's window holds no talk: skip only when the Worker says 0 AND the data expects 0. A Worker that
// answers 0 where the data expects talks is the failure the check is for.
export function emptyWindowSkip(total, expected) {
  return total === 0 && expected === 0;
}
