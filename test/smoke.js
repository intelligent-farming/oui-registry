const assert = require('assert');
const {
  lookup, parseOuiCsv,
  loadBundled, clearCache, detectVendor, cachePath,
} = require('..');

/* --- pure lookup against a synthetic registry --- */
{
  const reg = {
    'A84041': 'Dragino Technology Co., Limited',
    '70B3D5': 'IEEE Registration Authority',     // MA-L parent
    '70B3D5F0F': 'Sub-Allocation Holder Inc.',   // MA-S child (9 chars)
  };
  // 6-char MA-L match
  assert.deepStrictEqual(lookup(reg, 'A84041035660E3AA'),
    { oui: 'A84041', name: 'Dragino Technology Co., Limited' });
  // Longest-prefix wins — 9-char MA-S over 6-char MA-L parent
  assert.deepStrictEqual(lookup(reg, '70B3D5F0F1234567'),
    { oui: '70B3D5F0F', name: 'Sub-Allocation Holder Inc.' });
  // 6-char parent applies when no longer prefix matches
  assert.deepStrictEqual(lookup(reg, '70B3D5AABBCCDDEE'),
    { oui: '70B3D5', name: 'IEEE Registration Authority' });
  // Unknown OUI
  assert.strictEqual(lookup(reg, 'FFFFFFAABBCCDDEE'), undefined);
  // Case insensitivity
  assert.deepStrictEqual(lookup(reg, 'a84041035660e3aa'),
    { oui: 'A84041', name: 'Dragino Technology Co., Limited' });
  console.log('✓ pure lookup performs longest-prefix-match across MA-L/M/S');
}

/* --- pure lookup rejects malformed input --- */
{
  assert.strictEqual(lookup({}, ''), undefined);
  assert.strictEqual(lookup({}, 'not hex'), undefined);
  assert.strictEqual(lookup({}, 'A8404103'), undefined);     // too short
  assert.strictEqual(lookup({}, 'A84041035660E3AA00'), undefined);  // too long
  assert.strictEqual(lookup({}, null), undefined);
  console.log('✓ pure lookup returns undefined on malformed EUI input');
}

/* --- parseOuiCsv handles MA-L/M/S formats and quoted fields --- */
{
  const csv = [
    'Registry,Assignment,Organization Name,Organization Address',
    'MA-L,A84041,"Dragino Technology Co., Limited",Building 8 ...',
    'MA-S,70B3D5F0F,Sub-Allocation Holder Inc.,Address',
    'MA-M,1234567,"Quoted, with comma",Address',
    '',                                                    // skip blank
    'MA-L,abc,Too short,Address',                          // skip bad length
  ].join('\n');
  const reg = parseOuiCsv(csv);
  assert.strictEqual(reg['A84041'], 'Dragino Technology Co., Limited');
  assert.strictEqual(reg['70B3D5F0F'], 'Sub-Allocation Holder Inc.');
  assert.strictEqual(reg['1234567'], 'Quoted, with comma');
  assert.strictEqual(reg['ABC'], undefined);
  assert.strictEqual(Object.keys(reg).length, 3);
  console.log('✓ parseOuiCsv decodes quoted CSV and filters by valid assignment length');
}

/* --- Node-side: detectVendor uses bundled data --- */
{
  clearCache();   // ensure clean state
  const v = detectVendor('A84041035660E3AA');
  assert.ok(v, 'expected a vendor match for the bundled Dragino OUI');
  assert.strictEqual(v.oui, 'A84041');
  assert.ok(v.name.toLowerCase().includes('dragino'));
  // Sanity-check a couple other well-known LoRaWAN OUIs are in the snapshot.
  assert.ok(detectVendor('24E124000000ABCD').name.toLowerCase().includes('milesight'));
  assert.ok(detectVendor('AC1F0900000000FF').name.toLowerCase().includes('rakwireless'));
  console.log('✓ detectVendor resolves Dragino / Milesight / RAK from bundled snapshot');
}

/* --- Node-side: bundled snapshot includes all three IEEE registry sizes --- */
{
  clearCache();
  const reg = loadBundled();
  const counts = { 6: 0, 7: 0, 9: 0 };
  for (const k of Object.keys(reg)) counts[k.length] = (counts[k.length] || 0) + 1;
  assert.ok(counts[6] > 1000, `expected many MA-L entries, got ${counts[6]}`);
  assert.ok(counts[7] > 100, `expected MA-M entries, got ${counts[7]}`);
  assert.ok(counts[9] > 100, `expected MA-S entries, got ${counts[9]}`);
  console.log(`✓ loadBundled returns MA-L=${counts[6]} MA-M=${counts[7]} MA-S=${counts[9]} entries`);
}

/* --- cachePath honors env override --- */
{
  const original = process.env.OUI_REGISTRY_CACHE;
  process.env.OUI_REGISTRY_CACHE = '/tmp/oui-registry-test';
  assert.strictEqual(cachePath(), '/tmp/oui-registry-test/ouis.json');
  if (original === undefined) delete process.env.OUI_REGISTRY_CACHE;
  else process.env.OUI_REGISTRY_CACHE = original;
  console.log('✓ cachePath respects OUI_REGISTRY_CACHE env override');
}

console.log('ok');
