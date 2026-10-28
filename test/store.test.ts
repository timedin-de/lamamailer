import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Store, type NewSignup } from '../src/store.ts';
import { tempDir } from './helpers.ts';

const T0 = 1_800_000_000_000;
const p = (key: string, email: string): NewSignup => ({ key, email, name: 'N', fields: { answers: [] }, status: 'pending' });

function open() {
  const path = join(tempDir(), 't.db');
  return { path, store: new Store(path) };
}
function seed(store: Store, ...emails: string[]) {
  store.addSignups(emails.map((e, i) => p(`id:${i + 1}`, e)), T0, T0);
}

test('kv values persist across reopen', () => {
  const { path, store } = open();
  assert.equal(store.getKv('k'), null);
  store.setKv('k', 'one'); store.setKv('k', 'two');
  store.close();
  const again = new Store(path);
  assert.equal(again.getKv('k'), 'two');
});

test('addSignups inserts, lists newest first and ignores known keys', () => {
  const { store } = open();
  assert.equal(store.addSignups([p('id:1', 'a@x.de'), p('id:2', 'b@x.de')], T0, T0), 2);
  assert.equal(store.addSignups([p('id:1', 'a@x.de'), p('id:3', 'c@x.de')], T0, T0), 1); // overlap re-poll
  assert.deepEqual(store.list('', 10).map((r) => r.key), ['id:3', 'id:2', 'id:1']);
});

test('the same email with different keys is two signups (one mail per submission)', () => {
  const { store } = open();
  assert.equal(store.addSignups([p('id:1', 'a@x.de'), p('id:2', 'a@x.de')], T0, T0), 2);
});

test('rows and watermark commit together; a bad row rolls everything back', () => {
  const { store } = open();
  assert.equal(store.watermark(), null);
  assert.equal(store.firstRunDone(), false);
  assert.throws(() => store.addSignups([p('id:1', 'a@x.de'), { ...p('id:2', 'b@x.de'), status: 'bogus' as never }], T0, T0));
  assert.equal(store.watermark(), null);
  assert.equal(store.list('', 10).length, 0);
  store.addSignups([], T0, T0);
  assert.equal(store.watermark(), T0);
  assert.equal(store.firstRunDone(), true);
});

test('stores structured fields and returns them parsed', () => {
  const { store } = open();
  store.addSignups([{ ...p('id:1', 'a@x.de'), fields: { answers: [{ label: 'q', value: 'a' }], fields: { V1: 'x' } } }], T0, T0);
  assert.deepEqual(store.list('', 1)[0].fields, { answers: [{ label: 'q', value: 'a' }], fields: { V1: 'x' } });
});

test('claim is FIFO, flips to sending and never hands a row out twice', () => {
  const { store } = open();
  assert.equal(store.claim(T0), null);
  seed(store, 'a@x.de', 'b@x.de');
  const first = store.claim(T0)!, second = store.claim(T0)!;
  assert.deepEqual([first.key, second.key], ['id:1', 'id:2']);
  assert.equal(store.claim(T0), null);
  assert.equal(first.status, 'sending');
  assert.equal(first.attempts, 1);
  assert.equal(first.sendingSince, T0);
});

test('claim ignores rows that are not due yet and non-pending rows', () => {
  const { store } = open();
  store.addSignups([{ ...p('id:s', 's@x.de'), status: 'skipped' }, p('id:1', 'a@x.de')], T0, T0);
  const row = store.claim(T0)!;
  assert.equal(row.key, 'id:1');
  store.markRetry(row.id, T0 + 60_000, 'smtp down');
  assert.equal(store.claim(T0 + 30_000), null);
  const again = store.claim(T0 + 60_000)!;
  assert.equal(again.attempts, 2);
  assert.equal(again.error, 'smtp down');
});

test('markSent / markFinal record the outcome', () => {
  const { store } = open();
  seed(store, 'a@x.de', 'b@x.de');
  const a = store.claim(T0)!, b = store.claim(T0)!;
  store.markSent(a.id, T0 + 1000);
  store.markFinal(b.id, 'failed', 'mailbox unknown');
  const rows = Object.fromEntries(store.list('', 10).map((r) => [r.key, r]));
  assert.equal(rows['id:1'].status, 'sent');
  assert.equal(rows['id:1'].sentAt, T0 + 1000);
  assert.equal(rows['id:2'].status, 'failed');
  assert.equal(rows['id:2'].error, 'mailbox unknown');
});

