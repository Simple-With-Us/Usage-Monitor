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

## Coordinated UI hook

The provider-transparency lane already owns `AddProviderModal`, so this backend lane deliberately did
not edit it. After that lane lands, the modal should:

1. send `apiKeyAction=preserve|replace|clear` from an explicit control;
2. render clear controls from `secretConfigMeta.paths` and send only selected clear operations;
3. never request, prefill, or display an existing secret value;
4. require confirmation before clearing credentials used by an active provider.
