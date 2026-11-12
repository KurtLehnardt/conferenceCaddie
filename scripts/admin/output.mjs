// Output of the caddie-admin CLI. With --json, one JSON object on stdout. Otherwise one line per
// item and one summary line.

export function renderJson({ command, backend, tier, mode, result }) {
  return `${JSON.stringify({ ok: true, command, backend, tier, result: { mode, ...(result ?? {}) } })}\n`;
}

function cell(value) {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function itemLine(item) {
  if (item === null || typeof item !== 'object') return cell(item);
  return Object.entries(item).map(([key, value]) => `${key}=${cell(value)}`).join(' ');
}

export function renderHuman({ command, mode, result }) {
  const r = result ?? {};
  const lines = (Array.isArray(r.items) ? r.items : []).map(itemLine);
  const tail = mode === 'dry-run' ? ' (dry-run, nothing changed)' : '';
  lines.push(`${r.summary ?? `${command}: ok`}${tail}`);
  return `${lines.join('\n')}\n`;
}
