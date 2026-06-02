const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  lookup, parseOuiCsv,
  loadBundled, clearCache, detectVendor, cachePath, updateOuis,
} = require('..');

// Real-world fixtures — DevEUIs whose OUI prefixes are documented vendor blocks.
const FIX = {
  dragino: 'A84041035660E3AA',     // 6-char MA-L → Dragino Technology
  milesight: '24E124136D456789',   // 6-char MA-L → Xiamen Milesight IoT
  rak: 'AC1F09000000FFFF',         // 6-char MA-L → Shenzhen RAKwireless
  seeed: '2CF7F1C04490010D',       // 6-char MA-L → Seeed Technology
  ttn: '70B3D57ED0000001',         // 70:B3:D5 is LoRa Alliance MA-S parent
  unknown: 'FEDCBAFEDCBAFEDC',     // OUI FEDCBA — almost certainly unregistered
};

describe('lookup — pure function', () => {
  test('finds a 6-char MA-L block (Dragino)', () => {
    const reg = { A84041: 'Dragino Technology Co., Limited' };
    assert.deepEqual(lookup(reg, FIX.dragino), {
      oui: 'A84041',
      name: 'Dragino Technology Co., Limited',
    });
  });

  test('longest-prefix-match prefers MA-S over MA-L', () => {
    const reg = {
      '70B3D5': 'IEEE Registration Authority',
      '70B3D5F0F': 'Sub-Allocation Holder Inc.',
    };
    assert.deepEqual(lookup(reg, '70B3D5F0F1234567'), {
      oui: '70B3D5F0F',
      name: 'Sub-Allocation Holder Inc.',
    });
  });

  test('longest-prefix falls back to MA-M then MA-L when narrower blocks miss', () => {
    const reg = {
      '70B3D5': 'IEEE Registration Authority',
      '70B3D5F': 'MA-M holder',
      '70B3D5F0F': 'MA-S holder',
    };
    // MA-S hit
    assert.equal(lookup(reg, '70B3D5F0F1234567').name, 'MA-S holder');
    // MA-M hit (no MA-S match for this exact prefix)
    assert.equal(lookup(reg, '70B3D5F1FFFFFFFF').name, 'MA-M holder');
    // MA-L hit (no MA-M or MA-S match)
    assert.equal(lookup(reg, '70B3D5AABBCCDDEE').name, 'IEEE Registration Authority');
  });

  test('returns undefined for unregistered OUIs', () => {
    const reg = { A84041: 'Dragino Technology Co., Limited' };
    assert.equal(lookup(reg, 'FFFFFFAABBCCDDEE'), undefined);
  });

  test('is case-insensitive on the EUI input', () => {
    const reg = { A84041: 'Dragino Technology Co., Limited' };
    assert.equal(lookup(reg, 'a84041035660e3aa').oui, 'A84041');
    assert.equal(lookup(reg, 'A84041035660E3AA').oui, 'A84041');
  });

  test('returns undefined for malformed EUI lengths', () => {
    assert.equal(lookup({}, ''), undefined);
    assert.equal(lookup({}, 'A8404103'), undefined);              // 8 chars
    assert.equal(lookup({}, 'A84041035660E3AA00'), undefined);    // 18 chars
  });

  test('returns undefined for non-hex characters in the EUI', () => {
    assert.equal(lookup({}, 'A84041035660E3AZ'), undefined);  // Z
    assert.equal(lookup({}, 'not a hex string'), undefined);
    assert.equal(lookup({}, 'hello world test'), undefined);
  });

  test('returns undefined for non-string input', () => {
    assert.equal(lookup({}, null), undefined);
    assert.equal(lookup({}, undefined), undefined);
    assert.equal(lookup({}, 12345678), undefined);
    assert.equal(lookup({}, []), undefined);
  });

  test('accepts an empty registry without crashing', () => {
    assert.equal(lookup({}, FIX.dragino), undefined);
  });
});

