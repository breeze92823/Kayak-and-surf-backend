import { ColyseusTestServer, boot } from "@colyseus/testing";

import appConfig from "../src/app.config.js";

// One test server for every test file: booting appConfig twice in one mocha run breaks the second
// boot. Mocha's --exit tears it down at the end.
let server: Promise<ColyseusTestServer<typeof appConfig>> | null = null;
export const testServer = () => (server ??= boot(appConfig));
