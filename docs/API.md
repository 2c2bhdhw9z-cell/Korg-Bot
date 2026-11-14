# Korg compatibility API (v1)

These are Korg-authored adapters with the requested familiar API names. They are **partial API compatibility**, not the original Vendetta/Bunny implementation and not a promise that a legacy plugin will work. APIs not listed here throw or return `undefined`; inspect capabilities before using optional modules.

## Module discovery

- `metro.find(predicate)` returns the first recorded exports value for which the predicate returns true.
- `metro.findByProps(...names)` returns the first module/default export containing every named property.
- `metro.findByName(name)` matches a function's `name` or `displayName`.
- `metro.findByStoreName(name)` calls a guarded `getName()` method and matches its string result.
- `metro.common.React`, `.ReactNative`, `.FluxDispatcher` are lazy host lookups; missing capabilities throw a descriptive error.
- `metro.getAll()` / `.refresh()` returns already-observed exports; `metro.subscribe(listener)` observes later module initialization.

Korg does not execute every host module to discover it. Access may vary by React Native/Metro version.

## Patching

`patcher.before(method, target, callback)` receives `(args, receiver)`. Return a replacement argument array to change arguments; otherwise the original arguments are used.

`patcher.after(method, target, callback)` receives `(args, result, receiver)`. Returning `undefined` preserves the original result; returning any other value replaces it.

`patcher.instead(method, target, callback)` receives `(args, original, receiver)`; `original(...args)` calls the captured method with the original receiver. Every call returns an idempotent unpatch function. `unpatchAll()` removes only patches owned by that plugin, including nested wrappers removed out of order.

## Storage

`await storage.createStorage(name, { defaults })` returns a hydrated, deeply observed settings object. Nested changes and deletions save snapshots. Await `settings.flush()` to surface a failed save.

`storage.AsyncStorage` implements `getItem`, `setItem`, `removeItem`, `multiGet`, `multiSet`, `multiRemove`, `getAllKeys`, and `clear` in that plugin's own key namespace. Unavailable host storage is an explicit error; no fake persistent-memory fallback is used. The adapter also supports a plugin-supplied object backend with asynchronous `get`/`set` or `read`/`write`; each plugin instance remains separately scoped.

## Compatibility objects

`window.vendetta` and `window.bunny` point to the legacy-global compatibility scope. Korg's loader creates isolated plugin scopes for evaluated bundles; global writes performed directly by third-party code are not sandboxed.

Available namespaces include `metro`, `patcher`, `logger` (`log`, `debug`, `info`, `warn`, `error`), `storage`, `AsyncStorage`, `React`, `ReactNative`, `common`, `ui.components`, `ui.showToast`, and `plugin.id`. Supported `require()` names for downloaded bundles are explicitly allowlisted in `runtime/plugins.js`.

## Runtime URL plugins

The URL screen distinguishes a direct JavaScript bundle from a JSON manifest. Manifest `main` paths must be relative and cannot escape the manifest directory. Only HTTPS downloads whose final redirect URL stays HTTPS are accepted. Response source is limited to 2 MiB. Install saves source in host storage but leaves it disabled. An explicit enable evaluates it with `module.exports`, injected `vendetta`/`bunny`, a per-plugin scope, and the documented `require()` allowlist.

Disable and removal call a plugin's `onUnload()` if present, then remove plugin-owned patches. `onLoad()` runs when enabled. The currently supported settings surface is an exported `Settings` component or settings value when present. Caching is for convenience, not a security sandbox or signature mechanism. Code runs in the shared host JavaScript runtime with the capabilities explicitly exposed above.

The plugin store starts empty. Only URLs entered by the user are fetched; no third-party plugin code is built into the runtime.