#!/bin/bash
# Deploys Conference Caddie's free stack to Cloudflare: one Worker, "conference-caddie", that serves
# the web app as static assets and the API on the same origin.
#
# Usage, from anywhere in the repository:
#   bash worker/scripts/deploy.sh                    ensure the workers.dev subdomain, build the app, deploy
#   bash worker/scripts/deploy.sh --subdomain-only   only ensure the workers.dev subdomain
#
# Reads CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment and never prints them, and
# the optional CADDIE_WORKERS_SUBDOMAIN (step 1).
# The token reaches curl through its standard input (a curl config read with -K -), never through
# a command line, so it does not show up in the process list either.
#
# Steps:
#   1. GET /accounts/{account}/workers/subdomain. When the account has no workers.dev subdomain yet,
#      PUT {"subdomain":"<CADDIE_WORKERS_SUBDOMAIN>"} (an optional environment variable: the name you
#      want, lowercase letters, digits and hyphens), and when it is unset, or the name is taken, use
#      conference-caddie-<6 random lowercase letters>. An account that already has a subdomain keeps
#      it, whatever the variable says.
#   2. Build the web app in Worker mode (npm --prefix web run build:worker: base "/", same-origin
#      API, in-browser document reading) into web/dist-worker/, the [assets] directory of
#      wrangler.toml, so the app ships with the Worker.
#   3. GET /accounts/{account}/workers/scripts/{name}/secrets, with the name from worker/wrangler.toml,
#      and refuse to deploy while ADMIN_SIG_MIN, ADMIN_ORIGIN or ADMIN_TEST_ROUTES is a secret of the
#      Worker (DECISIONS.md, "Admin signature v2", step d). The check reads the secrets' names only;
#      Cloudflare does not return their values, and the script prints only which of the three names
#      it found. A 404 with
#      Cloudflare's error code 10007 means the Worker does not exist yet (a first deploy) and passes.
#      Any other answer (a 403, a 5xx, no answer, a body that cannot be read) refuses to deploy, so a
#      check that could not run never passes.
#   4. npx wrangler deploy from worker/ (the wrangler version pinned in worker/package.json).
#      Its output goes to a temporary file that is deleted on exit; only the URL is printed.
#
# Output is the subdomain name and the app URL (which is also the API's base) only. On a failure
# the script prints the HTTP status and Cloudflare's error codes, the last lines of the build
# output, or the last lines of the wrangler output with the token value redacted.
#
# Deploy order (docs/FREE_HOSTING.md, Go live): this script, then node
# worker/scripts/setup-secrets.mjs, then the migration, then the repository variables and the
# workflows. Until ADMIN_TOKEN exists the admin routes answer 404.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# The name to try first when the account has no workers.dev subdomain; empty goes straight to the
# random fallback, so a fork never claims the name of the repository's original owner.
PREFERRED_SUBDOMAIN="${CADDIE_WORKERS_SUBDOMAIN:-}"
FALLBACK_PREFIX="conference-caddie-"
API="https://api.cloudflare.com/client/v4"

SUBDOMAIN_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --subdomain-only) SUBDOMAIN_ONLY=1 ;;
    -h|--help)
      sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN is not set." >&2
  exit 1
fi
if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "CLOUDFLARE_ACCOUNT_ID is not set." >&2
  exit 1
fi
# The name goes into a JSON body, so it is checked: a DNS label of lowercase letters, digits and hyphens.
subdomain_re='^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
if [ -n "$PREFERRED_SUBDOMAIN" ] && ! [[ "$PREFERRED_SUBDOMAIN" =~ $subdomain_re ]]; then
  echo "CADDIE_WORKERS_SUBDOMAIN must be a workers.dev subdomain: lowercase letters, digits and hyphens, not starting or ending with a hyphen." >&2
  exit 2
fi
command -v node >/dev/null || { echo "node (22 or later) is required." >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required." >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/caddie-deploy.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# cf_api METHOD PATH [JSON BODY] writes the response body to $WORK/resp.json and prints the HTTP
# status. The Authorization header is fed to curl as a config line on standard input; printf is a
# shell builtin, so the token never appears in any process's arguments. The previous response is
# removed first, so an answer with no body is never read as the one before it.
cf_api() {
  local method="$1" path="$2" body="${3:-}"
  rm -f "$WORK/resp.json"
  local args=(-sS -K - -X "$method" -o "$WORK/resp.json" -w '%{http_code}' --max-time 30)
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data "$body")
  fi
  local code
  code="$(printf 'header = "Authorization: Bearer %s"\n' "$CLOUDFLARE_API_TOKEN" \
    | curl "${args[@]}" "$API/accounts/$CLOUDFLARE_ACCOUNT_ID$path")" || code="000"
  printf '%s' "${code:0:3}"
}

