FROM node:22.22.1-alpine AS dependencies

WORKDIR /workspace
COPY package.json package-lock.json ./
COPY packages/plugin-marketplace-server/package.json packages/plugin-marketplace-server/package.json
RUN npm ci --ignore-scripts --workspace @earendil-works/plugin-marketplace-server --include-workspace-root=false

FROM dependencies AS build

COPY tsconfig.base.json ./
COPY packages/plugin-marketplace-server/tsconfig.build.json packages/plugin-marketplace-server/tsconfig.build.json
COPY packages/plugin-marketplace-server/src packages/plugin-marketplace-server/src
RUN ./node_modules/.bin/tsc -p packages/plugin-marketplace-server/tsconfig.build.json

FROM node:22.22.1-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/plugin-marketplace-server/package.json packages/plugin-marketplace-server/package.json
RUN npm ci --omit=dev --ignore-scripts --workspace @earendil-works/plugin-marketplace-server --include-workspace-root=false \
  && npm cache clean --force
COPY --from=build /workspace/packages/plugin-marketplace-server/dist packages/plugin-marketplace-server/dist
COPY packages/plugin-marketplace-server/catalog packages/plugin-marketplace-server/catalog
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const port = process.env.MARKETPLACE_PORT || '4317'; const basePath = (process.env.MARKETPLACE_BASE_PATH || '').trim().replace(/\/+$/, ''); fetch('http://127.0.0.1:' + port + basePath + '/health').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"
CMD ["node", "packages/plugin-marketplace-server/dist/main.js"]
