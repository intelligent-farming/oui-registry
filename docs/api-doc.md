# @intelligentfarming/oui-registry

Shared IEEE OUI registry for LoRaWAN tooling.

Replaces the duplicated OUI loaders previously inlined into
`chirpstack-join-watcher` and `lorawan-qr-decoder` — both bundled the same
1.8 MB JSON snapshot of the IEEE Organizationally Unique Identifier
registries (MA-L 24-bit, MA-M 28-bit, MA-S 36-bit).

The module is split into two layers:

- **Pure / isomorphic**: [lookup](#lookup), parseOuiCsv, type
  definitions. Take the registry data as an explicit parameter and run
  anywhere — Node, browser, edge runtime, Cloudflare Workers, etc.
- **Node convenience**: [detectVendor](#detectvendor), [loadBundled](#loadbundled),
  [updateOuis](#updateouis), [cachePath](#cachepath). Auto-load the bundled snapshot via
  `fs` and refresh from IEEE on demand. Calling these in a browser bundle
  will throw a clear error directing the caller to the pure-layer APIs.

## Examples

**Browser usage**

```ts
import ouis from '@intelligentfarming/oui-registry/data/ouis.json';
import { lookup } from '@intelligentfarming/oui-registry';

lookup(ouis, 'A84041035660E3AA');
// → { oui: 'A84041', name: 'Dragino Technology Co., Limited' }
```

**Node usage**

```ts
import { detectVendor, updateOuis } from '@intelligentfarming/oui-registry';

detectVendor('A84041035660E3AA');
// → { oui: 'A84041', name: 'Dragino Technology Co., Limited' }

await updateOuis();   // refresh from IEEE into the cache
```

## Interfaces

### VendorInfo

A matched OUI assignment.

#### Properties

##### name

> **name**: `string`

Organization name as registered with the IEEE.

##### oui

> **oui**: `string`

The matched assignment (6, 7, or 9 hex chars, uppercase).

## Type Aliases

### OuiRegistry

> **OuiRegistry** = `Record`\<`string`, `string`\>

Flat registry map: hex-string OUI assignment → registered organization
name. Keys are uppercase and may be 6 (MA-L 24-bit), 7 (MA-M 28-bit), or
9 (MA-S 36-bit) hex characters long.

## Functions

### cachePath()

> **cachePath**(): `string`

The cache file `updateOuis()` writes to. Honors `OUI_REGISTRY_CACHE` and
`XDG_CACHE_HOME` env vars; otherwise falls back to
`~/.cache/intelligentfarming-oui-registry/ouis.json`.

**Node only.** Throws in environments without `fs` / `path` / `os`.

#### Returns

`string`

***

### clearCache()

> **clearCache**(): `void`

Drop the in-memory registry cache so the next call re-reads from disk.

#### Returns

`void`

***

### detectVendor()

> **detectVendor**(`eui`): [`VendorInfo`](#vendorinfo) \| `undefined`

Convenience wrapper: looks up `eui` against the bundled / cached registry.

Equivalent to `lookup(loadBundled(), eui)`. **Node only.**

#### Parameters

##### eui

`string`

#### Returns

[`VendorInfo`](#vendorinfo) \| `undefined`

***

### loadBundled()

> **loadBundled**(): [`OuiRegistry`](#ouiregistry)

Load the registry from disk, preferring the user cache (when
[updateOuis](#updateouis) has been run) over the bundled snapshot.

Result is memoized — subsequent calls return the same object. To re-read
after writing the cache, call [clearCache](#clearcache) first.

**Node only.** Throws a clear error in browsers; use [lookup](#lookup) with an
imported JSON instead.

#### Returns

[`OuiRegistry`](#ouiregistry)

***

### lookup()

> **lookup**(`registry`, `eui`): [`VendorInfo`](#vendorinfo) \| `undefined`

Look up the IEEE-registered organization for a 16-character hex EUI.

Performs **longest-prefix-match** against MA-S (9 chars) → MA-M (7 chars)
→ MA-L (6 chars). Required because many LoRaWAN vendors hold MA-S
sub-allocations under MA-L holders' broader blocks — without longest-prefix
the lookup would incorrectly report the parent block's owner.

Pure function: takes the registry explicitly. Use this directly in browser
code with `import data from '@intelligentfarming/oui-registry/data/ouis.json'`.

#### Parameters

##### registry

[`OuiRegistry`](#ouiregistry)

The flat OUI map (see [OuiRegistry](#ouiregistry)).

##### eui

`string`

16-character hex EUI, case-insensitive.

#### Returns

[`VendorInfo`](#vendorinfo) \| `undefined`

A [VendorInfo](#vendorinfo) when matched, `undefined` when the EUI's OUI
         is unregistered or the input is not a valid 16-hex string.

***

### updateOuis()

> **updateOuis**(): `Promise`\<`string`\>

Download the three IEEE OUI CSVs (MA-L / MA-M / MA-S), parse them into the
compact JSON shape this module uses, and write the merged result to the
cache file returned by [cachePath](#cachepath). The next [detectVendor](#detectvendor)
call (after [clearCache](#clearcache)) picks up the refreshed data.

**Node only.**

#### Returns

`Promise`\<`string`\>

The cache file path that was written.
