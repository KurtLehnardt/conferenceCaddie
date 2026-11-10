#!/usr/bin/env node
// Local Workers AI proxy for `wrangler dev --local` runs that need real embeddings.
//
// Workers AI has no local simulator, and a remote dev session cannot be authenticated with an
// account API token, so the AI binding does not work in a local run. Instead, the Worker's
// embed.js posts `{model, text, pooling}` to the URL in env.EMBED_PROXY (written to the git-ignored
// .dev.vars by `node scripts/dev-vars.mjs --real-ai`), and this proxy forwards the call to the
// Workers AI REST API with CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from its own
// environment. The token therefore never enters the Worker or .dev.vars.
//
// Usage: node scripts/dev-ai-proxy.mjs [--port 8786]
// It listens on 127.0.0.1 only, accepts only embedding models (@cf/baai/bge-*), and logs one line
// per call with the number of texts and the status, never the texts or the token.

import { createServer } from 'node:http';

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const port = portArg >= 0 ? Number(args[portArg + 1]) : 8786;
const token = process.env.CLOUDFLARE_API_TOKEN;
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !account) {
  console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set.');
  process.exit(1);
}

const MODEL_RE = /^@cf\/baai\/bge-[a-z0-9.-]+$/;

const server = createServer(async (req, res) => {
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) return reply(413, { error: 'too large' });
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply(400, { error: 'bad json' });
  }
  if (!MODEL_RE.test(body?.model ?? '') || !Array.isArray(body?.text) || body.text.length > 100) {
    return reply(400, { error: 'expected {model, text[]} for a bge embedding model' });
  }
  // The pooling the Worker asks for (the embedding conventions need "cls"; Workers AI's default
  // is mean), forwarded as is so a local run embeds exactly as the deployed Worker does.
  if (body.pooling !== undefined && body.pooling !== 'cls' && body.pooling !== 'mean') return reply(400, { error: 'pooling must be cls or mean' });
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${body.model}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body.pooling ? { text: body.text, pooling: body.pooling } : { text: body.text }),
    });
    const j = await r.json().catch(() => ({}));
    console.log(`embed ${body.text.length} text(s) -> ${r.status}`);
    if (!r.ok || !j.success) return reply(502, { error: 'workers ai error', status: r.status });
    return reply(200, j.result);
  } catch {
    console.log(`embed ${body.text.length} text(s) -> network error`);
    return reply(502, { error: 'network error' });
  }
});

server.listen(port, '127.0.0.1', () => console.log(`dev AI proxy on http://127.0.0.1:${port}`));
