import { loadConfig } from './config/env.js';
import { createNoir } from './server.js';

const config = loadConfig();
const noir = await createNoir(config);
noir.app.log.info(`NOIR listening on ${config.host}:${config.port}`);

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    noir.app.log.info(`${sig} received, shutting down`);
    const t = setTimeout(() => process.exit(1), 15_000);
    await noir.close();
    clearTimeout(t);
    process.exit(0);
  });
}
process.on('unhandledRejection', (err) => noir.app.log.error({ err }, 'unhandled rejection'));
