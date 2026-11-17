import { BrowserDeviceClient } from "./client.js";

const client = new BrowserDeviceClient({ chrome, WebSocket });
void client.start().catch(() => {});
