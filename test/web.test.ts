import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, startApp, PASSWORD, SETUP_TOKEN } from './web-helpers.ts';

// ---------- first-run setup, login, sessions ----------

test('before setup every page redirects to /setup; setup needs the code from the server log', async () => {
  const t = await startApp({ setup: false });
  assert.equal((await t.browser.get('/')).location, '/setup');
  assert.equal((await t.browser.get('/login')).location, '/setup');
  assert.equal((await t.browser.get('/setup')).status, 200);

  const wrongCode = await t.browser.post('/setup', { token: 'nope', password: PASSWORD, password2: PASSWORD });
  assert.equal(wrongCode.status, 403);
  assert.match(wrongCode.html, /Falscher Setup-Code/);
  const short = await t.browser.post('/setup', { token: SETUP_TOKEN, password: 'short', password2: 'short' });
  assert.equal(short.status, 422);
  assert.match(short.html, /mindestens 8 Zeichen/);
  const mismatch = await t.browser.post('/setup', { token: SETUP_TOKEN, password: PASSWORD, password2: PASSWORD + 'x' });
  assert.equal(mismatch.status, 422);

  const ok = await t.browser.post('/setup', { token: SETUP_TOKEN, password: PASSWORD, password2: PASSWORD });
  assert.equal(ok.status, 303);
  assert.equal(ok.location, '/');
  assert.equal((await t.browser.get('/')).status, 200); // logged in right away
  assert.equal((await new Browser(t.base).post('/setup', { token: SETUP_TOKEN, password: 'another-password', password2: 'another-password' })).status, 404); // setup is one-time
});

test('protected pages redirect to the login; wrong password is refused; right one sets a hardened cookie', async () => {
  const t = await startApp();
  const anon = new Browser(t.base);
  for (const path of ['/', '/settings', '/template', '/account']) assert.equal((await anon.get(path)).location, '/login');
  assert.equal((await anon.post('/pause')).location, '/login');

  const bad = await anon.post('/login', { password: 'wrong' });
  assert.equal(bad.status, 401);
  assert.match(bad.html, /Falsches Passwort/);
  assert.equal(bad.setCookie, '');

  const ok = await anon.post('/login', { password: PASSWORD });
  assert.equal(ok.status, 303);
  assert.match(ok.setCookie, /HttpOnly/i);
  assert.match(ok.setCookie, /SameSite=Strict/i);
  assert.equal((await anon.get('/')).status, 200);
});