# json_field EXPRESSION evaluates a JavaScript expression over the parsed response as `r` and
# prints the result (an empty string for null or undefined). A body that is missing, is not JSON,
# or parses to something other than an object (null, a number, a string, an array) is read as {},
# so the callers' fail-closed messages print instead of a Node error.
json_field() {
  node -e '
    const fs = require("node:fs");
    let r = {};
    try { r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
    if (r === null || typeof r !== "object" || Array.isArray(r)) r = {};
    const v = (new Function("r", "return (" + process.argv[2] + ");"))(r);
    process.stdout.write(v == null ? "" : String(v));
  ' "$WORK/resp.json" "$1"
}

# Cloudflare's error codes and messages, which never contain the token.
api_errors() {
  json_field '(r.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ") || "no error details"'
}

# Cloudflare's numeric error codes alone, without the messages.
api_codes() {
  json_field '(Array.isArray(r.errors) ? r.errors : []).map((e) => e && e.code).filter((c) => Number.isInteger(c)).join(", ") || "none"'
}

random_suffix() {
  node -e '
    const letters = "abcdefghijklmnopqrstuvwxyz";
    let s = "";
    for (const b of crypto.getRandomValues(new Uint8Array(6))) s += letters[b % 26];
    process.stdout.write(s);
  '
}

blocker() {
  echo "$1" >&2
  echo "Blocker: the Cloudflare token may lack permission for the workers.dev subdomain. Create the subdomain once in the dashboard (Workers & Pages, Overview, workers.dev subdomain), then run this script again." >&2
  exit 1
}

# 1. The workers.dev subdomain.
status="$(cf_api GET /workers/subdomain)"
subdomain=""
unreadable=0
if [ "$status" = "200" ]; then
  subdomain="$(json_field 'r.result && r.result.subdomain')"
elif [ "$status" = "401" ] || [ "$status" = "403" ]; then
  if [ "$SUBDOMAIN_ONLY" = "1" ]; then
    blocker "Reading the workers.dev subdomain failed with HTTP $status ($(api_errors))."
  fi
  # The token cannot read the subdomain. If one was created in the dashboard, wrangler deploy
  # still works and prints the URL, so carry on without creating one.
  echo "Note: the token cannot read the workers.dev subdomain (HTTP $status); deploying anyway, which works only if the subdomain already exists." >&2
  unreadable=1
elif [ "$status" = "000" ]; then
  echo "Could not reach api.cloudflare.com." >&2
  exit 1
fi

if [ -z "$subdomain" ] && [ "$unreadable" = "0" ]; then
  candidate="${PREFERRED_SUBDOMAIN:-$FALLBACK_PREFIX$(random_suffix)}"
  for attempt in 1 2 3 4; do
    status="$(cf_api PUT /workers/subdomain "{\"subdomain\":\"$candidate\"}")"
    if [ "$status" = "200" ] && [ "$(json_field 'r.success === true')" = "true" ]; then
      subdomain="$(json_field 'r.result && r.result.subdomain')"
      subdomain="${subdomain:-$candidate}"
      break
    fi
    if [ "$status" = "401" ] || [ "$status" = "403" ]; then
      blocker "Creating the workers.dev subdomain failed with HTTP $status ($(api_errors))."
    fi
    if [ "$status" = "000" ]; then
      echo "Could not reach api.cloudflare.com." >&2
      exit 1
    fi
    # Any other answer is treated as "name not available" (Cloudflare uses 409 or 400 for a taken
    # name), and the next attempt uses a random fallback name.
    echo "The subdomain $candidate is not available (HTTP $status: $(api_errors)); trying a fallback." >&2
    candidate="$FALLBACK_PREFIX$(random_suffix)"
  done
  if [ -z "$subdomain" ]; then
    echo "Could not create a workers.dev subdomain after 4 attempts." >&2
    exit 1
  fi
fi

if [ -n "$subdomain" ]; then
  echo "workers.dev subdomain: $subdomain"
fi
if [ "$SUBDOMAIN_ONLY" = "1" ]; then
  exit 0
fi

# 2. Build the web app in Worker mode into web/dist-worker/.
WEB_DIR="$(cd "$WORKER_DIR/../web" && pwd)"
if [ ! -d "$WEB_DIR/node_modules" ]; then
  if ! npm --prefix "$WEB_DIR" ci --no-audit --no-fund >"$WORK/web-npm.log" 2>&1; then
    echo "npm ci failed in web/:" >&2
    tail -n 20 "$WORK/web-npm.log" >&2
    exit 1
  fi
fi
if ! npm --prefix "$WEB_DIR" run build:worker >"$WORK/web-build.log" 2>&1; then
  echo "The Worker-mode web build failed:" >&2
  tail -n 30 "$WORK/web-build.log" >&2
  exit 1
fi
if [ ! -f "$WEB_DIR/dist-worker/index.html" ] || [ ! -f "$WEB_DIR/dist-worker/_headers" ]; then
  echo "The Worker-mode web build wrote no web/dist-worker/index.html or _headers." >&2
  exit 1
fi
echo "Built the web app into web/dist-worker."

cd "$WORKER_DIR"
if [ ! -d node_modules ]; then
  if ! npm ci --no-audit --no-fund >"$WORK/npm.log" 2>&1; then
    echo "npm ci failed in worker/:" >&2
    tail -n 20 "$WORK/npm.log" >&2
    exit 1
  fi
fi

# 3. Refuse to deploy while ADMIN_SIG_MIN, ADMIN_ORIGIN or ADMIN_TEST_ROUTES is a secret of the
# Worker. Security warning: a secret survives every deploy and the repository does not show it, so
# a leftover ADMIN_SIG_MIN secret of "1" would override the source default ("2" since step d) and
# keep the v1 admin signature, and its replay window, open; a leftover ADMIN_ORIGIN secret could
# list another deployment's origin; and a leftover ADMIN_TEST_ROUTES secret of "1" would keep the
# smoke's /admin/test/* fixture routes on after every deploy. ADMIN_SIG_MIN and ADMIN_ORIGIN belong
# in [vars] of worker/wrangler.toml, committed; ADMIN_TEST_ROUTES is set only for a fixture smoke,
# with wrangler deploy --var. Only the names are read: Cloudflare returns each secret's name and
# type, never its value, and the script prints only which of the three names it found. A check
# that cannot run refuses to deploy.
# The name goes into the request's path, so it is checked like the subdomain above.
worker_name="$(sed -n 's/^name *= *"\([^"]*\)".*/\1/p' wrangler.toml | head -n 1)"
worker_name_re='^[a-z0-9]([a-z0-9_-]*[a-z0-9])?$'
if ! [[ "$worker_name" =~ $worker_name_re ]]; then
  echo "Refusing to deploy: could not read the Worker's name from worker/wrangler.toml, so its secrets cannot be checked." >&2
  exit 1
fi
status="$(cf_api GET "/workers/scripts/$worker_name/secrets")"
if [ "$status" = "200" ]; then
  # "none", the matched names separated by spaces, or empty when the body is not a successful list
  # of named secrets.
  found="$(json_field 'r.success === true && Array.isArray(r.result) && r.result.every((s) => s && typeof s.name === "string") ? (r.result.map((s) => s.name).filter((n, i, all) => (n === "ADMIN_SIG_MIN" || n === "ADMIN_ORIGIN" || n === "ADMIN_TEST_ROUTES") && all.indexOf(n) === i).sort().join(" ") || "none") : ""')"
  if [ -z "$found" ]; then
    echo "Refusing to deploy: the list of the Worker's secrets could not be read (HTTP 200, Cloudflare error codes: $(api_codes)), so the check that none of ADMIN_SIG_MIN, ADMIN_ORIGIN and ADMIN_TEST_ROUTES is a secret did not run. Run this script again." >&2
    exit 1
  fi
  if [ "$found" != "none" ]; then
    for name in $found; do
      echo "Refusing to deploy: $name is set as a secret on the Worker $worker_name." >&2
    done
    echo "A secret survives every deploy and overrides what the source and worker/wrangler.toml say." >&2
    for name in $found; do
      case "$name" in
        ADMIN_SIG_MIN) echo "A leftover ADMIN_SIG_MIN of \"1\" would keep the v1 admin signature and its replay window open." >&2 ;;
        ADMIN_ORIGIN) echo "A leftover ADMIN_ORIGIN could accept requests signed for another deployment." >&2 ;;
        ADMIN_TEST_ROUTES) echo "A leftover ADMIN_TEST_ROUTES of \"1\" would keep the smoke's /admin/test/* fixture routes on after every deploy." >&2 ;;
      esac
    done
    for name in $found; do
      echo "Remove it with: cd worker && npx wrangler secret delete $name" >&2
    done
    case " $found " in
      *" ADMIN_SIG_MIN "*|*" ADMIN_ORIGIN "*)
        echo "If ADMIN_SIG_MIN or ADMIN_ORIGIN is still needed, commit its value in [vars] of worker/wrangler.toml (worker/README.md, Signature v2)." >&2 ;;
    esac
    case " $found " in
      *" ADMIN_TEST_ROUTES "*)
        echo "ADMIN_TEST_ROUTES belongs neither in a secret nor in [vars]: set it only for a fixture smoke, with npx wrangler deploy --var ADMIN_TEST_ROUTES:1 (worker/README.md, Smoke)." >&2 ;;
    esac
    echo "Then run this script again." >&2
    exit 1
  fi
