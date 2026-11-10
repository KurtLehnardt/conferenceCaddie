#!/bin/bash
# Deploys the Conference Caddie API Worker (the free stack) to Cloudflare.
#
# Usage, from anywhere in the repository:
#   bash worker/scripts/deploy.sh                    ensure the workers.dev subdomain, then deploy
#   bash worker/scripts/deploy.sh --subdomain-only   only ensure the workers.dev subdomain
#
# Reads CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the environment and never prints them.
# The token reaches curl through its standard input (a curl config read with -K -), never through
# a command line, so it does not show up in the process list either.
#
# Steps:
#   1. GET /accounts/{account}/workers/subdomain. When the account has no workers.dev subdomain yet,
#      PUT {"subdomain":"kurtlehnardt"}, and on a conflict fall back to
#      conference-caddie-<6 random lowercase letters>.
#   2. npx wrangler deploy from worker/ (the wrangler version pinned in worker/package.json).
#      Its output goes to a temporary file that is deleted on exit; only the Worker URL is printed.
#
# Output is the subdomain name and the Worker URL only. On a failure the script prints the HTTP
# status and Cloudflare's error codes, or the last lines of the wrangler output with the token
# value redacted.
#
# Deploy order (worker/README.md): this script, then node worker/scripts/setup-secrets.mjs, then
# the migration, then GitHub Pages. Until ADMIN_TOKEN exists the admin routes answer 404.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PREFERRED_SUBDOMAIN="kurtlehnardt"
FALLBACK_PREFIX="conference-caddie-"
API="https://api.cloudflare.com/client/v4"

SUBDOMAIN_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --subdomain-only) SUBDOMAIN_ONLY=1 ;;
    -h|--help)
      sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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
command -v node >/dev/null || { echo "node (22 or later) is required." >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required." >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/caddie-deploy.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# cf_api METHOD PATH [JSON BODY] writes the response body to $WORK/resp.json and prints the HTTP
# status. The Authorization header is fed to curl as a config line on standard input; printf is a
# shell builtin, so the token never appears in any process's arguments.
cf_api() {
  local method="$1" path="$2" body="${3:-}"
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
# prints the result (an empty string for null or undefined).
json_field() {
  node -e '
    const fs = require("node:fs");
    let r = {};
    try { r = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch {}
    const v = (new Function("r", "return (" + process.argv[2] + ");"))(r);
    process.stdout.write(v == null ? "" : String(v));
  ' "$WORK/resp.json" "$1"
}

# Cloudflare's error codes and messages, which never contain the token.
api_errors() {
  json_field '(r.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ") || "no error details"'
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
  candidate="$PREFERRED_SUBDOMAIN"
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

# 2. Deploy with the wrangler pinned in worker/package.json. Its output can list bindings and
# variables, so it is kept in a temporary file and only the URL is printed.
cd "$WORKER_DIR"
if [ ! -d node_modules ]; then
  if ! npm ci --no-audit --no-fund >"$WORK/npm.log" 2>&1; then
    echo "npm ci failed in worker/:" >&2
    tail -n 20 "$WORK/npm.log" >&2
    exit 1
  fi
fi

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
  if [ "$unreadable" = "1" ]; then
    echo "Blocker: the account probably has no workers.dev subdomain and the token cannot create one. Create it once in the dashboard (Workers & Pages, Overview, workers.dev subdomain), then run this script again." >&2
  fi
  exit 1
fi

worker_name="$(sed -n 's/^name *= *"\([^"]*\)".*/\1/p' wrangler.toml | head -n 1)"
url="$(grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' "$WORK/deploy.log" | head -n 1 || true)"
if [ -z "$url" ] && [ -n "$subdomain" ]; then
  url="https://${worker_name:-conference-caddie-api}.$subdomain.workers.dev"
fi
if [ -z "$url" ]; then
  echo "Deployed, but the workers.dev URL is unknown: the subdomain could not be read and wrangler printed no URL." >&2
  exit 1
fi
if [ -z "$subdomain" ]; then
  subdomain="$(printf '%s' "$url" | sed -n 's|^https://[^.]*\.\([^.]*\)\.workers\.dev$|\1|p')"
  echo "workers.dev subdomain: ${subdomain:-unknown}"
fi
echo "Worker URL: $url"

# A new workers.dev subdomain can take a minute or two to resolve, so a failed health check is a
# warning, not a failure.
if ! curl -sS -o /dev/null --max-time 15 -f "$url/api/health" 2>/dev/null; then
  echo "Note: $url/api/health did not answer yet; a new workers.dev subdomain can take a few minutes to resolve." >&2
fi
