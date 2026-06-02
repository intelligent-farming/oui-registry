/**
 * Shared IEEE OUI registry for LoRaWAN tooling.
 *
 * The module is split into two layers:
 *
 * - **Pure / isomorphic**: {@link lookup}, {@link parseOuiCsv}, type
 *   definitions. Take the registry data as an explicit parameter and run
 *   anywhere — Node, browser, edge runtime, Cloudflare Workers, etc.
 * - **Node convenience**: {@link detectVendor}, {@link loadBundled},
 *   {@link updateOuis}, {@link cachePath}. Auto-load the bundled snapshot via
 *   `fs` and refresh from IEEE on demand. Calling these in a browser bundle
 *   will throw a clear error directing the caller to the pure-layer APIs.
 *
 * @example Browser usage
 * ```ts
 * import ouis from '@intelligentfarming/oui-registry/data/ouis.json';
 * import { lookup } from '@intelligentfarming/oui-registry';
 *
 * lookup(ouis, 'A84041035660E3AA');
 * // → { oui: 'A84041', name: 'Dragino Technology Co., Limited' }
 * ```
 *
 * @example Node usage
 * ```ts
 * import { detectVendor, updateOuis } from '@intelligentfarming/oui-registry';
 *
 * detectVendor('A84041035660E3AA');
 * // → { oui: 'A84041', name: 'Dragino Technology Co., Limited' }
 *
 * await updateOuis();   // refresh from IEEE into the cache
 * ```
 *
 * @packageDocumentation
 */

/* -------------------------------------------------------------------------- */
/* Public types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Flat registry map: hex-string OUI assignment → registered organization
 * name. Keys are uppercase and may be 6 (MA-L 24-bit), 7 (MA-M 28-bit), or
 * 9 (MA-S 36-bit) hex characters long.
 */
export type OuiRegistry = Record<string, string>;

/** A matched OUI assignment. */
export interface VendorInfo {
  /** The matched assignment (6, 7, or 9 hex chars, uppercase). */
  oui: string;
  /** Organization name as registered with the IEEE. */
  name: string;
}

/* -------------------------------------------------------------------------- */
/* Pure (isomorphic) API                                                       */
/* -------------------------------------------------------------------------- */

const HEX16_RE = /^[0-9A-F]{16}$/;

/**
 * Look up the IEEE-registered organization for a 16-character hex EUI.
 *
 * Performs **longest-prefix-match** against MA-S (9 chars) → MA-M (7 chars)
 * → MA-L (6 chars). Required because many LoRaWAN vendors hold MA-S
 * sub-allocations under MA-L holders' broader blocks — without longest-prefix
 * the lookup would incorrectly report the parent block's owner.
 *
 * Pure function: takes the registry explicitly. Use this directly in browser
 * code with `import data from '@intelligentfarming/oui-registry/data/ouis.json'`.
 *
 * @param registry The flat OUI map (see {@link OuiRegistry}).
 * @param eui      16-character hex EUI, case-insensitive.
 * @returns A {@link VendorInfo} when matched, `undefined` when the EUI's OUI
 *          is unregistered or the input is not a valid 16-hex string.
 */
export const lookup = (registry: OuiRegistry, eui: string): VendorInfo | undefined => {
  if (typeof eui !== 'string') return undefined;
  const e = eui.toUpperCase();
  if (!HEX16_RE.test(e)) return undefined;
  for (const len of [9, 7, 6] as const) {
    const key = e.slice(0, len);
    const name = registry[key];
    if (name) return { oui: key, name };
  }
  return undefined;
};

/**
 * Parse the IEEE OUI CSV format into the flat map this module uses. Exposed
 * for build scripts that download fresh CSVs from `standards-oui.ieee.org`
 * and bake them into the bundled snapshot; not normally needed at runtime.
 *
 * Header (varies slightly per registry): `Registry,Assignment,Organization Name,Organization Address`.
 *
 * @internal Exposed for {@link updateOuis} and the build script.
 */
export const parseOuiCsv = (csv: string): OuiRegistry => {
  const out: OuiRegistry = {};
  const lines = csv.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const fields = splitCsv(line);
    if (fields.length < 3) continue;
    const assignment = fields[1].trim().toUpperCase();
    const name = fields[2].trim();
    if ((assignment.length === 6 || assignment.length === 7 || assignment.length === 9) && name) {
      out[assignment] = name;
    }
  }
  return out;
};