elif [ "$status" = "404" ] && [[ ", $(api_codes), " == *", 10007, "* ]]; then
  echo "Note: the Worker $worker_name does not exist yet (a first deploy), so it has no secrets to check." >&2
else
  if [ "$status" = "000" ]; then
    echo "Could not reach api.cloudflare.com to list the Worker's secrets." >&2
  fi
  echo "Refusing to deploy: listing the Worker's secrets by name failed (HTTP $status, Cloudflare error codes: $(api_codes)), so the check that none of ADMIN_SIG_MIN, ADMIN_ORIGIN and ADMIN_TEST_ROUTES is a secret did not run. Run this script again; if it keeps failing, give the token the account permission \"Workers Scripts: Edit\" (which includes reading the names of a Worker's secrets)." >&2
  exit 1
fi

# 4. Deploy with the wrangler pinned in worker/package.json. Its output can list bindings and
# variables, so it is kept in a temporary file and only the URL is printed.

# redact_tail FILE prints the last lines of FILE with the token and account id values replaced.
redact_tail() {
  node -e '
    const fs = require("node:fs");
    let text = fs.readFileSync(process.argv[1], "utf8");
    for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
      const v = process.env[name];
      if (v) text = text.split(v).join(`[${name}]`);
    }
    process.stdout.write(text.split("\n").slice(-30).join("\n") + "\n");
  ' "$1"
}

