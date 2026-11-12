// Pure decisions behind the SKIPs of scripts/smoke.mjs that depend on the clock, taking their inputs so
// they can be tested. The server filters For-you suggestions and Happening now with end > now. Which
// conference the clock-dependent checks run against, and when they skip for want of one, is decided in
// scripts/lib/smoke-live-conference.mjs.

// n2's window holds no talk: skip only when the Worker says 0 AND the data expects 0. A Worker that
// answers 0 where the data expects talks is the failure the check is for.
export function emptyWindowSkip(total, expected) {
  return total === 0 && expected === 0;
}
