import { loadMarketplaceServerConfig } from "./config.ts";
import { createMarketplaceApp } from "./create-app.ts";

const config = loadMarketplaceServerConfig();
const app = await createMarketplaceApp({ config });
await app.listen(config.port, config.host);
console.info(`Plugin marketplace listening at ${config.publicBaseUrl}`);
