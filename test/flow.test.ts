// Poller + store + sender together, the way server.ts wires them (fake LamaPoll, fake SMTP).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Settings } from '../src/settings.ts';
import { Poller, type ResultsSource } from '../src/poller.ts';
import { Sender } from '../src/sender.ts';
import type { Mailer, OutgoingMail } from '../src/mailer.ts';
import type { CsvRow, LamaQuestion } from '../src/types.ts';
import { tempDir } from './helpers.ts';

const T0 = Date.UTC(2026, 9, 9, 18, 0, 0);
const questions: LamaQuestion[] = [
  { id: 1, type: 'INPUT', question: { de: 'Vorname' }, groups: [{ inputType: 'SINGLELINE', varnames: ['V2'] }] },
  { id: 2, type: 'INPUT', question: { de: 'E-Mail' }, groups: [{ inputType: 'SINGLELINE', varnames: ['V76'] }] },
];

/** Behaves like the API: returns every submission made on or after dateFrom (a plain date). */
class FakeLamaPoll implements ResultsSource {
  rows: { row: CsvRow; at: number }[] = [];
  submit(id: number, email: string, at: number) { this.rows.push({ row: { vID: String(id), vCOMPLETED: '1', V2: `P${id}`, V76: email }, at }); }
  async legacyResults(_pollId: number, o: { dateFrom?: string }) {
    const from = o.dateFrom ? Date.parse(o.dateFrom) : -Infinity;
    return this.rows.filter((r) => r.at >= from).map((r) => r.row);
  }
}

class CountingMailer implements Mailer {
  perAddress = new Map<string, number>();
  async send(m: OutgoingMail) { this.perAddress.set(m.to, (this.perAddress.get(m.to) ?? 0) + 1); }
}

function boot(path: string, lama: FakeLamaPoll, mailer: Mailer, clock: { now: number }) {
  const store = new Store(path);
  const settings = new Settings(store);
  if (!store.getKv('settings')) {
    settings.update({ apiKey: 'k', pollId: 1, emailVar: 'V76', firstNameVar: 'V2', smtpHost: 'h', fromEmail: 'a@b.de', questions, enabled: true, perAddressCap: 0 });
  }
  const now = () => clock.now;
  return {
    store,
    poller: new Poller({ store, settings, createSource: () => lama, now }),
    sender: new Sender({ store, settings, getMailer: () => mailer, now }),
  };
}

async function drain(sender: Sender) { while (await sender.sendNext()) { /* until the queue is empty */ } }

test('100 signups get exactly one mail each across many polls and a restart in the middle', async () => {
  const path = join(tempDir(), 'flow.db');
  const clock = { now: T0 };
  const lama = new FakeLamaPoll();
  const mailer = new CountingMailer();
  let app = boot(path, lama, mailer, clock);
  await app.poller.pollOnce(); // first poll on an empty poll: the event has not started

  let next = 1;
  for (let tick = 1; tick <= 30; tick++) {
    clock.now = T0 + tick * 20_000;
    for (let i = 0; i < 4 && next <= 100; i++, next++) {
      lama.submit(next, next === 8 ? 'p7@example.org' : `p${next}@example.org`, clock.now); // signup 8 reuses signup 7's address
    }
    await app.poller.pollOnce();
    await drain(app.sender);
    if (tick === 12) { app.store.close(); app = boot(path, lama, mailer, clock); } // restart mid-rush
  }

  const total = [...mailer.perAddress.values()].reduce((a, b) => a + b, 0);
  assert.equal(total, 100, 'exactly one mail per submission');
  assert.equal(mailer.perAddress.get('p7@example.org'), 2, 'the same address signing up twice gets two mails');
  assert.deepEqual(app.store.counts(), { sent: 100 });
});

test('signups that exist when the mailer is first activated are not mailed', async () => {
  const clock = { now: T0 };
  const lama = new FakeLamaPoll();
  lama.submit(1, 'old@example.org', T0 - 3_600_000);
  const mailer = new CountingMailer();
  const app = boot(join(tempDir(), 'f.db'), lama, mailer, clock);
  await app.poller.pollOnce();
  await drain(app.sender);
  assert.equal(mailer.perAddress.size, 0);
  assert.deepEqual(app.store.counts(), { skipped: 1 });
});
