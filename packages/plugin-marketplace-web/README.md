# Plugin Marketplace Web

Vite + React publisher console for `packages/plugin-marketplace-server`. It provides a publisher dashboard, owned-plugin management, version and artifact publishing workflows, and a read-only public catalog for release verification.

The UI uses official shadcn source components with Tailwind CSS v4, Radix primitives, class-variance-authority, and Lucide icons. shadcn primitives live in `src/components/ui`, console layout lives in `src/components/layout`, domain screens and reusable business components live in `src/features`, and route files only declare and mount pages. Design tokens live in `src/styles.css`; `components.json` contains the shadcn CLI configuration.

## Development

Start the marketplace server first:

```bash
npm --prefix packages/plugin-marketplace-server run dev
```

Then start the web client:

```bash
npm --prefix packages/plugin-marketplace-web run dev
```

Open `http://127.0.0.1:4318`. Vite proxies `/marketplace-api` to the configured marketplace server. Set `VITE_MARKETPLACE_PROXY_TARGET` to override the development proxy target.

## Production

Build assets with the package build script and serve `dist/` from a static web server. Client routes use hash history, so direct navigation and reloads do not require an SPA fallback rewrite. The browser API base defaults to `/marketplace-api`; configure the reverse proxy to forward that path to the marketplace server and strip the prefix.

Set `VITE_MARKETPLACE_API_BASE_URL` at build time to use another browser-facing API path. Since the marketplace server does not currently enable CORS, the production API path should remain on the same origin as the web application unless CORS is configured separately.

## Validation

```bash
npm --prefix packages/plugin-marketplace-web run typecheck
npm run check
```