test('the stylesheet is a separate file, reachable before setup and without a session', async () => {
  const t = await startApp({ setup: false });
  const css = await t.browser.get('/static/style.css');
  assert.equal(css.status, 200);
  assert.match(css.res.headers.get('content-type') ?? '', /text\/css/);
  assert.match(css.html, /\.card\s*\{/);
  const page = await t.browser.get('/setup');
  assert.match(page.html, /<link rel="stylesheet" href="\/static\/style\.css">/);
  assert.doesNotMatch(page.html, /<style>/);
  assert.equal((await t.browser.get('/static/nope.css')).status, 404);
});

test('logout and expiry end the session', async () => {
  const t = await startApp();
  await t.browser.post('/logout');
  assert.equal((await t.browser.get('/')).location, '/login');

  await t.browser.post('/login', { password: PASSWORD });
  assert.equal((await t.browser.get('/')).status, 200);
  t.clock.now += 13 * 3600_000;
  assert.equal((await t.browser.get('/')).location, '/login');
});

test('cross-site POSTs are refused', async () => {
  const t = await startApp();
  assert.equal((await t.browser.post('/pause', {}, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await t.browser.post('/pause', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal(t.settings.get().enabled, false);
});

// ---------- guided LamaPoll setup: key -> poll -> email field ----------

test('settings: an invalid API key is rejected and not saved', async () => {
  const t = await startApp();
  t.api.failKey = true;
  const res = await t.browser.post('/settings/lamapoll/key', { apiKey: 'bad-key' });
  assert.equal(res.status, 422);
  assert.match(res.html, /API-Schlüssel ungültig/);
  assert.equal(t.settings.get().apiKey, '');
});

test('settings: key -> poll list -> poll choice loads questions and preselects the e-mail field', async () => {
  const t = await startApp();
  const saved = await t.browser.post('/settings/lamapoll/key', { apiKey: 'sekret-key-9876' });
  assert.equal(saved.status, 303);
  assert.equal(t.settings.get().apiKey, 'sekret-key-9876');

  const page = await t.browser.get('/settings');
  assert.doesNotMatch(page.html, /sekret-key-9876/); // never shown again, only masked
  assert.match(page.html, /••••9876/);
  assert.match(page.html, /Sommertreffen 2026/);
  assert.match(page.html, /Workshop/);
  assert.doesNotMatch(page.html, /Öffentlicher Titel/); // the poll's name is shown, never its title

  await t.browser.post('/settings/lamapoll/poll', { pollId: '42' });
  const s = t.settings.get();
  assert.deepEqual([s.pollId, s.pollTitle, s.questions.length], [42, 'Sommertreffen 2026', 5]);
  assert.equal(s.emailVar, 'V76'); // guessed: the question called "E-Mail"
  assert.equal(s.firstNameVar, 'V2');
  assert.equal(s.lastNameVar, 'V3');

  const fields = await t.browser.get('/settings');
  assert.match(fields.html, /E-Mail · V76/);
  assert.match(fields.html, /Handynummer · V71/);
  assert.doesNotMatch(fields.html, /Zimmer · V60/); // choice questions are not text fields
});

test('settings: the user can change the e-mail and name fields; unknown fields are refused', async () => {
  const t = await startApp();
  await t.browser.post('/settings/lamapoll/key', { apiKey: 'k' });
  await t.browser.post('/settings/lamapoll/poll', { pollId: '42' });

  const ok = await t.browser.post('/settings/lamapoll/fields', { emailVar: 'V71', firstNameVar: '', lastNameVar: 'V3' });
  assert.equal(ok.status, 303);
  assert.deepEqual([t.settings.get().emailVar, t.settings.get().firstNameVar, t.settings.get().lastNameVar], ['V71', '', 'V3']);

  const bad = await t.browser.post('/settings/lamapoll/fields', { emailVar: 'V60', firstNameVar: '', lastNameVar: '' });
  assert.equal(bad.status, 422);
  assert.equal(t.settings.get().emailVar, 'V71');
  assert.equal((await t.browser.post('/settings/lamapoll/poll', { pollId: '999' })).status, 422); // not in the list
});

test('settings: reloading questions refreshes the cache', async () => {
  const t = await startApp();
  await t.browser.post('/settings/lamapoll/key', { apiKey: 'k' });
  await t.browser.post('/settings/lamapoll/poll', { pollId: '42' });
  t.settings.update({ questions: [] });
  assert.equal((await t.browser.post('/settings/lamapoll/refresh')).status, 303);
  assert.equal(t.settings.get().questions.length, 5);
});

test('settings: advanced options are validated', async () => {
  const t = await startApp();
  assert.equal((await t.browser.post('/settings/advanced', { baseUrl: 'https://app.lamapoll.de/api/v2/', lang: 'de', dateFromFormat: 'datetime', pollIntervalSec: '30' })).status, 303);
  const s = t.settings.get();
  assert.deepEqual([s.baseUrl, s.dateFromFormat, s.pollIntervalSec], ['https://app.lamapoll.de/api/v2', 'datetime', 30]);
  assert.equal((await t.browser.post('/settings/advanced', { baseUrl: 'ftp://x', lang: 'de', dateFromFormat: 'date', pollIntervalSec: '30' })).status, 422);
  assert.equal((await t.browser.post('/settings/advanced', { baseUrl: 'https://x.de', lang: 'de', dateFromFormat: 'date', pollIntervalSec: '1' })).status, 422);
});

// ---------- SMTP and sending rules ----------

const smtp = { smtpHost: 'smtp.example.org', smtpPort: '465', smtpSecurity: 'tls', smtpUser: 'user', smtpPassword: 'pw1', fromEmail: 'events@example.org', fromName: 'Event Team', replyTo: '' };

test('smtp: saves settings; an empty password keeps the old one; the page never shows it', async () => {
  const t = await startApp();
  assert.equal((await t.browser.post('/settings/smtp', smtp)).status, 303);
  assert.deepEqual([t.settings.get().smtpHost, t.settings.get().smtpPort, t.settings.get().smtpSecurity, t.settings.get().smtpPassword], ['smtp.example.org', 465, 'tls', 'pw1']);
  await t.browser.post('/settings/smtp', { ...smtp, smtpPassword: '', fromName: 'Neu' });
  assert.equal(t.settings.get().smtpPassword, 'pw1');
  assert.equal(t.settings.get().fromName, 'Neu');
  assert.doesNotMatch((await t.browser.get('/settings')).html, /pw1/);
});

test('smtp: invalid input is refused', async () => {
  const t = await startApp();
  assert.equal((await t.browser.post('/settings/smtp', { ...smtp, smtpPort: 'abc' })).status, 422);
  assert.equal((await t.browser.post('/settings/smtp', { ...smtp, smtpSecurity: 'rot13' })).status, 422);
  assert.equal((await t.browser.post('/settings/smtp', { ...smtp, fromEmail: 'nope' })).status, 422);
  assert.equal(t.settings.get().smtpHost, '');
});

test('smtp: connection test reports success and failure', async () => {
  const t = await startApp();
  await t.browser.post('/settings/smtp', smtp);
  assert.match((await t.browser.post('/settings/smtp/verify')).html, /Verbindung erfolgreich/);
  t.mailer.verifyError = new Error('535 Authentication failed');
  const failed = await t.browser.post('/settings/smtp/verify');
  assert.equal(failed.status, 502);
  assert.match(failed.html, /535 Authentication failed/);
});

test('sending rules are validated and saved', async () => {
  const t = await startApp();
  assert.equal((await t.browser.post('/settings/sending', { ratePerSec: '2', maxAttempts: '4', perAddressCap: '0', siteUrl: 'https://example.org' })).status, 303);
  const s = t.settings.get();
  assert.deepEqual([s.ratePerSec, s.maxAttempts, s.perAddressCap, s.siteUrl], [2, 4, 0, 'https://example.org']);
  assert.equal((await t.browser.post('/settings/sending', { ratePerSec: '0', maxAttempts: '4', perAddressCap: '0', siteUrl: '' })).status, 422);
});

// ---------- dashboard: activation, queue ----------

function configure(t: Awaited<ReturnType<typeof startApp>>) {
  t.settings.update({ apiKey: 'k', pollId: 42, pollTitle: 'Sommertreffen 2026', emailVar: 'V76', smtpHost: 'h', fromEmail: 'a@b.de' });
}

test('dashboard tells what is missing before the mailer can start', async () => {
  const t = await startApp();
  const page = await t.browser.get('/');
  assert.match(page.html, /Noch nicht eingerichtet/);
  assert.match(page.html, /LamaPoll API-Schlüssel/);
  assert.equal((await t.browser.post('/activate', { sendExisting: '0' })).status, 422); // cannot activate yet
  assert.equal(t.settings.get().enabled, false);
});

test('activation is explicit and asks what to do with signups that already exist', async () => {
  const t = await startApp();
  configure(t);
  const ready = await t.browser.get('/');
  assert.match(ready.html, /Bereit zum Start/);
  assert.match(ready.html, /nicht mailen/);

  assert.equal((await t.browser.post('/activate', { sendExisting: '1' })).status, 303);
  assert.deepEqual([t.settings.get().enabled, t.settings.get().sendExisting], [true, true]);
  assert.match((await t.browser.get('/')).html, /Aktiv/);
});

test('pause and resume', async () => {
  const t = await startApp();
  configure(t);
  await t.browser.post('/activate', { sendExisting: '0' });
  await t.browser.post('/pause');
  assert.equal(t.settings.get().enabled, false);
  assert.match((await t.browser.get('/')).html, /Pausiert/);
  await t.browser.post('/resume');
  assert.equal(t.settings.get().enabled, true);
});

test('switching to another poll deletes all queue data and asks again about existing signups', async () => {
  const t = await startApp();
  await t.browser.post('/settings/lamapoll/key', { apiKey: 'k' });
  await t.browser.post('/settings/lamapoll/poll', { pollId: '42' });
  t.settings.update({ smtpHost: 'h', fromEmail: 'a@b.de' });
  await t.browser.post('/activate', { sendExisting: '1' });
  t.store.addSignups([{ key: 'id:1', email: 'a@x.de', name: '', fields: {}, status: 'pending' }], t.clock.now, t.clock.now);
  t.store.setKv('last_poll', JSON.stringify({ at: t.clock.now, ok: true, added: 1, fetched: 1 }));

  await t.browser.post('/settings/lamapoll/poll', { pollId: '42' }); // same poll again: nothing is lost
  assert.equal(t.store.list('', 10).length, 1);
  assert.equal(t.settings.get().enabled, true);

  assert.equal((await t.browser.post('/settings/lamapoll/poll', { pollId: '43' })).status, 303);
  assert.deepEqual(t.store.list('', 10), []);
  assert.deepEqual([t.store.watermark(), t.store.firstRunDone(), t.store.getKv('last_poll')], [null, false, null]);
  const s = t.settings.get();
  assert.deepEqual([s.pollId, s.pollTitle, s.enabled, s.sendExisting], [43, 'Workshop', false, false]);
  const dash = await t.browser.get('/');
  assert.match(dash.html, /Bereit zum Start/); // the "existing signups" question is asked again
  assert.match(dash.html, /Workshop/);
});

test('dashboard shows last poll result, counts and queue rows (escaped)', async () => {
  const t = await startApp();
  configure(t);
  t.store.setKv('last_poll', JSON.stringify({ at: t.clock.now, ok: false, error: 'LamaPoll nicht erreichbar' }));
  t.store.addSignups([
    { key: 'id:1', email: 'anna@example.org', name: 'Anna', fields: {}, status: 'pending' },
    { key: 'id:2', email: '<script>x</script>@example.org', name: '', fields: {}, status: 'failed', error: 'kaputt' },
  ], t.clock.now, t.clock.now);
  const page = await t.browser.get('/');
  assert.match(page.html, /LamaPoll nicht erreichbar/);
  assert.match(page.html, /anna@example\.org/);
  assert.doesNotMatch(page.html, /<script>x/);
  assert.match(page.html, /failed: 1/);
});

test('stuck "sending" rows are flagged and can be confirmed or retried; sent rows cannot be requeued', async () => {
  const t = await startApp();
  configure(t);
  t.store.addSignups([{ key: 'id:1', email: 'a@x.de', name: '', fields: {}, status: 'pending' }, { key: 'id:2', email: 'b@x.de', name: '', fields: {}, status: 'pending' }], t.clock.now, t.clock.now);
  const stuck = t.store.claim(t.clock.now)!;
  const sent = t.store.claim(t.clock.now)!;
  t.store.markSent(sent.id, t.clock.now);

  assert.doesNotMatch((await t.browser.get('/')).html, /Prüfen/);
  t.clock.now += 10 * 60_000;
  assert.match((await t.browser.get('/')).html, /Prüfen/);

  await t.browser.post(`/retry/${sent.id}`);
  assert.equal(t.store.list('sent', 5).length, 1);
  await t.browser.post(`/confirm/${stuck.id}`);
  assert.equal(t.store.list('sent', 5).length, 2);
  assert.equal((await t.browser.post('/retry/abc')).status, 400);
});

// ---------- mail template ----------

test('template page shows defaults and placeholder help; saving persists', async () => {
  const t = await startApp();
  const page = await t.browser.get('/template');
  assert.match(page.html, /Deine Anmeldung ist eingegangen/);
  assert.match(page.html, /\{answers\}/);

  assert.equal((await t.browser.post('/template', { subject: 'Hallo {first_name}', body: '<p>{name}</p>' })).status, 303);
  assert.deepEqual([t.settings.get().subject, t.settings.get().body], ['Hallo {first_name}', '<p>{name}</p>']);
  assert.equal((await t.browser.post('/template', { subject: '  ', body: 'x' })).status, 422);
  assert.equal(t.settings.get().subject, 'Hallo {first_name}');
});

test('preview renders sample data, warns about unknown placeholders and does not save', async () => {
  const t = await startApp();
  const res = await t.browser.post('/template/preview', { subject: 'Hi {name}', body: '<p>{signup_type}</p>{answers}' });
  assert.equal(res.status, 200);
  assert.match(res.html, /Hi Max Mustermann/);
  assert.match(res.html, /Unbekannte Platzhalter: \{signup_type\}/);
  assert.match(res.html, /Hotelzimmer/);
  assert.equal(t.settings.get().subject, 'Deine Anmeldung ist eingegangen');
});

test('test mail goes through the configured mailer', async () => {
  const t = await startApp();
  const res = await t.browser.post('/template/test', { subject: 'Betreff {name}', body: '<p>Body</p>', to: 'me@example.org' });
  assert.equal(res.status, 200);
  assert.match(res.html, /Test-Mail an me@example\.org gesendet/);
  assert.deepEqual([t.mailer.sent[0].to, t.mailer.sent[0].subject], ['me@example.org', 'Betreff Max Mustermann']);

  assert.equal((await t.browser.post('/template/test', { subject: 's', body: 'b', to: 'nope' })).status, 400);
  t.mailer.sendError = new Error('relay denied');
  const failed = await t.browser.post('/template/test', { subject: 's', body: 'b', to: 'me@example.org' });
  assert.equal(failed.status, 502);
  assert.match(failed.html, /relay denied/);
});

// ---------- account ----------

test('changing the password needs the current one and logs out other sessions', async () => {
  const t = await startApp();
  const other = new Browser(t.base);
  await other.post('/login', { password: PASSWORD });

  assert.equal((await t.browser.post('/account/password', { current: 'wrong', next: 'a-new-password', next2: 'a-new-password' })).status, 422);
  assert.equal((await t.browser.post('/account/password', { current: PASSWORD, next: 'short', next2: 'short' })).status, 422);
  assert.equal((await t.browser.post('/account/password', { current: PASSWORD, next: 'a-new-password', next2: 'a-new-password' })).status, 303);

  assert.equal((await t.browser.get('/')).status, 200); // this session stays
  assert.equal((await other.get('/')).location, '/login'); // others are gone
  assert.equal((await new Browser(t.base).post('/login', { password: PASSWORD })).status, 401);
  assert.equal((await new Browser(t.base).post('/login', { password: 'a-new-password' })).status, 303);
});
