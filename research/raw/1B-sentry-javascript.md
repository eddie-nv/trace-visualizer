# Raw research findings: sentry-javascript (getsentry/sentry-javascript, main, shallow clone)

All paths relative to repo root `workspace/sentry-javascript`.

# 1B.1 Init ordering (`Sentry.init()` for Node)

## Delegation chain

`packages/node/src/sdk/index.ts:42-44` — `init()` calls internal `_init(options, getDefaultIntegrations)`:

```ts
export function init(options: NodeOptions | undefined = {}): NodeClient | undefined {
  return _init(options, getDefaultIntegrations);
}
```

`packages/node/src/sdk/index.ts:49-70` — `_init` delegates almost everything to `@sentry/node-core`, then layers OTel on top:

```ts
function _init(
  options: NodeOptions | undefined = {},
  getDefaultIntegrationsImpl: (options: Options) => Integration[],
): NodeClient | undefined {
  applySdkMetadata(options, 'node');

  const client = initNodeCore({
    ...options,
    // Only use Node SDK defaults if none provided
    defaultIntegrations: options.defaultIntegrations ?? getDefaultIntegrationsImpl(options),
  });

  // Add Node SDK specific OpenTelemetry setup
  if (client && !options.skipOpenTelemetrySetup) {
    initOpenTelemetry(client, {
      spanProcessors: options.openTelemetrySpanProcessors,
    });
    validateOpenTelemetrySetup();
  }

  return client;
}
```

## Step-by-step inside node-core `_init` (`packages/node-core/src/sdk/index.ts:95-157`)

1. **Resolve client options** — `getClientOptions()` (`packages/node-core/src/sdk/index.ts:99`, impl at 190-229): merges env vars (`SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_DEBUG`), resolves release, transport, stack parser, and calls `getIntegrationsToSetup({ defaultIntegrations, integrations })` (line 216-219) — i.e. **integration dedup happens before the client exists**.
2. **Debug logging** — lines 101-111.
3. **ESM loader hook registration** — lines 113-115:
   ```ts
   if (options.registerEsmLoaderHooks !== false) {
     initializeEsmLoader();
   }
   ```
4. **Async context strategy** — `setOpenTelemetryContextAsyncContextStrategy()` line 117.
5. **Scope update** from `initialScope`, lines 119-120.
6. **Spotlight integration injection** if `options.spotlight`, lines 122-128.
7. **`applySdkMetadata(options, 'node-core')`** line 130.
8. **Client construction & binding** lines 132-136: `new NodeClient(options)`, `getCurrentScope().setClient(client)`, then `client.init()`. `client.init()` (core BaseClient, `packages/core/src/client.ts:495-507`) calls `_setupIntegrations()` (`packages/core/src/client.ts:1235-1239`) which runs `setupIntegrations(...)` + `afterSetupIntegrations(...)` — so all integrations' `setupOnce`/`setup` run *during* `Sentry.init()`, before OTel provider setup.
9. Lines 138-154: log `SDK initialized from ${isCjs() ? 'CommonJS' : 'ESM'}`, client report tracking, `updateScopeFromEnvVariables()` (reads `SENTRY_TRACE`/`SENTRY_BAGGAGE`/`SENTRY_USE_ENVIRONMENT`, lines 264-271), DSC enhancement, event-context trace, Vercel `SIGTERM` flush handler.

## OTel setup back in `@sentry/node` (`packages/node/src/sdk/initOtel.ts`)

`initOpenTelemetry` (lines 32-40) → `setupOtel` (lines 86-111) creates a `BasicTracerProvider` with `SentrySampler`, `SentrySpanProcessor`, then registers globals:

```ts
trace.setGlobalTracerProvider(provider);
propagation.setGlobalPropagator(new SentryPropagator());
const ctxManager = new SentryContextManager();
context.setGlobalContextManager(ctxManager);
```
(`packages/node/src/sdk/initOtel.ts:104-108`)