const splitCsv = (line: string): string[] => {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"' && inQuotes) { cur += '"'; i++; }
    else if (ch === '"') inQuotes = !inQuotes;
    else if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
};

/* -------------------------------------------------------------------------- */
/* Node convenience layer                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The cache file `updateOuis()` writes to. Honors `OUI_REGISTRY_CACHE` and
 * `XDG_CACHE_HOME` env vars; otherwise falls back to
 * `~/.cache/intelligentfarming-oui-registry/ouis.json`.
 *
 * **Node only.** Throws in environments without `fs` / `path` / `os`.
 */
export const cachePath = (): string => {
  const { os, path } = nodeApis();
  const root = process.env.OUI_REGISTRY_CACHE
    || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'intelligentfarming-oui-registry');
  return path.join(root, 'ouis.json');
};

let _bundled: OuiRegistry | undefined;

/**
 * Load the registry from disk, preferring the user cache (when
 * {@link updateOuis} has been run) over the bundled snapshot.
 *
 * Result is memoized — subsequent calls return the same object. To re-read
 * after writing the cache, call {@link clearCache} first.
 *
 * **Node only.** Throws a clear error in browsers; use {@link lookup} with an
 * imported JSON instead.
 */
export const loadBundled = (): OuiRegistry => {
  if (_bundled) return _bundled;
  const { fs, path } = nodeApis();
  const cached = cachePath();
  const bundled = path.join(__dirname, '..', 'data', 'ouis.json');
  const file = fs.existsSync(cached) ? cached : bundled;
  _bundled = JSON.parse(fs.readFileSync(file, 'utf8')) as OuiRegistry;
  return _bundled;
};

/** Drop the in-memory registry cache so the next call re-reads from disk. */
export const clearCache = (): void => { _bundled = undefined; };

/**
 * Convenience wrapper: looks up `eui` against the bundled / cached registry.
 *
 * Equivalent to `lookup(loadBundled(), eui)`. **Node only.**
 */
export const detectVendor = (eui: string): VendorInfo | undefined => lookup(loadBundled(), eui);

/** IEEE CSV endpoints merged by {@link updateOuis} (in this order). */
const OUI_CSV_URLS = [
  'https://standards-oui.ieee.org/oui/oui.csv',     // MA-L (24-bit) — ~40k entries
  'https://standards-oui.ieee.org/oui28/mam.csv',   // MA-M (28-bit)
  'https://standards-oui.ieee.org/oui36/oui36.csv', // MA-S (36-bit) — most LoRaWAN vendors
];

/**
 * Download the three IEEE OUI CSVs (MA-L / MA-M / MA-S), parse them into the
 * compact JSON shape this module uses, and write the merged result to the
 * cache file returned by {@link cachePath}. The next {@link detectVendor}
 * call (after {@link clearCache}) picks up the refreshed data.
 *
 * **Node only.**
 *
 * @returns The cache file path that was written.
 */
export const updateOuis = async (): Promise<string> => {
  const { fs, path } = nodeApis();
  const cache = cachePath();
  fs.mkdirSync(path.dirname(cache), { recursive: true });
  const merged: OuiRegistry = {};
  for (const url of OUI_CSV_URLS) Object.assign(merged, parseOuiCsv(await fetchText(url)));
  fs.writeFileSync(cache, JSON.stringify(merged));
  _bundled = merged;
  return cache;
};

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

interface NodeApis { fs: typeof import('fs'); path: typeof import('path'); os: typeof import('os'); https: typeof import('https'); }

const nodeApis = (): NodeApis => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const req: NodeRequire = (typeof require !== 'undefined' ? require : (eval('require') as NodeRequire));
    return { fs: req('fs'), path: req('path'), os: req('os'), https: req('https') };
  } catch {
    throw new Error(
      '@intelligentfarming/oui-registry: this function requires Node.js APIs. ' +
      'In a browser bundle, import the registry data directly and use lookup() instead: ' +
      `import data from '@intelligentfarming/oui-registry/data/ouis.json'; lookup(data, eui).`,
    );
  }
};

const fetchText = (url: string): Promise<string> => new Promise((resolve, reject) => {
  const { https } = nodeApis();
  https.get(url, res => {
    if (res.statusCode !== 200) return reject(new Error(`${url} → HTTP ${res.statusCode}`));
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    res.on('error', reject);
  }).on('error', reject);
});
