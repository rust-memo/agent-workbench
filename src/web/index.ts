import { startWebServer } from './server.js';

const rawPort = process.env.PENTESTERFLOW_WEB_PORT;
const port = rawPort ? Number.parseInt(rawPort, 10) : 9099;
const dataDir = process.env.PENTESTERFLOW_WEB_DATA_DIR;

try {
  const handle = await startWebServer({ port, ...(dataDir ? { dataDir } : {}) });
  process.stdout.write(`Agent Workbench v0.5.0 is listening on http://127.0.0.1:${handle.port}\n`);
  process.stdout.write(`Open this single-use pairing URL:\n${handle.pairingURL}\n`);
  const stop = async (): Promise<void> => {
    await handle.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
} catch (error) {
  process.stderr.write(
    `pentesterflow-web: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
