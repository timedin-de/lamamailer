import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Settings } from '../src/settings.ts';
import { Poller, pollWaitMs, type ResultsSource } from '../src/poller.ts';
import type { CsvRow, LamaQuestion } from '../src/types.ts';
import type { ResultsOptions } from '../src/lamapoll.ts';
import { tempDir } from './helpers.ts';

const T0 = Date.UTC(2026, 9, 7, 12, 0, 0); // 2026-10-07 12:00 UTC

const questions: LamaQuestion[] = [
  { id: 1, type: 'INPUT', question: { de: 'Vorname' }, groups: [{ inputType: 'SINGLELINE', varnames: ['V2'] }] },
  { id: 2, type: 'INPUT', question: { de: 'Nachname' }, groups: [{ inputType: 'SINGLELINE', varnames: ['V3'] }] },
  { id: 3, type: 'INPUT', question: { de: 'E-Mail' }, groups: [{ inputType: 'SINGLELINE', varnames: ['V76'] }] },
  { id: 4, type: 'CHOICE', question: { de: 'Zimmer' }, groups: [{ varnames: ['V60'], codes: ['1', '2'], labels: [{ de: 'Einzel' }, { de: 'Doppel' }] }] },
];

const row = (id: string, email: string, extra: CsvRow = {}): CsvRow => ({ vID: id, vCOMPLETED: '1', V2: 'Anna', V3: 'Müller', V76: email, V60: '2', ...extra });

function setup(opts: { enabled?: boolean; sendExisting?: boolean; dateFromFormat?: 'date' | 'datetime' } = {}) {
  const store = new Store(join(tempDir(), 't.db'));
  const settings = new Settings(store);
  settings.update({
    apiKey: 'k', pollId: 42, emailVar: 'V76', firstNameVar: 'V2', lastNameVar: 'V3', smtpHost: 'h', fromEmail: 'a@b.de', questions,
    enabled: opts.enabled ?? true, sendExisting: opts.sendExisting ?? false, dateFromFormat: opts.dateFromFormat ?? 'date',
  });
  const calls: { pollId: number; opts: ResultsOptions }[] = [];
  const state = { rows: [] as CsvRow[], error: null as Error | null, now: T0 };
  const source: ResultsSource = {
    async legacyResults(pollId, o) {
      calls.push({ pollId, opts: o });
      if (state.error) throw state.error;
      return state.rows;
    },
  };
  const poller = new Poller({ store, settings, createSource: () => source, now: () => state.now });
  return { store, settings, poller, calls, state };
}

test('does nothing while disabled or not fully configured', async () => {
  const off = setup({ enabled: false });
  assert.equal((await off.poller.pollOnce()).status, 'idle');
  assert.equal(off.calls.length, 0);

  const incomplete = setup();
  incomplete.settings.update({ emailVar: '' });
  assert.equal((await incomplete.poller.pollOnce()).status, 'idle');
  assert.equal(incomplete.calls.length, 0);
});

test('first poll fetches everything and does not mail signups that already exist', async () => {
  const t = setup();
  t.state.rows = [row('1', 'a@x.de'), row('2', 'b@x.de')];
  const res = await t.poller.pollOnce();
  assert.equal(res.status, 'ok');
  assert.equal(t.calls[0].opts.dateFrom, undefined);
  assert.deepEqual(t.store.list('', 10).map((r) => r.status), ['skipped', 'skipped']);
});

test('sendExisting queues signups found at the first poll', async () => {
  const t = setup({ sendExisting: true });
  t.state.rows = [row('1', 'a@x.de')];
  await t.poller.pollOnce();
  assert.equal(t.store.list('', 10)[0].status, 'pending');
});

test('later polls send a date-only dateFrom a day before the watermark (like the PHP reference)', async () => {
  const t = setup();
  await t.poller.pollOnce(); // first (empty) poll sets the watermark = T0
  t.state.now = T0 + 60_000;
  t.state.rows = [row('1', 'a@x.de')];
  await t.poller.pollOnce();
  assert.equal(t.calls[1].opts.dateFrom, '2026-10-06');
  assert.equal(t.calls[1].opts.lang, 'de');
  assert.equal(t.store.list('', 10)[0].status, 'pending');
  assert.equal(t.store.watermark(), T0 + 60_000);
});

test('datetime format sends an ISO timestamp minus the overlap', async () => {
  const t = setup({ dateFromFormat: 'datetime' });
  await t.poller.pollOnce();
  t.state.now = T0 + 60_000;
  await t.poller.pollOnce();
  assert.equal(t.calls[1].opts.dateFrom, new Date(T0 - 5 * 60_000).toISOString());
});

test('queued signups carry decoded answers, name parts and fields for the mail', async () => {
  const t = setup();
  await t.poller.pollOnce();
  t.state.now += 1000;
  t.state.rows = [row('7', 'anna@x.de')];
  await t.poller.pollOnce();
  const s = t.store.list('', 1)[0];
  assert.equal(s.key, 'id:7');
  assert.equal(s.email, 'anna@x.de');
  assert.equal(s.name, 'Anna Müller');
  assert.equal(s.fields.firstName, 'Anna');
  assert.equal(s.fields.fields?.V60, 'Doppel');
  assert.deepEqual(s.fields.answers?.map((a) => a.label), ['Vorname', 'Nachname', 'E-Mail', 'Zimmer']);
});

test('overlap rows are not queued twice; the same address with a new id is a new signup', async () => {
  const t = setup();
  await t.poller.pollOnce();
  t.state.now += 1000;
  t.state.rows = [row('1', 'a@x.de')];
  await t.poller.pollOnce();
  t.state.now += 1000;
  t.state.rows = [row('1', 'a@x.de'), row('2', 'a@x.de')];
  await t.poller.pollOnce();
  assert.equal(t.store.list('', 10).length, 2);
});

test('invalid email is recorded as failed; rows without id or not completed are ignored', async () => {
  const t = setup();
  await t.poller.pollOnce();
  t.state.now += 1000;
  t.state.rows = [row('1', 'nope'), row('2', ''), row('3', 'ok@x.de', { vCOMPLETED: '0' }), { ...row('4', 'z@x.de'), vID: '' }];
  await t.poller.pollOnce();
  const rows = t.store.list('', 10);
  assert.deepEqual(rows.map((r) => [r.key, r.status]), [['id:2', 'failed'], ['id:1', 'failed']]);
  assert.match(rows[0].error, /E-Mail/);
});

test('a failed fetch keeps the watermark and records the error for the dashboard', async () => {
  const t = setup();
  await t.poller.pollOnce();
  t.state.now += 1000;
  t.state.error = new Error('lamapoll down');
  const res = await t.poller.pollOnce();
  assert.equal(res.status, 'error');
  assert.equal(t.store.watermark(), T0);
  const last = JSON.parse(t.store.getKv('last_poll')!);
  assert.equal(last.ok, false);
  assert.match(last.error, /lamapoll down/);
  t.state.error = null;
  await t.poller.pollOnce();
  assert.equal(JSON.parse(t.store.getKv('last_poll')!).ok, true);
});

test('poll wait doubles per consecutive failure, capped at 5 minutes, never below the interval', () => {
  assert.deepEqual([0, 1, 2, 4, 50].map((f) => pollWaitMs(20_000, f)), [20_000, 40_000, 80_000, 300_000, 300_000]);
  assert.equal(pollWaitMs(600_000, 3), 600_000);
});