if ! npx --yes wrangler deploy </dev/null >"$WORK/deploy.log" 2>&1; then
  echo "wrangler deploy failed; its last lines:" >&2
  redact_tail "$WORK/deploy.log" >&2
  if grep -q 'workers/scripts/.*failed' "$WORK/deploy.log" && grep -q 'No access to the specified resource' "$WORK/deploy.log"; then
    # Seen on 2026-11-10: the account token could list Workers and run Workers AI, but every call
    # on a named script (read, upload, secrets, deployments) answered 403, so it lacks the
    # "Workers Scripts: Edit" permission. wrangler's pre-deploy checks fail first.
    echo "Blocker: the Cloudflare token cannot read or upload Worker scripts (HTTP 403 on /workers/scripts/<name>). Give the token the account permission \"Workers Scripts: Edit\" (and \"Workers Tail: Read\" for CPU readings), then run this script again." >&2
  elif [ "$unreadable" = "1" ]; then
    echo "Blocker: the account probably has no workers.dev subdomain and the token cannot create one. Create it once in the dashboard (Workers & Pages, Overview, workers.dev subdomain), then run this script again." >&2
  fi
  exit 1
fi

url="$(grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' "$WORK/deploy.log" | head -n 1 || true)"
if [ -z "$url" ] && [ -n "$subdomain" ]; then
  url="https://${worker_name:-conference-caddie}.$subdomain.workers.dev"
fi
if [ -z "$url" ]; then
  echo "Deployed, but the workers.dev URL is unknown: the subdomain could not be read and wrangler printed no URL." >&2
  exit 1
fi
if [ -z "$subdomain" ]; then
  subdomain="$(printf '%s' "$url" | sed -n 's|^https://[^.]*\.\([^.]*\)\.workers\.dev$|\1|p')"
  echo "workers.dev subdomain: ${subdomain:-unknown}"
fi
echo "App URL (also the API base, CADDIE_APP_URL and CADDIE_API_BASE): $url"
echo "KubeCon NA 2026 link: $url/e/kubecon-cloudnativecon-north-america-2026"

# A new workers.dev subdomain can take a minute or two to resolve, so a failed health check is a
# warning, not a failure.
if ! curl -sS -o /dev/null --max-time 15 -f "$url/api/health" 2>/dev/null; then
  echo "Note: $url/api/health did not answer yet; a new workers.dev subdomain can take a few minutes to resolve." >&2
fi
