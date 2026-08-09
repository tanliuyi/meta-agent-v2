# Desktop Configuration Schema v1

This document is the reference for the `configuration` member of `market-manifest.json`. The source-of-truth implementation is `packages/desktop/src/shared/plugin-configuration-contracts.ts`; the same parser is used for local Developer Mode manifests and marketplace artifacts.

## Manifest Contract

A plugin that declares `configuration` must also declare the `configuration.read` capability.

```json
{
  "configuration": {
    "version": 1,
    "fields": []
  },
  "capabilities": ["configuration.read"]
}
```

The schema is metadata consumed by Desktop. It does not execute plugin code and it does not itself grant a sandbox permission. The extension reads the effective values from the host API:

```ts
const config = pi.getConfig<Readonly<Record<string, string | number | boolean>>>();
```

Keys are flat strings. A key such as `browser.openTarget` is still one scalar field; Desktop does not infer an object schema from dots. A plugin may map dotted keys to its own nested runtime configuration.

## Common Field Properties

Every field has these properties:

| Property | Type | Rules |
| --- | --- | --- |
| `key` | string | Starts with a letter, then letters, numbers, `.`, `_`, or `-`; maximum 64 characters. `__proto__`, `prototype`, and `constructor` are reserved. |
| `label` | string | Required, non-empty, maximum 120 characters. |
| `description` | string | Optional, maximum 1,000 characters. Explain behavior and trust implications. |
| `group` | string | Optional, maximum 64 characters. Used to organize the form. |
| `order` | integer | Optional, from 0 through 100,000. |
| `deprecated` | boolean | Optional. Marks a field without silently deleting stored values. |
| `deprecatedMessage` | string | Optional, maximum 240 characters. |
| `required` | boolean | Optional. Save/runtime validation fails until the field is configured. |
| `widget` | `model-selector` | Optional UI hint. Use only when the field should select a Desktop model. |
| `modelFormat` | `model-id` or `provider-model` | Optional; valid only with `widget: model-selector`. |

The schema supports at most 64 fields. Values crossing the host boundary are scalar strings, finite numbers, or booleans. Arrays, objects, functions, and `null` are not configuration values.

## Field Types

### `text`, `textarea`, and `path`

```json
{
  "key": "cachePath",
  "label": "Cache path",
  "type": "path",
  "placeholder": "~/.cache/example",
  "maxLength": 512,
  "description": "Directory used for generated files."
}
```

Supported type-specific properties:

- `defaultValue`: string, omitted for no default.
- `placeholder`: string, maximum 240 characters.
- `minLength`: safe integer from 0 through 65,536.
- `maxLength`: safe integer from 1 through 65,536.
- `pattern`: bounded regular expression. Desktop rejects unsafe or invalid expressions.
- `patternMessage`: optional validation message, maximum 240 characters.

`path` changes the input hint and does not authorize filesystem access. The plugin must normalize and validate paths against its own intended roots.

### `secret`

```json
{
  "key": "apiKey",
  "label": "API key",
  "type": "secret",
  "required": true,
  "minLength": 1,
  "placeholder": "Paste a key"
}
```

Secret fields cannot declare `defaultValue`. Desktop stores secret values through Electron `safeStorage`; the renderer receives only a configured/unconfigured boolean. The sidecar extension may receive the decrypted value through `pi.getConfig()`, so the plugin must never log it, include it in tool results, or write it to ordinary configuration files.

When secret storage is unavailable, saving a new secret returns a `secret-storage` validation error. A required secret is valid only when an encrypted value is already stored or a new value is supplied.

### `number`

```json
{
  "key": "timeoutSeconds",
  "label": "Timeout (seconds)",
  "type": "number",
  "defaultValue": 30,
  "minimum": 1,
  "maximum": 600,
  "step": 1
}
```

Supported properties are `defaultValue`, `minimum`, `maximum`, and `step`. All values must be finite numbers. `minimum` cannot exceed `maximum`; `step` must be positive. Defaults must be within the range and aligned with the step from `minimum` (or zero when no minimum is declared).

Use `0` deliberately. It is valid when the schema range allows it and commonly means disabled/unbounded in a plugin; document that behavior in `description`.

### `boolean`

```json
{
  "key": "enabled",
  "label": "Enable background sync",
  "type": "boolean",
  "defaultValue": false
}
```

`defaultValue` is optional and must be a boolean. Do not use a text or select field for a binary setting.

### `select`

```json
{
  "key": "mode",
  "label": "Mode",
  "type": "select",
  "defaultValue": "safe",
  "options": [
    { "value": "safe", "label": "Safe" },
    { "value": "fast", "label": "Fast", "description": "Uses more network and disk resources." }
  ]
}
```

`options` is required, non-empty, and limited to 100 entries. Each option has a non-empty `value` (maximum 240 characters), a non-empty `label` (maximum 120 characters), and an optional description (maximum 240 characters). Option values must be unique and the default must name an existing option.

## Runtime Semantics

Desktop creates effective values from schema defaults and saved values. An optional field without a default is omitted. Required fields are validated before the extension set is applied. The configuration object returned by `pi.getConfig()` is frozen and scoped to the current extension entry.

Configuration is stored separately from extension source:

- Marketplace plugin configuration is keyed by the marketplace plugin ID.
- Development plugin configuration is keyed by its `development:<id>` extension ID.
- Public values are stored in an owner-only file with mode `0600`.
- Secret plaintext is never returned by renderer IPC or included in configuration snapshots.
- Changing configuration invalidates the extension resolution fingerprint; existing workers may be replaced or require `/reload` according to the session state.

The host does not merge arbitrary values into `process.env`, `~/.pi/acp.json`, or a plugin's own files. The plugin decides how to map its flat values to its runtime library, and must preserve unrelated user configuration when it writes any downstream file.

## Common Mistakes

- Declaring `configuration` but forgetting `configuration.read`.
- Using `defaultValue` on a `secret` field.
- Passing an object or array through `pi.getConfig()`.
- Treating a `path` field as permission to read any filesystem location.
- Logging the complete configuration object when it may contain decrypted secrets.
- Reusing a saved field under a new meaning without marking the old field deprecated.
- Exposing an auto-update switch that conflicts with Desktop's host-managed update policy.
