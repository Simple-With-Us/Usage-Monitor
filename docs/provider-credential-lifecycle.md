# Provider credential lifecycle contract

Provider secrets remain write-only. `GET /api/providers` exposes only:

- `apiKeyConfigured`, `apiKeyReadable`, and an optional last-four `keyPreview`;
- `secretConfigMeta.configured`, `readable`, display `fields`, and exact `paths` arrays.

It never returns a primary key or protected config value.

## Primary API key updates

`PUT /api/providers/:id` accepts `apiKeyAction`:

```json
{ "apiKeyAction": "preserve" }
```

```json
{ "apiKeyAction": "replace", "apiKey": "new-write-only-value" }
```

```json
{ "apiKeyAction": "clear" }
```

Omitting both fields preserves the current key. For backward compatibility, a non-empty `apiKey`
without `apiKeyAction` still means replace. Ambiguous combinations fail with 400.

## Protected secondary config updates

Use `secretConfigOperations` for exact encrypted field paths:

```json
{
  "secretConfigOperations": [
    { "path": ["apiSecret"], "action": "preserve" },
    { "path": ["nested", "password"], "action": "replace", "value": "new-write-only-value" },
    { "path": ["extraHeaders", "Authorization"], "action": "clear" }
  ]
}
```

Only paths classified as protected are accepted. Replace values are write-only strings. Existing
config behavior remains compatible: protected fields supplied inside `config` replace those fields,
while omitted protected fields are preserved. Explicit operations run last. `config: null` clears all
public and protected secondary config and therefore cannot be combined with per-field operations.

New config is limited to six levels, 200 entries, 128-character keys, and 4096-character strings.
Arrays, non-finite numbers, control-character keys, and `__proto__`/`constructor`/`prototype` keys are
rejected.

## Dashboard controls

The Settings provider editor implements this contract end to end:

1. the primary credential has explicit keep, replace, and clear actions;
2. every `secretConfigMeta.paths` entry has a write-only keep, replace, or clear control;
3. existing values are never requested, prefilled, or displayed;
4. clearing any credential on an active provider requires an explicit impact confirmation;
5. unreadable encrypted values are surfaced as a replace-or-clear error state.
