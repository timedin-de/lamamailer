// Entry point: opens the database, starts poller + sender + admin web server, shuts down cleanly.
// The only environment variables: HOST (default 127.0.0.1), PORT (default 3000), DATA_DIR (default ./data).
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './store.ts';
import { Settings } from './settings.ts';
import { Poller } from './poller.ts';
import { Sender } from './sender.ts';
import { createSmtpMailer } from './mailer.ts';
import { createApp } from './app.ts';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);
const dataDir = process.env.DATA_DIR ?? './data';

mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const dbPath = join(dataDir, 'mailer.db');
const store = new Store(dbPath);
chmodSync(dbPath, 0o600); // the file holds the API key and the SMTP password

const settings = new Settings(store);
const poller = new Poller({ store, settings });
const sender = new Sender({ store, settings, getMailer: () => createSmtpMailer(settings.get()) });
const { app, setupToken } = createApp({ store, settings });

const server = app.listen(port, host, () => {
  console.log(`Anmelde-Mailer läuft auf http://${host}:${port}`);
  if (store.getKv('admin_hash') === null) {
    console.log(`\n  Erster Start! Öffnen Sie die Adresse oben und legen Sie das Admin-Passwort fest.\n  Setup-Code: ${setupToken}\n`);
  }
});

// Ctrl-C or `systemctl stop`: stop the loops, let a running send finish and record its result, then exit.
const stop = new AbortController();
const loops = Promise.all([poller.run(stop.signal), sender.run(stop.signal)]);

async function shutdown(): Promise<void> {
  console.log('Beende …');
  stop.abort();
  server.close();
  server.closeIdleConnections();
  await loops;
  store.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
