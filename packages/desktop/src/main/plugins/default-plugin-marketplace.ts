import type { TrustedMarketplaceEndpoint } from "./marketplace-endpoint-settings-service.ts";

export const DEFAULT_PLUGIN_MARKETPLACE: TrustedMarketplaceEndpoint = {
  marketplaceId: "meta-agent-development",
  baseUrl: "http://100.91.230.10:4317/",
  apiRoot: "http://100.91.230.10:4317/v1/",
  artifactOrigins: ["http://100.91.230.10:4317"],
  signing: {
    algorithm: "ed25519",
    keyId: "ed25519:e2fe86ee17f7f211",
    fingerprint: "sha256:e2fe86ee17f7f2114f71351ac8592dceb485a0faa0432bc11bf2a89398690d18",
    publicKey: "MCowBQYDK2VwAyEA/4Apt+Cza7FKv16+6RegqGI8i5EzCWklHpYUZK3qEHs=",
  },
  active: true,
};
