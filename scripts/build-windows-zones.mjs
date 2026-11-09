// Builds data/windows-zones.json, the Windows-to-IANA time zone table, from CLDR windowsZones.xml.
// Only territory "001" rows are kept: they give the canonical IANA zone for each Windows zone name.
// Fetches the file once with the ingestion User-Agent. Node built-ins only.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchOnce } from './lib/http.mjs';

const URL = 'https://raw.githubusercontent.com/unicode-org/cldr/main/common/supplemental/windowsZones.xml';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const res = await fetchOnce(URL);
if (!res.ok) {
  console.error(`Fetching ${URL} failed: ${res.error}`);
  process.exit(1);
}

const table = {};
const re = /<mapZone\s+([^>]*?)\/?>/g;
let m;
while ((m = re.exec(res.text))) {
  const attrs = Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]]));
  if (attrs.territory !== '001') continue;
  const iana = attrs.type.split(/\s+/)[0];
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: iana });
  } catch {
    console.error(`CLDR maps "${attrs.other}" to "${iana}", which Intl does not accept.`);
    process.exit(1);
  }
  table[attrs.other] = iana;
}

const sorted = Object.fromEntries(Object.keys(table).sort().map((k) => [k, table[k]]));
writeFileSync(join(root, 'data/windows-zones.json'), JSON.stringify(sorted, null, 2) + '\n');
console.log(`Wrote ${Object.keys(sorted).length} Windows zones to data/windows-zones.json`);