test('requeue resets failed rows but never touches sent ones', () => {
  const { store } = open();
  seed(store, 'a@x.de', 'b@x.de');
  const a = store.claim(T0)!, b = store.claim(T0)!;
  store.markSent(a.id, T0);
  store.markFinal(b.id, 'failed', 'boom');
  store.requeue(a.id); store.requeue(b.id);
  const rows = Object.fromEntries(store.list('', 10).map((r) => [r.key, r]));
  assert.equal(rows['id:1'].status, 'sent');
  assert.equal(rows['id:2'].status, 'pending');
  assert.equal(rows['id:2'].attempts, 0);
  assert.equal(rows['id:2'].error, '');
});

test('forceSent only works on rows stuck in sending', () => {
  const { store } = open();
  seed(store, 'a@x.de', 'b@x.de');
  const a = store.claim(T0)!;
  store.forceSent(a.id, T0);
  store.forceSent(store.list('pending', 5)[0].id, T0); // pending: ignored
  assert.equal(store.list('sent', 10).length, 1);
  assert.equal(store.list('sent', 10)[0].error, 'confirmed manually');
});

test('a row stuck in sending survives a restart and is NOT claimed again', () => {
  const { path, store } = open();
  seed(store, 'a@x.de');
  store.claim(T0); // crash while sending
  store.close();
  const again = new Store(path);
  assert.equal(again.claim(T0 + 3_600_000), null);
  const [row] = again.list('sending', 5);
  assert.equal(again.isStale(row, T0 + 3_600_000), true);
  assert.equal(again.isStale(row, T0 + 1000), false);
});

test('sentSince counts mails per address inside the window', () => {
  const { store } = open();
  seed(store, 'a@x.de', 'a@x.de', 'b@x.de');
  const one = store.claim(T0)!, two = store.claim(T0 + 600_000)!, other = store.claim(T0)!;
  store.markSent(one.id, T0); store.markSent(two.id, T0 + 600_000); store.markSent(other.id, T0);
  const now = T0 + 1_800_000;
  assert.equal(store.sentSince('a@x.de', now - 3_600_000), 2);
  assert.equal(store.sentSince('a@x.de', now - 1_500_000), 1);
  assert.equal(store.sentSince('nobody@x.de', now - 3_600_000), 0);
});

test('counts and status filter', () => {
  const { store } = open();
  store.addSignups([p('id:1', 'a@x.de'), { ...p('id:2', 'b@x.de'), status: 'skipped' }], T0, T0);
  assert.deepEqual(store.counts(), { pending: 1, skipped: 1 });
  assert.equal(store.list('skipped', 10)[0].key, 'id:2');
});

test('sessions are valid until they expire and can be deleted', () => {
  const { store } = open();
  store.createSession('tok', T0 + 1000);
  assert.equal(store.sessionValid('tok', T0), true);
  assert.equal(store.sessionValid('tok', T0 + 2000), false);
  assert.equal(store.sessionValid('nope', T0), false);
  store.createSession('tok2', T0 + 1000);
  store.deleteSession('tok2');
  assert.equal(store.sessionValid('tok2', T0), false);
});

test('clearPollData removes every signup and the per-poll state, but keeps settings and sessions', () => {
  const s = new Store(join(tempDir(), 't.db'));
  s.addSignups([p('id:1', 'a@x.de'), p('id:2', 'b@x.de')], 1000, 1000);
  for (const k of ['last_poll', 'activated', 'settings', 'admin_hash']) s.setKv(k, '1');
  s.createSession('tok', 5000);
  s.clearPollData();
  assert.deepEqual(s.list('', 10), []);
  assert.deepEqual(s.counts(), {});
  assert.deepEqual([s.watermark(), s.firstRunDone(), s.getKv('last_poll'), s.getKv('activated')], [null, false, null, null]);
  assert.deepEqual([s.getKv('settings'), s.getKv('admin_hash'), s.sessionValid('tok', 1000)], ['1', '1', true]);
});
