// The PASS, FAIL and SKIP lines of scripts/smoke.mjs, and their counts.
//
// report(ok, name, detail) prints PASS or FAIL. skip(name, why) prints SKIP: a skipped check is never
// counted as passed, and it never fails the run. check(name, fn) runs one check: a SkipCheck thrown
// inside it prints SKIP with its message, and any other error prints FAIL with its message.

// Thrown inside a check that cannot run here (a gated fixture route, no conference with talks to come):
// the check prints SKIP, not FAIL.
export class SkipCheck extends Error {}

export function createReporter(log = (line) => console.log(line)) {
  const counts = { pass: 0, fail: 0, skip: 0 };
  function report(ok, name, detail = '') {
    counts[ok ? 'pass' : 'fail']++;
    log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  }
  function skip(name, why) {
    counts.skip++;
    log(`SKIP ${name} (${why})`);
  }
  async function check(name, fn) {
    try {
      await fn();
    } catch (err) {
      if (err instanceof SkipCheck) skip(name, err.message);
      else report(false, name, err.message);
    }
  }
  const summary = () => `SUMMARY ${counts.pass} PASS, ${counts.fail} FAIL, ${counts.skip} SKIP`;
  return { counts, report, skip, check, summary };
}
