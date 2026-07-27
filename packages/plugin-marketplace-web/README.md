# Plugin Marketplace Web

Vite + React web client for `packages/plugin-marketplace-server`. It provides public catalog browsing, search, category filtering, plugin/version details, artifact downloads, account login/registration, and community ratings.

The UI uses shadcn's source-component model with Tailwind CSS v4, Radix primitives, class-variance-authority, and Lucide icons. Generated-style primitives live in `src/components/ui`, design tokens live in `src/styles.css`, and `components.json` contains the shadcn CLI aliases and configuration.

## Development

Start the marketplace server first:

```bash
set -a
. packages/plugin-marketplace-server/.env.example
set +a
npm --prefix packages/plugin-marketplace-server run dev
```

Then start the web client:

```bash
npm --prefix packages/plugin-marketplace-web run dev
```

Open `http://127.0.0.1:4318`. Vite proxies `/marketplace-api` to `http://127.0.0.1:4317` by default. Set `MARKETPLACE_PROXY_TARGET` to use another development server.

## Production

Build assets with the package build script and serve `dist/` from a static web server. The browser API base defaults to `/marketplace-api`; configure the reverse proxy to forward that path to the marketplace server and strip the prefix.

Set `VITE_MARKETPLACE_API_BASE_URL` at build time to use another browser-facing API path. Since the marketplace server does not currently enable CORS, the production API path should remain on the same origin as the web application unless CORS is configured separately.

## Validation

```bash
npm --prefix packages/plugin-marketplace-web run typecheck
npm run check
```