`validateOpenTelemetrySetup()` (`packages/node-core/src/sdk/index.ts:162-188`) is debug-build-only and `debug.error`s if `SentryContextManager`, `SentryPropagator`, or (with spans enabled) `SentrySpanProcessor` are missing, and `debug.warn`s if `SentrySampler` missing.

## How init-before-everything is enforced/encouraged

- **README pattern** — `packages/node/README.md:24-25`: "It is essential that you call `Sentry.init` before you require any other modules in your application, otherwise auto-instrumentation of these modules will **not** work." Lines 41-52 show the `import './instrument';` first pattern; lines 56-73 show `node --import ./instrument.mjs app.mjs` and `NODE_OPTIONS="--import ./instrument.mjs" npm run start`. Same content in `packages/node-core/README.md:39-115`.
- **Docs** — `docs/v8-node.md:38-42`: "`Sentry.init()` has to be called before any other require/import … Any package that is required/imported before Sentry is initialized may not be correctly auto-instrumented."
- **Runtime late-init detection** — `packages/node-core/src/utils/ensureIsWrapped.ts:18-48`. Checks OTel's `isWrapped()` on a framework function (e.g. `app.use`) and warns:

```ts
consoleSandbox(() => {
  if (isCjs()) {
    console.warn(
      `[Sentry] ${name} is not instrumented. This is likely because you required/imported ${name} before calling \`Sentry.init()\`.`,
    );
  } else {
    console.warn(
      `[Sentry] ${name} is not instrumented. Please make sure to initialize Sentry in a separate file that you \`--import\` when running node, see: https://docs.sentry.io/platforms/javascript/guides/${name}/install/esm/.`,
    );
  }
});
getGlobalScope().setContext('missing_instrumentation', createMissingInstrumentationContext(name));
```

Called from framework helpers, e.g. `packages/node/src/integrations/tracing/express.ts:23-30` (`setupExpressErrorHandler` → `ensureIsWrapped(app.use, 'express')`) and `packages/node/src/integrations/tracing/hapi/index.ts:122`. Silenced via `disableInstrumentationWarnings` (`ensureIsWrapped.ts:24`). The `missing_instrumentation` context payload: `packages/node-core/src/utils/createMissingInstrumentationContext.ts` (`{ package: pkg, 'javascript.is_cjs': isCjs() }`).
- **Node-version warning for ESM** — `packages/node-core/src/utils/detection.ts:28-37`: warns once that the SDK "is not compatible with ESM in Node.js versions before 18.19.0 or before 20.6.0".

There is **no** generic "module X was already imported before init" scanner; detection is limited to `ensureIsWrapped` at framework-handler-setup time.

# 1B.2 Preload mechanism

## Entry points (package exports)

`packages/node/package.json` `exports` map includes: `./import` → `./build/import-hook.mjs`, `./loader` → `./build/loader-hook.mjs`, `./init` → `build/{esm,cjs}/init.js`, `./preload` → `build/{esm,cjs}/preload.js`. `packages/node-core/package.json` exports `['./package.json', '.', './light', './import', './loader', './init', './light/otlp']` (no `./preload`).

## `@sentry/node/init` (`packages/node/src/init.ts:1-9`)

```ts
import { init } from './sdk';
/**
 * The @sentry/node/init export can be used with the node --import and --require args to initialize the SDK entirely via
 * environment variables.
 *
 * > SENTRY_DSN=... SENTRY_TRACES_SAMPLE_RATE=1.0 node --import=@sentry/node/init app.mjs
 */
init();
```
Same for node-core: `packages/node-core/src/init.ts`.

## `@sentry/node/preload` (`packages/node/src/preload.ts:1-20`)

```ts
import { envToBool } from '@sentry/node-core';
import { preloadOpenTelemetry } from './sdk/initOtel';

