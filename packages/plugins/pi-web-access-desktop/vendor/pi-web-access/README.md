# Vendored pi-web-access

This directory is based on `pi-web-access@0.18.0` and is used only by the Desktop plugin.

Desktop-specific behavior:

- `fetch_content` does not perform local DNS resolution or private-address SSRF preflight.
- HTTP(S) protocol validation and `fetchContent.domainPolicy` allow/deny checks remain active.
- Request timeouts and response size limits remain active.

Keep this copy synchronized with the upstream package when upgrading. The upstream package's original README and changelog are intentionally not included here because their SSRF configuration guidance does not describe this Desktop fork.