describe('parseOuiCsv — pure function', () => {
  test('decodes MA-L, MA-M, and MA-S rows', () => {
    const csv = [
      'Registry,Assignment,Organization Name,Organization Address',
      'MA-L,A84041,"Dragino Technology Co., Limited",Building 8 ...',
      'MA-M,1234567,Mid-Size Vendor,Address',
      'MA-S,70B3D5F0F,Sub-Allocation Holder Inc.,Address',
    ].join('\n');
    const reg = parseOuiCsv(csv);
    assert.equal(reg.A84041, 'Dragino Technology Co., Limited');
    assert.equal(reg['1234567'], 'Mid-Size Vendor');
    assert.equal(reg['70B3D5F0F'], 'Sub-Allocation Holder Inc.');
  });

  test('handles quoted field values containing commas', () => {
    const csv = 'Registry,Assignment,Organization Name,Organization Address\n' +
      'MA-L,ABC123,"Quoted, with comma",Address';
    const reg = parseOuiCsv(csv);
    assert.equal(reg.ABC123, 'Quoted, with comma');
  });

  test('handles escaped double-quotes inside quoted fields', () => {
    const csv = 'Registry,Assignment,Organization Name,Organization Address\n' +
      'MA-L,ABC123,"He said ""hello""",Address';
    const reg = parseOuiCsv(csv);
    assert.equal(reg.ABC123, 'He said "hello"');
  });

  test('uppercases assignment fields', () => {
    const csv = 'Registry,Assignment,Organization Name\nMA-L,abc123,Lowercase Vendor';
    const reg = parseOuiCsv(csv);
    assert.equal(reg.ABC123, 'Lowercase Vendor');
    assert.equal(reg.abc123, undefined);
  });

  test('skips rows with the wrong assignment length', () => {
    const csv = [
      'Registry,Assignment,Organization Name',
      'MA-L,ABC,Too Short',                      // 3 chars
      'MA-L,ABCDEF12,Eight Char Bad',            // 8 chars (between 7 and 9)
      'MA-L,A84041,Valid MA-L',                  // 6 chars ✓
      'MA-M,1234567,Valid MA-M',                 // 7 chars ✓
    ].join('\n');
    const reg = parseOuiCsv(csv);
    assert.equal(reg.ABC, undefined);
    assert.equal(reg.ABCDEF12, undefined);
    assert.equal(reg.A84041, 'Valid MA-L');
    assert.equal(reg['1234567'], 'Valid MA-M');
  });

  test('skips rows with missing organization name', () => {
    const csv = 'Registry,Assignment,Organization Name\nMA-L,A84041,';
    const reg = parseOuiCsv(csv);
    assert.equal(reg.A84041, undefined);
  });

  test('skips rows with too few fields', () => {
    const csv = 'Registry,Assignment\nMA-L,A84041';
    const reg = parseOuiCsv(csv);
    assert.equal(Object.keys(reg).length, 0);
  });

  test('skips blank lines', () => {
    const csv = 'header\nMA-L,A84041,Dragino\n\n\nMA-L,24E124,Milesight\n';
    const reg = parseOuiCsv(csv);
    assert.equal(Object.keys(reg).length, 2);
  });

  test('handles CRLF and LF line endings', () => {
    const csvCrlf = 'header\r\nMA-L,A84041,Dragino\r\n';
    const csvLf = 'header\nMA-L,A84041,Dragino\n';
    assert.deepEqual(parseOuiCsv(csvCrlf), parseOuiCsv(csvLf));
  });

  test('returns empty registry on empty input', () => {
    assert.deepEqual(parseOuiCsv(''), {});
    assert.deepEqual(parseOuiCsv('header only\n'), {});
  });
});

describe('detectVendor — Node convenience', () => {
  beforeEach(() => clearCache());

  test('resolves Dragino from the bundled snapshot', () => {
    const v = detectVendor(FIX.dragino);
    assert.ok(v, 'expected a vendor match');
    assert.equal(v.oui, 'A84041');
    assert.match(v.name, /Dragino/);
  });

  test('resolves Milesight, RAK, and Seeed', () => {
    assert.match(detectVendor(FIX.milesight).name, /Milesight/);
    assert.match(detectVendor(FIX.rak).name, /RAKwireless/);
    assert.match(detectVendor(FIX.seeed).name, /Seeed/);
  });

  test('returns undefined for unregistered OUI', () => {
    assert.equal(detectVendor(FIX.unknown), undefined);
  });

  test('returns undefined for malformed input', () => {
    assert.equal(detectVendor(''), undefined);
    assert.equal(detectVendor('not-hex'), undefined);
    assert.equal(detectVendor('A8404103'), undefined);   // too short
  });

  test('handles uppercase and lowercase input identically', () => {
    const upper = detectVendor(FIX.dragino);
    const lower = detectVendor(FIX.dragino.toLowerCase());
    assert.deepEqual(upper, lower);
  });
});