const debug = envToBool(process.env.SENTRY_DEBUG);
const integrationsStr = process.env.SENTRY_PRELOAD_INTEGRATIONS;
const integrations = integrationsStr ? integrationsStr.split(',').map(integration => integration.trim()) : undefined;
/**
 * The @sentry/node/preload export can be used with the node --import and --require args to preload the OTEL
 * instrumentation, without initializing the Sentry SDK.
 * ...
 * - `SENTRY_DEBUG` to enable debug logging
 * - `SENTRY_PRELOAD_INTEGRATIONS` to preload specific integrations - e.g. `SENTRY_PRELOAD_INTEGRATIONS="Http,Express"`
 */
preloadOpenTelemetry({ debug, integrations });
```

`preloadOpenTelemetry` (`packages/node/src/sdk/initOtel.ts:52-69`) calls `initializeEsmLoader()` then runs each preload instrumentation function. The preload list is `getOpenTelemetryInstrumentationToPreload()` (`packages/node/src/integrations/tracing/index.ts:72-104`): `instrumentSentryHttp, instrumentExpress, instrumentConnect, instrumentFastify, ... instrumentLangGraph`. Name filtering supports prefixes ("Fastify.v5" matches "Fastify") at `initOtel.ts:78-82`.

## ESM loader hook registration — `node:module` `register()` + import-in-the-middle

`packages/node-core/src/sdk/esmLoader.ts:12-31` (the function is `initializeEsmLoader`, **not** `maybeInitializeEsmLoader` — that name no longer exists in the repo):

```ts
export function initializeEsmLoader(): void {
  if (!supportsEsmLoaderHooks()) {
    return;
  }

  if (!GLOBAL_OBJ._sentryEsmLoaderHookRegistered) {
    GLOBAL_OBJ._sentryEsmLoaderHookRegistered = true;

    try {
      const { addHookMessagePort } = createAddHookMessageChannel();
      // @ts-expect-error register is available in these versions
      moduleModule.register('import-in-the-middle/hook.mjs', import.meta.url, {
        data: { addHookMessagePort, include: [] },
        transferList: [addHookMessagePort],
      });
    } catch (error) {
      debug.warn("Failed to register 'import-in-the-middle' hook", error);
    }
  }
}
```

- `createAddHookMessageChannel` comes from `import-in-the-middle` (`esmLoader.ts:2`); `import-in-the-middle: ^3.0.0` is a direct dependency of both `packages/node/package.json` and `packages/node-core/package.json`.
- `supportsEsmLoaderHooks()` (`packages/node-core/src/utils/detection.ts:19-40`) returns false under CJS and on Node < 18.19 / < 20.6 (with a console warning).
- Guarded by the global flag `GLOBAL_OBJ._sentryEsmLoaderHookRegistered`, declared at `packages/core/src/utils/worldwide.ts:56`.
- Called from two places: node-core `_init` when `registerEsmLoaderHooks !== false` (`packages/node-core/src/sdk/index.ts:113-115`) and `preloadOpenTelemetry` (`packages/node/src/sdk/initOtel.ts:59`).

## `@sentry/node/import` and `@sentry/node/loader` build artifacts

Generated by `makeOtelLoaders('./build', 'otel')` (`packages/node/rollup.npm.config.mjs:4`, `packages/node-core/rollup.npm.config.mjs:16`; builder in `dev-packages/rollup-utils/npmHelpers.mjs:183-256`). The 'otel' import-hook template (`dev-packages/rollup-utils/code/otelEsmImportHookTemplate.js`):

```js
import { register } from 'module';
register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
globalThis._sentryEsmLoaderHookRegistered = true;
```

and the loader-hook template (`otelEsmLoaderHookTemplate.js`) re-exports `getFormat, getSource, load, resolve` from `@opentelemetry/instrumentation/hook.mjs` for the legacy `--loader` flag. Setting `globalThis._sentryEsmLoaderHookRegistered = true` is what makes the later `initializeEsmLoader()` in `init()` a no-op.

## CJS path

There is no special preload registration for CJS. CJS interception is done by OTel's `InstrumentationBase` machinery: every instrumentation is registered via `registerInstrumentations({ instrumentations: [instrumentation] })` inside `generateInstrumentOnce` (`packages/node-core/src/otel/instrument.ts:63-65` and 97-99). `@opentelemetry/instrumentation` (`^0.214.0` in `packages/node/package.json` dependencies) internally uses `require-in-the-middle` for CJS and `import-in-the-middle` for ESM; `require-in-the-middle` does not appear as a direct dependency in this repo.

`generateInstrumentOnce` also dedups instrumentation by name via the `INSTRUMENTED` record (`instrument.ts:4`, 51-58, 87-92 — re-invocation just calls `setConfig`).

## Env vars / flags involved

- `--import @sentry/node/init`, `--require @sentry/node/init` (`packages/node/src/init.ts:4-7`)
- `--import @sentry/node/preload` with `SENTRY_DEBUG`, `SENTRY_PRELOAD_INTEGRATIONS` (`packages/node/src/preload.ts:4-18`)
- `NODE_OPTIONS="--import ./instrument.mjs"` (`packages/node/README.md:72`)
- `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_TRACES_SAMPLE_RATE`, `SENTRY_DEBUG` (`packages/node-core/src/sdk/index.ts:202-210`, 249-255), `SENTRY_TRACE`, `SENTRY_BAGGAGE`, `SENTRY_USE_ENVIRONMENT` (`packages/node-core/src/sdk/index.ts:264-271`)

# 1B.3 Integrations registry

## Integration interface

`packages/core/src/types/integration.ts:6-68` (note: `types-hoist/integration.ts` does not exist in this checkout). Full shape:

```ts
export interface Integration {
  name: string;
  setupOnce?(): void;                     // called once globally, for monkey patching
  beforeSetup?(client: Client): void;     // runs before any integration's setup
  setup?(client: Client): void;           // per-client; preferred over setupOnce
  afterAllSetup?(client: Client): void;   // after setupOnce()+setup() of ALL integrations
  preprocessEvent?(event: Event, hint: EventHint | undefined, client: Client): void;
  processEvent?(event: Event, hint: EventHint, client: Client): Event | null | PromiseLike<Event | null>;
  processSpan?(span: StreamedSpanJSON, client: Client): void;
  processSegmentSpan?(span: StreamedSpanJSON, client: Client): void;
}
export type IntegrationFn<IntegrationType = Integration> = (...rest: any[]) => IntegrationType; // line 75
```

## Declaration: `defineIntegration`

`packages/core/src/integration.ts:170-172` — identity function used purely for typing:

```ts
export function defineIntegration<Fn extends IntegrationFn>(fn: Fn): (...args: Parameters<Fn>) => Integration {
  return fn;
}
```

## Defaults

- Node: `getDefaultIntegrations(options)` at `packages/node/src/sdk/index.ts:28-37` = node-core defaults (with `Http`/`NodeFetch` swapped for composite versions, lines 18-25) + `getAutoPerformanceIntegrations()` only when `hasSpansEnabled(options)`.
- Node-core: `getDefaultIntegrations()` at `packages/node-core/src/sdk/index.ts:50-76` (inboundFilters, functionToString, linkedErrors, requestData, systemError, conversationId, console, http, nativeNodeFetch, onUncaughtException, onUnhandledRejection, contextLines, localVariables, nodeContext, childProcess, processSession, modules).
- Disabling: `defaultIntegrations: false` works because of `options.defaultIntegrations ?? getDefaultIntegrationsImpl(options)` (`packages/node/src/sdk/index.ts:58`; `packages/node-core/src/sdk/index.ts:214`) — `false` is not nullish, and `getIntegrationsToSetup` does `options.defaultIntegrations || []` (`packages/core/src/integration.ts:49`). There are also explicit `initWithoutDefaultIntegrations` exports (`packages/node/src/sdk/index.ts:75-77`, `packages/node-core/src/sdk/index.ts:88-90`).

## Dedup / merge logic (`packages/core/src/integration.ts`)

`getIntegrationsToSetup` (lines 46-69): flags defaults with `isDefaultInstance = true` (53-55); `integrations` as **array** → concatenated after defaults (59-60); as **function** → called with the defaults and its return value used wholesale (61-63); otherwise just defaults.

`filterDuplicates` (lines 25-43) — dedup is **by `name`, last wins**, except a default never overwrites a user instance:

```ts
// We want integrations later in the array to overwrite earlier ones of the same type, except that we never want a
// default instance to overwrite an existing user instance
if (existingInstance && !existingInstance.isDefaultInstance && currentInstance.isDefaultInstance) {
  return;
}
integrationsByName[name] = currentInstance;
```
(JSDoc line 20-21: "Not guaranteed to preserve the order of integrations in the array.")

## Setup logic

`setupIntegrations` (lines 77-94): first pass runs all `beforeSetup(client)`, second pass `setupIntegration` each. `setupIntegration` (lines 109-152):
- skips if already in this client's `integrationIndex` (line 110-113, logs "Integration skipped because it was already installed");
- `setupOnce()` only if name not in the module-level `installedIntegrations` array (lines 117-120) — i.e. global once-per-process;
- `setup(client)` per client (123-125);
- `preprocessEvent` → registered on client `'preprocessEvent'` hook (127-130); `processEvent` → wrapped into a client event processor with `id: integration.name` (132-140); `processSpan`/`processSegmentSpan` → client hooks (142-149).
- `afterSetupIntegrations` runs `afterAllSetup` for all (99-106).
- `addIntegration` (155-164) adds late to the current client, warning if no client.

Triggered from `BaseClient.init()` → `_setupIntegrations()` (`packages/core/src/client.ts:495-507`, 1235-1239), only when client `_isEnabled()` (DSN set) or a Spotlight integration is present.

# 1B.4 fetch/http instrumentation in Node

Summary of mechanisms (verified against `packages/node/package.json` dependencies — there is **no** `@opentelemetry/instrumentation-http` and **no** `@opentelemetry/instrumentation-undici` dependency; both roles are vendored/replaced):

## Outgoing `fetch` (undici / global fetch) — pure `diagnostics_channel`, no module patching

Two instrumentations, both registered by `nativeNodeFetchIntegration` (`packages/node/src/integrations/node-fetch/index.ts:72-89`):

```ts
const _nativeNodeFetchIntegration = ((options: NodeFetchOptions = {}) => {
  return {
    name: 'NodeFetch',
    setupOnce() {
      const instrumentSpans = _shouldInstrumentSpans(options, getClient<NodeClient>()?.getOptions());
      // This is the "regular" OTEL instrumentation that emits spans
      if (instrumentSpans) {
        instrumentOtelNodeFetch(options);
      }
      // This is the Sentry-specific instrumentation that creates breadcrumbs & propagates traces
      // This must be registered after the OTEL one, to ensure that the core trace propagation logic takes presedence
      instrumentSentryNodeFetch(options);
    },
  };
}) satisfies IntegrationFn;
```

1. **Span emitter: vendored `UndiciInstrumentation`** — `packages/node/src/integrations/node-fetch/vendored/undici.ts`. Provenance header lines 16-21: "Vendored from … @opentelemetry/instrumentation-undici@0.24.0". It extends `InstrumentationBase` but `init()` returns `undefined` ("No need to instrument files/modules", lines 88-91) — i.e. no require/import interception at all. `enable()` subscribes to diagnostics channels (lines 120-124):

```ts
this.subscribeToChannel('undici:request:create', this.onRequestCreated.bind(this));
this.subscribeToChannel('undici:client:sendHeaders', this.onRequestHeaders.bind(this));
this.subscribeToChannel('undici:request:headers', this.onResponseHeaders.bind(this));
this.subscribeToChannel('undici:request:trailers', this.onDone.bind(this));
this.subscribeToChannel('undici:request:error', this.onError.bind(this));
```

`subscribeToChannel` (lines 138-160) uses `diagch.subscribe` when available, falling back to `diagch.channel(...).subscribe` for the pre-18.19 ref-counting bug (comment line 139). Spans get `SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN: 'auto.http.otel.node_fetch'` via `startSpanHook` (`node-fetch/index.ts:127-144`). Spans only enabled when not `skipOpenTelemetrySetup` and spans enabled (`_shouldInstrumentSpans`, lines 108-114).

2. **Breadcrumbs + trace propagation: `SentryNodeFetchInstrumentation`** — `packages/node-core/src/integrations/node-fetch/SentryNodeFetchInstrumentation.ts`. Also `init()` returns undefined (lines 74-76); subscribes (lines 107-108):

```ts
this._subscribeToChannel('undici:request:create', this._onRequestCreated.bind(this));
this._subscribeToChannel('undici:request:headers', this._onResponseHeaders.bind(this));
```

Class doc, lines 49-58: "This custom node-fetch instrumentation is used to instrument outgoing fetch requests. It does not emit any spans. The reason this is isolated from the OpenTelemetry instrumentation is that users may overwrite this, which would lead to Sentry not working as expected."

**Conclusion for Bun relevance:** global fetch is instrumented *exclusively* via `diagnostics_channel` `undici:*` channels — no monkey-patching of `globalThis.fetch` or of an `undici` module export. Whether it works on a given runtime depends only on that runtime emitting Node's undici diagnostics channels. Notably, `packages/bun/src/sdk.ts:43` includes `nativeNodeFetchIntegration()` (imported from `@sentry/node`, line 19) in the Bun SDK defaults, and `httpIntegration()` at line 42.

## Outgoing/incoming `http`/`https`

No OTel `HttpInstrumentation` anywhere (not in package.json; only comments referencing it). The composite `httpIntegration` (`packages/node/src/integrations/http.ts:172-243`) wires three pieces:

1. **`SentryHttpInstrumentation`** (`packages/node-core/src/integrations/http/SentryHttpInstrumentation.ts`) — outgoing requests: breadcrumbs, trace propagation, and (Node ≥22.12) spans. Mechanism gate at lines 22-25:

```ts
const FULLY_SUPPORTS_HTTP_DIAGNOSTICS_CHANNEL =
  (NODE_VERSION.major === 22 && NODE_VERSION.minor >= 12) ||
  (NODE_VERSION.major === 23 && NODE_VERSION.minor >= 2) ||
  NODE_VERSION.major >= 24;
