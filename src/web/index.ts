import { startWebServer } from './server.js';

const rawPort = process.env.AGENT_WORKBENCH_WEB_PORT;
const port = rawPort ? Number.parseInt(rawPort, 10) : 9099;
const dataDir = process.env.AGENT_WORKBENCH_WEB_DATA_DIR;

try {
  const handle = await startWebServer({ port, ...(dataDir ? { dataDir } : {}) });
  process.stdout.write(`Agent Workbench v0.6.0 is listening on http://127.0.0.1:${handle.port}\n`);
  process.stdout.write(`Open this single-use pairing URL:\n${handle.pairingURL}\n`);
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await handle.close();
      process.exit(0);
    } catch (error) {
      process.stderr.write(
        `agent-workbench-web: shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    }
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  process.once('SIGHUP', () => void stop());
} catch (error) {
  process.stderr.write(
    `agent-workbench-web: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