describe('loadBundled — bundled snapshot statistics', () => {
  beforeEach(() => clearCache());

  test('returns a non-empty registry with all three IEEE size classes', () => {
    const reg = loadBundled();
    const counts = { 6: 0, 7: 0, 9: 0 };
    for (const k of Object.keys(reg)) counts[k.length] = (counts[k.length] || 0) + 1;
    assert.ok(counts[6] > 1000, `expected many MA-L entries, got ${counts[6]}`);
    assert.ok(counts[7] > 100, `expected MA-M entries, got ${counts[7]}`);
    assert.ok(counts[9] > 100, `expected MA-S entries, got ${counts[9]}`);
  });

  test('contains the well-known LoRaWAN vendor OUIs', () => {
    const reg = loadBundled();
    assert.match(reg.A84041, /Dragino/);
    assert.match(reg['24E124'], /Milesight/);
    assert.match(reg.AC1F09, /RAKwireless/);
    assert.match(reg['2CF7F1'], /Seeed/);
    assert.match(reg.E8E1E1, /Gemtek/);   // parent of Browan
  });

  test('is memoized — second call returns the same object', () => {
    const a = loadBundled();
    const b = loadBundled();
    assert.equal(a, b);
  });

  test('clearCache forces a re-read', () => {
    const a = loadBundled();
    clearCache();
    const b = loadBundled();
    assert.notEqual(a, b);              // distinct object identity
    assert.deepEqual(a.A84041, b.A84041); // same content
  });
});

describe('cachePath — Node-only path resolution', () => {
  test('honors OUI_REGISTRY_CACHE env override', () => {
    const original = process.env.OUI_REGISTRY_CACHE;
    process.env.OUI_REGISTRY_CACHE = '/tmp/oui-registry-test';
    assert.equal(cachePath(), '/tmp/oui-registry-test/ouis.json');
    if (original === undefined) delete process.env.OUI_REGISTRY_CACHE;
    else process.env.OUI_REGISTRY_CACHE = original;
  });

  test('falls back to XDG_CACHE_HOME when set', () => {
    const original = { x: process.env.XDG_CACHE_HOME, o: process.env.OUI_REGISTRY_CACHE };
    delete process.env.OUI_REGISTRY_CACHE;
    process.env.XDG_CACHE_HOME = '/tmp/custom-xdg';
    assert.equal(cachePath(), '/tmp/custom-xdg/intelligentfarming-oui-registry/ouis.json');
    if (original.x === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = original.x;
    if (original.o !== undefined) process.env.OUI_REGISTRY_CACHE = original.o;
  });

  test('defaults to ~/.cache when no env vars are set', () => {
    const original = { x: process.env.XDG_CACHE_HOME, o: process.env.OUI_REGISTRY_CACHE };
    delete process.env.OUI_REGISTRY_CACHE;
    delete process.env.XDG_CACHE_HOME;
    const expected = path.join(os.homedir(), '.cache', 'intelligentfarming-oui-registry', 'ouis.json');
    assert.equal(cachePath(), expected);
    if (original.x !== undefined) process.env.XDG_CACHE_HOME = original.x;
    if (original.o !== undefined) process.env.OUI_REGISTRY_CACHE = original.o;
  });
});

describe('updateOuis — Node-only refresh', () => {
  test('is an async function with the documented signature', () => {
    assert.equal(typeof updateOuis, 'function');
    assert.equal(updateOuis.constructor.name, 'AsyncFunction');
  });

  test('writes to a custom cache when one is provided and re-reads via loadBundled', { skip: true }, () => {
    // Skipped: this test would require network access to standards-oui.ieee.org.
    // Kept as documentation of the expected contract:
    //   await updateOuis() → writes cachePath(), invalidates the in-memory cache
    //   loadBundled() → re-reads the cache, returns the fresh registry
  });
});

describe('loadBundled — cache fallback behavior', () => {
  beforeEach(() => clearCache());

  test('reads the user cache when present (overrides bundled snapshot)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oui-registry-test-'));
    const tmpCache = path.join(tmpDir, 'ouis.json');
    const original = process.env.OUI_REGISTRY_CACHE;
    process.env.OUI_REGISTRY_CACHE = tmpDir;
    try {
      const fakeData = { TESTKEY: 'Test Org From Cache' };
      fs.writeFileSync(tmpCache, JSON.stringify(fakeData));
      clearCache();
      const reg = loadBundled();
      assert.equal(reg.TESTKEY, 'Test Org From Cache');
      // And not the bundled values:
      assert.equal(reg.A84041, undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (original === undefined) delete process.env.OUI_REGISTRY_CACHE;
      else process.env.OUI_REGISTRY_CACHE = original;
      clearCache();   // reset so other tests see the real bundled data
    }
  });
});