```

In `init()` (lines 216-247): when supported, subscribes to the diagnostics channel `'http.client.request.created'` (`HTTP_ON_CLIENT_REQUEST`, `packages/core/src/integrations/http/constants.ts:2`); otherwise **falls back to monkey-patching** via `patchHttpModuleClient`:

```ts
const sub = onHttpClientRequestCreated
  ? <T extends HttpModuleExport>(moduleExports: T): T => {
      if (!hasRegisteredHandlers && onHttpClientRequestCreated) {
        hasRegisteredHandlers = true;
        subscribe(HTTP_ON_CLIENT_REQUEST, onHttpClientRequestCreated);
      }
      return moduleExports;
    }
  : undefined;
const wrapHttp = sub ?? ((moduleExports: HttpModuleExport) => patchHttpModuleClient(moduleExports, patchOptions));
...
return [
  new InstrumentationNodeModuleDefinition('http', ['*'], wrapHttp),
  new InstrumentationNodeModuleDefinition('https', ['*'], wrapHttps),
];
```

Even the channel subscription is deferred until the `http`/`https` module is loaded via the `InstrumentationNodeModuleDefinition` hook, with this comment (lines 236-243): "If we'd subscribe before that, there seem to be conflicts with the OTEL native instrumentation in some scenarios, especially the 'import-on-top' pattern of setting up ESM applications." Class doc lines 144-158: "Span creation requires Node 22+ and uses diagnostic channels to avoid monkey-patching… Contrary to other OTEL instrumentation, this one cannot be unwrapped." The fallback patch lives in `packages/core/src/integrations/http/client-patch.ts:40-70` (wraps `httpModule.request`/`httpModule.get` and manually invokes the same handler `onHttpClientRequestCreated({ request }, HTTP_ON_CLIENT_REQUEST)`).

Comment in `packages/node/src/integrations/http.ts:230-234`: "This is Sentry-specific instrumentation for outgoing request breadcrumbs & trace propagation. It uses the diagnostic channels on node versions that support it, falling back to monkey-patching when needed."

2. **`httpServerIntegration`** (`packages/node-core/src/integrations/http/httpServerIntegration.ts`) — incoming requests (isolation, trace continuation). `setupOnce` at lines 148-151 subscribes to the diagnostics channel `'http.server.request.start'` (`HTTP_ON_SERVER_REQUEST = 'http.server.request.start'`, `packages/core/src/integrations/http/constants.ts:3`).

3. **`httpServerSpansIntegration`** — creates incoming-request spans off the client `'httpServerRequest'` event emitted by the server integration (`httpServerIntegration.ts:128-142`); gated on `hasSpansEnabled` in `httpIntegration.setup` (`packages/node/src/integrations/http.ts:197-203`).

# 1B.5 Failure-mode documentation

Each item = failure mode, citation, and (where present) Sentry's mitigation/fallback.

1. **Importing app modules before `Sentry.init()` breaks auto-instrumentation entirely.** `packages/node/README.md:24-25`; `docs/v8-node.md:38-42`. Mitigation: separate `instrument.js` + `--require`/`--import` (`docs/v8-node.md:67-79`). Runtime warning: `packages/node-core/src/utils/ensureIsWrapped.ts:33-43`.

2. **ESM loader hooks (import-in-the-middle) can themselves break libraries.** `packages/node-core/src/types.ts:92-100` (JSDoc for `registerEsmLoaderHooks`): "it can cause issues with certain libraries. If you run into problems running your app with this enabled, please raise an issue…". Escape hatch: `registerEsmLoaderHooks: false` (`packages/node-core/src/sdk/index.ts:113-115`).

3. **`module.register()` can simply fail** (e.g. hook file missing in bundled output) — caught and logged, not fatal: `packages/node-core/src/sdk/esmLoader.ts:27-29`.

4. **ESM on old Node is unsupported.** `packages/node-core/src/utils/detection.ts:28-37`: not compatible with ESM before Node 18.19.0 / 20.6.0. Fallback: returns false → no loader hooks (CJS require-in-the-middle still works).

5. **Bundlers don't include `import-in-the-middle/hook.mjs` because `module.register()` references aren't statically analyzable.** `packages/nuxt/src/vite/addServerConfig.ts:190-196`: "Prevents the error 'Failed to register ESM hook Error: Cannot find module import-in-the-middle/hook.mjs'" — fixed by force-adding `import 'import-in-the-middle/hook.mjs'` as an external side-effect import (also `addServerConfig.ts:241-242`). Same in SolidStart: `packages/solidstart/src/config/wrapServerEntryWithDynamicImport.ts:57-61`, 108-109, and `packages/solidstart/src/config/addInstrumentation.ts:180`.

6. **Bundled server entrypoints load app code before hooks register; needs dynamic-import wrapping.** `packages/nuxt/src/vite/addServerConfig.ts:93-97` / `packages/solidstart/src/config/addInstrumentation.ts:143-147`: "wraps the entry file with a dynamic import (`import()`)… needed for import-in-the-middle." Option `autoInjectServerSentry: 'experimental_dynamic-import'` (`packages/nuxt/src/common/types.ts:214-223`).

7. **Top-level-import fallback = degraded instrumentation (http only).** `packages/nuxt/src/common/types.ts:206-210`: "Only http traces will be collected (but no database-specific traces etc.)." Same in `packages/solidstart/src/vite/types.ts:155` and `packages/nuxt/src/vite/addServerConfig.ts:45-46`. Nuxt module nags about `NODE_OPTIONS='--import …'`: `packages/nuxt/src/module.ts:213` (dev), `:218` (prod).

8. **Double-init hazard:** `packages/nuxt/src/common/types.ts:200-202`: "DO NOT add the node CLI flag `--import` … when auto-injecting Sentry. This would initialize Sentry twice."

9. **Next.js: auto-instrumented packages must be externalized (not bundled).** `packages/nextjs/src/config/withSentryConfig/constants.ts:1-3`: "Packages we auto-instrument need to be external for instrumentation to work." Sentry patches `serverExternalPackages` / `experimental.serverComponentsExternalPackages` (`packages/nextjs/src/config/withSentryConfig/getFinalConfigObjectBundlerUtils.ts:227-249`). Counter-case (constants.ts:5-8): the `'ai'` package is *intentionally excluded* because externalizing it breaks its `react-server` conditional exports.

10. **Next.js `experimental.instrumentationHook` requirement** (Next < 15.0.0-canary.124): if disabled, "Sentry will not be initialized" — `packages/nextjs/src/config/withSentryConfig/getFinalConfigObjectUtils.ts:187-194`, 205-209.

11. **Bun `--bytecode` bundler breaks OTel's module-file scoping.** `packages/node/src/integrations/tracing/InstrumentationNodeModuleFile.ts:16-21`: vendored to work around Bun bytecode bundler renaming an indirect `normalize` import (issue getsentry/sentry-javascript#21256).

12. **Bundling hides modules from module-level hooks (LangChain).** `packages/node/src/integrations/tracing/langchain/instrumentation.ts:77-79`: "We hook into provider packages … because @langchain/core is often bundled and not loaded as a separate module."

13. **Minification/bundling renames private internals (Prisma v5 hack).** `packages/node/src/integrations/tracing/prisma/index.ts:86-100`: relies on internal `_idGenerator`; "may not work, e.g. if the code is bundled and the private property is renamed."

14. **User-overridable OTel instrumentation is not relied on for core Sentry behavior.** `packages/node-core/src/integrations/node-fetch/SentryNodeFetchInstrumentation.ts:50-55`; same dual-track design for http (`packages/node/src/integrations/http.ts:230-234`).

15. **Subscribing to http diagnostics channels too early conflicts with OTel native instrumentation in ESM.** `packages/node-core/src/integrations/http/SentryHttpInstrumentation.ts:236-243` — subscription deferred until http/https module load.

16. **`diagnostics_channel` ref-counting bug pre-18.19** — fallback in `packages/node/src/integrations/node-fetch/vendored/undici.ts:138-156`; `packages/node-core/src/integrations/node-fetch/SentryNodeFetchInstrumentation.ts:163-175`; "Keep ref to avoid nodejs/node#42170 bug" (`vendored/undici.ts:77-79`).

17. **Deno: no auto-instrumented spans at all.** `packages/deno/src/sdk.ts:128-133`.

18. **Webpack token replacement requires lazy reads.** `packages/node-core/src/integrations/modules.ts:17-23`.

19. **Cloudflare Workers lack async-hook-based mechanisms for some integrations.** `packages/cloudflare/src/integrations/tracing/vercelai.ts:5` / `packages/vercel-edge/src/integrations/tracing/vercelai.ts:5`.

20. **Performance integrations silently absent without tracing.** `packages/node/src/sdk/index.ts:31-34`.

**Net architecture takeaway:** the fragile mechanisms are module interception (require-in-the-middle/import-in-the-middle via `module.register`, items 1-7, 9, 11-12) and private-API poking (item 13); the robust mechanisms Sentry increasingly relies on are `diagnostics_channel` subscriptions (`undici:*` for fetch, `http.client.request.created` / `http.server.request.start` for http on Node ≥22.12) which require no module loading interception at all, with monkey-patching of `http.request` as the version fallback (`packages/core/src/integrations/http/client-patch.ts`).
