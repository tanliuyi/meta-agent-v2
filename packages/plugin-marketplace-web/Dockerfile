FROM node:22.22.1-alpine AS build

WORKDIR /workspace
COPY package.json package-lock.json ./
COPY packages/plugin-marketplace-web/package.json packages/plugin-marketplace-web/package.json
RUN npm ci --ignore-scripts --workspace @earendil-works/plugin-marketplace-web --include-workspace-root=false

COPY packages/plugin-marketplace-web packages/plugin-marketplace-web
RUN npm --prefix packages/plugin-marketplace-web run build

FROM nginxinc/nginx-unprivileged:1.29.5-alpine

COPY packages/plugin-marketplace-web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/packages/plugin-marketplace-web/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
