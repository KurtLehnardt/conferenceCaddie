// MOCK_FIXTURE_DO_NOT_SHIP
// A stand-in for POST /api/import/github, used only in development with VITE_MOCK=1. The handle
// "octocat" gets a fixed proposal whose topics exist in the mock topic list; any other handle is
// "not_found", so both the preview and the error copy can be exercised without GitHub.
import type { GithubProposal } from '../people/githubApi';

type Json = Record<string, unknown>;

const OCTOCAT: GithubProposal = {
  about: 'Sample bio: builds sample things in the open.',
  expertise:
    'Built sample-operator (Go): A sample Kubernetes operator for stateful workloads. ' +
    'Built sample-probes (C): Sample eBPF probes for network latency. ' +
    'Built sample-mesh-lab (Rust): A sample service mesh playground.',
  topic_candidates: ['go', 'c', 'rust', 'kubernetes', 'ebpf', 'service-mesh', 'gitops', 'operators'],
  repo_count: 7,
  suggested_speak_topics: [
    { topic_id: 'kubernetes', label: 'Kubernetes' },
    { topic_id: 'ebpf', label: 'eBPF' },
    { topic_id: 'service-mesh', label: 'Service Mesh' },
  ],
  extra_terms: ['go', 'c', 'rust', 'gitops', 'operators'],
};

/**
 * Returns the mock response body for a handle, or throws the error the caller builds from a
 * status and a body, so handler.ts can hand in its own HttpError class.
 */
export function mockImportGithub(handle: string, fail: (status: number, body: Json) => Error): Json {
  const h = String(handle ?? '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(h)) throw fail(400, { error: 'handle is not a GitHub user name' });
  if (h === 'octocat') return { ok: true, proposal: OCTOCAT };
  if (h === 'busy') throw fail(429, { error: 'rate_limited' });
  if (h === 'down') throw fail(502, { error: 'upstream' });
  throw fail(404, { error: 'not_found' });
}
