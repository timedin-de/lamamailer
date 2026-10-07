// Server-rendered HTML pages (German UI). Every dynamic value goes through esc().
import type { Signup } from './store.ts';
import type { SettingsData } from './settings.ts';
import type { FieldChoice, LamaPoll } from './types.ts';

export const esc = (v: unknown): string =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const CSS = `
:root { --fg:#1b1f23; --muted:#59636e; --line:#d9dee3; --accent:#1d4ed8; --bad:#b00020; --warn:#fff3cd; --ok:#e6f4ea; }
* { box-sizing: border-box; }
body { font: 16px/1.5 system-ui, sans-serif; color: var(--fg); max-width: 64rem; margin: 0 auto; padding: 1rem; }
nav { display:flex; gap:1rem; align-items:center; flex-wrap:wrap; padding:.5rem 0 1rem; border-bottom:1px solid var(--line); margin-bottom:1.5rem; }
nav a { text-decoration:none; color: var(--accent); } nav a.cur { font-weight:700; } nav form { margin-left:auto; }
h1 { font-size:1.6rem; margin:.2rem 0 1rem; } h2 { font-size:1.2rem; margin:0 0 .6rem; }
.card { border:1px solid var(--line); border-radius:8px; padding:1rem 1.2rem; margin:0 0 1.2rem; }
.warn { background:var(--warn); padding:.6rem 1rem; border-radius:6px; } .ok { background:var(--ok); padding:.6rem 1rem; border-radius:6px; }
.err { color:var(--bad); } .muted { color:var(--muted); font-size:.9rem; }
label { display:block; margin:.6rem 0 .2rem; font-weight:600; }
input[type=text], input[type=password], input[type=email], input[type=number], input[type=url], select, textarea { width:100%; font:inherit; padding:.4rem .5rem; border:1px solid var(--line); border-radius:6px; }
textarea { min-height:16rem; font-family: ui-monospace, monospace; font-size:.85rem; }
button { font:inherit; padding:.4rem .9rem; border:1px solid var(--accent); background:var(--accent); color:#fff; border-radius:6px; cursor:pointer; }
button.secondary { background:#fff; color:var(--accent); } button.small { padding:.1rem .5rem; font-size:.85rem; }
.row { display:grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap:0 1rem; }
table { border-collapse:collapse; width:100%; font-size:.9rem; } th, td { text-align:left; padding:.35rem .5rem; border-bottom:1px solid var(--line); vertical-align:top; }
form.inline { display:inline; } code { background:#f3f4f6; padding:0 .25rem; border-radius:4px; } iframe { width:100%; height:26rem; border:1px solid var(--line); border-radius:6px; }
details { margin-top:.8rem; } summary { cursor:pointer; color:var(--accent); }
`;

type Nav = 'dashboard' | 'settings' | 'template' | 'account' | '';

export function layout(title: string, body: string, nav: Nav = ''): string {
  const link = (href: string, key: Nav, text: string) => `<a href="${href}"${nav === key ? ' class="cur"' : ''}>${text}</a>`;
  const menu = nav === '' ? '' : `<nav><strong>Anmelde-Mailer</strong>${link('/', 'dashboard', 'Übersicht')}${link('/settings', 'settings', 'Einstellungen')}${link('/template', 'template', 'Mail-Text')}${link('/account', 'account', 'Konto')}<form method="post" action="/logout"><button class="secondary small">Abmelden</button></form></nav>`;
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Anmelde-Mailer</title><style>${CSS}</style></head><body>${menu}${body}</body></html>`;
}

const msg = (notice?: string, error?: string) =>
  (notice ? `<p class="ok">${esc(notice)}</p>` : '') + (error ? `<p class="err"><strong>${esc(error)}</strong></p>` : '');

// ---------- setup / login ----------

export function setupPage(error?: string): string {
  return layout('Einrichtung', `<h1>Erster Start: Admin-Passwort festlegen</h1>
${msg('', error)}
<form method="post" action="/setup" class="card">
  <p class="muted">Den Setup-Code finden Sie im Server-Log (Zeile „Setup-Code“). Er schützt davor, dass jemand anderes das Passwort zuerst setzt.</p>
  <label>Setup-Code<input type="text" name="token" autocomplete="off" required></label>
  <label>Passwort (mindestens 8 Zeichen)<input type="password" name="password" autocomplete="new-password" required></label>
  <label>Passwort wiederholen<input type="password" name="password2" autocomplete="new-password" required></label>
  <p><button>Festlegen</button></p>
</form>`);
}

export function loginPage(error?: string): string {
  return layout('Anmelden', `<h1>Anmelde-Mailer</h1>${msg('', error)}
<form method="post" action="/login" class="card">
  <label>Passwort<input type="password" name="password" autofocus required></label>
  <p><button>Anmelden</button></p>
</form>`);
}

// ---------- dashboard ----------

export type DashState = 'unconfigured' | 'ready' | 'active' | 'paused';
export interface DashboardView {
  state: DashState;
  missing: string[];
  pollTitle: string;
  lastPoll: { at: number; ok: boolean; error?: string; added?: number; fetched?: number } | null;
  counts: Record<string, number>;
  rows: (Signup & { stale: boolean })[];
  filter: string;
  staleCount: number;
  error?: string;
}

const fmt = (ms: number) => (ms ? new Date(ms).toLocaleString('de-DE') : '–');

export function dashboardPage(v: DashboardView): string {
  const control = {
    unconfigured: `<p class="warn"><strong>Noch nicht eingerichtet.</strong> Es fehlt: ${v.missing.map(esc).join(', ')}. <a href="/settings">Zu den Einstellungen</a></p>`,
    ready: `<form method="post" action="/activate" class="card"><h2>Bereit zum Start</h2>
      <p>Umfrage: <strong>${esc(v.pollTitle)}</strong>. Was soll mit Anmeldungen passieren, die jetzt schon vorhanden sind?</p>
      <label><input type="radio" name="sendExisting" value="0" checked> Vorhandene Anmeldungen nicht mailen (empfohlen)</label>
      <label><input type="radio" name="sendExisting" value="1"> Auch vorhandene Anmeldungen anmailen</label>
      <p><button>Starten</button></p></form>`,
    active: `<div class="card"><h2>Aktiv</h2><p>Umfrage: <strong>${esc(v.pollTitle)}</strong>. Neue Anmeldungen werden automatisch bestätigt.</p>
      <form method="post" action="/pause"><button class="secondary">Versand pausieren</button></form></div>`,
    paused: `<div class="card warn"><h2>Pausiert</h2><p>Es wird nichts abgefragt oder gesendet. Anmeldungen aus der Pause werden nach dem Fortsetzen nachgeholt.</p>
      <form method="post" action="/resume"><button>Fortsetzen</button></form></div>`,
  }[v.state];

  const last = v.lastPoll
    ? `<p class="muted">Letzte Abfrage: ${fmt(v.lastPoll.at)} – ${v.lastPoll.ok ? `ok (${v.lastPoll.fetched ?? 0} Einträge, ${v.lastPoll.added ?? 0} neu)` : `<span class="err">Fehler: ${esc(v.lastPoll.error)}</span>`}</p>`
    : '<p class="muted">Noch keine Abfrage.</p>';

  const stale = v.staleCount > 0
    ? `<p class="warn"><strong>${v.staleCount} Eintrag/Einträge hängen im Status „sending“.</strong> Der Server wurde vermutlich mitten im Versand beendet. Schauen Sie im SMTP-Log/Postfach nach, ob die Mail raus ging: „Bestätigen“ = wurde gesendet, „Erneut“ = nochmal senden.</p>` : '';

  const counts = Object.entries(v.counts).map(([s, n]) => `<a href="/?status=${esc(s)}">${esc(s)}: ${n}</a>`).join(' &nbsp; ');
  const rows = v.rows.map((r) => `<tr><td>${r.id}</td><td>${fmt(r.createdAt)}</td><td>${esc(r.email)}</td><td>${esc(r.name)}</td>
    <td>${esc(r.status)}${r.stale ? ' <strong class="err">Prüfen</strong>' : ''}</td><td>${r.attempts}</td><td class="err">${esc(r.error)}</td>
    <td>${r.stale ? `<form class="inline" method="post" action="/confirm/${r.id}"><button class="small secondary">Bestätigen</button></form> ` : ''}${r.stale || r.status === 'failed' || r.status === 'skipped' ? `<form class="inline" method="post" action="/retry/${r.id}"><button class="small secondary">Erneut</button></form>` : ''}</td></tr>`).join('');

  return layout('Übersicht', `<h1>Übersicht</h1>${msg('', v.error)}${control}${last}${stale}
<p>${counts || 'Noch keine Anmeldungen.'}${v.filter ? ' &nbsp; <a href="/">alle anzeigen</a>' : ''}</p>
<table><tr><th>#</th><th>Zeit</th><th>E-Mail</th><th>Name</th><th>Status</th><th>Versuche</th><th>Fehler</th><th></th></tr>${rows || '<tr><td colspan="8">Keine Einträge.</td></tr>'}</table>`, 'dashboard');
}

// ---------- settings ----------

export interface SettingsView {
  s: SettingsData; // secrets already masked
  polls: LamaPoll[] | null;
  pollsError?: string;
  choices: FieldChoice[];
  notice?: string;
  error?: string;
}

const NOTICES: Record<string, string> = {
  key: 'API-Schlüssel gespeichert.', poll: 'Umfrage übernommen.', fields: 'Felder gespeichert.', refresh: 'Fragen neu geladen.',
  advanced: 'Erweiterte Einstellungen gespeichert.', smtp: 'SMTP-Einstellungen gespeichert.', sending: 'Versand-Regeln gespeichert.', saved: 'Gespeichert.', password: 'Passwort geändert.',
};
export const noticeFor = (key: unknown): string | undefined => (typeof key === 'string' ? NOTICES[key] : undefined);

const opt = (value: string, label: string, selected: boolean) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;

export function settingsPage(v: SettingsView): string {
  const { s } = v;
  const fieldOptions = (current: string, optional: boolean) =>
    (optional ? opt('', '— keines —', current === '') : '') + v.choices.map((c) => opt(c.varname, `${c.label} · ${c.varname}`, c.varname === current)).join('');

  const connect = `<div class="card"><h2>1 · LamaPoll verbinden</h2>
  <form method="post" action="/settings/lamapoll/key">
    <label>API-Schlüssel${s.apiKey ? ` <span class="muted">(gespeichert: ${esc(s.apiKey)})</span>` : ''}
      <input type="password" name="apiKey" autocomplete="off" placeholder="${s.apiKey ? 'Neuen Schlüssel eingeben zum Ersetzen' : 'Schlüssel aus Ihrem LamaPoll-Profil (API)'}" required></label>
    <p><button>${s.apiKey ? 'Ersetzen' : 'Verbinden'}</button></p>
  </form>
  ${s.apiKey ? `<form method="post" action="/settings/lamapoll/poll">
    <label>Umfrage (Formular)</label>
    ${v.polls ? `<select name="pollId">${opt('', '— bitte wählen —', !s.pollId)}${v.polls.map((p) => opt(String(p.id), `${p.title} (#${p.id})`, p.id === s.pollId)).join('')}</select>` : `<p class="err">Umfragen konnten nicht geladen werden: ${esc(v.pollsError)}</p>`}
    <p><button>Umfrage übernehmen</button></p>
  </form>` : ''}
  ${s.pollId ? `<form method="post" action="/settings/lamapoll/fields">
    <div class="row">
      <div><label>E-Mail-Feld (Pflicht)</label><select name="emailVar">${fieldOptions(s.emailVar, false)}</select></div>
      <div><label>Vorname-Feld (optional)</label><select name="firstNameVar">${fieldOptions(s.firstNameVar, true)}</select></div>
      <div><label>Nachname-Feld (optional)</label><select name="lastNameVar">${fieldOptions(s.lastNameVar, true)}</select></div>
    </div>
    <p class="muted">Zur Auswahl stehen die Textfelder der Umfrage (${v.choices.length}). Der Name wird für die Anrede genutzt.</p>
    <p><button>Felder speichern</button></p>
  </form>
  <form method="post" action="/settings/lamapoll/refresh"><button class="secondary small">Fragen neu laden</button> <span class="muted">falls das Formular geändert wurde</span></form>` : ''}
  <details><summary>Erweitert</summary>
  <form method="post" action="/settings/advanced"><div class="row">
    <div><label>API-Adresse</label><input type="url" name="baseUrl" value="${esc(s.baseUrl)}" required></div>
    <div><label>Sprache der Fragetexte</label><input type="text" name="lang" value="${esc(s.lang)}" maxlength="2" pattern="[a-z]{2}"></div>
    <div><label>Datumsformat für „dateFrom“</label><select name="dateFromFormat">${opt('date', 'Nur Datum (wie im PHP-Skript)', s.dateFromFormat === 'date')}${opt('datetime', 'Datum und Uhrzeit', s.dateFromFormat === 'datetime')}</select></div>
    <div><label>Abfrage-Intervall (Sekunden)</label><input type="number" name="pollIntervalSec" min="5" max="3600" value="${s.pollIntervalSec}"></div>
  </div><p><button class="secondary">Speichern</button></p></form></details></div>`;

  const smtp = `<div class="card"><h2>2 · E-Mail-Versand (SMTP)</h2>
  <form method="post" action="/settings/smtp">
    <div class="row">
      <div><label>SMTP-Server</label><input type="text" name="smtpHost" value="${esc(s.smtpHost)}" required></div>
      <div><label>Port</label><input type="number" name="smtpPort" value="${s.smtpPort}" min="1" max="65535" required></div>
      <div><label>Verschlüsselung</label><select name="smtpSecurity">${opt('starttls', 'STARTTLS (Port 587)', s.smtpSecurity === 'starttls')}${opt('tls', 'TLS (Port 465)', s.smtpSecurity === 'tls')}${opt('none', 'Keine (nur lokal)', s.smtpSecurity === 'none')}</select></div>
      <div><label>Benutzer</label><input type="text" name="smtpUser" value="${esc(s.smtpUser)}" autocomplete="off"></div>
      <div><label>Passwort ${s.smtpPassword ? '<span class="muted">(gespeichert; leer lassen = behalten)</span>' : ''}</label><input type="password" name="smtpPassword" autocomplete="new-password"></div>
    </div>
    <div class="row">
      <div><label>Absender-Adresse</label><input type="email" name="fromEmail" value="${esc(s.fromEmail)}" required></div>
      <div><label>Absender-Name</label><input type="text" name="fromName" value="${esc(s.fromName)}"></div>
      <div><label>Antwort an (optional)</label><input type="email" name="replyTo" value="${esc(s.replyTo)}"></div>
    </div>
    <p><button>Speichern</button></p>
  </form>
  <form method="post" action="/settings/smtp/verify"><button class="secondary">Verbindung testen</button></form></div>`;

  const sending = `<div class="card"><h2>3 · Versand-Regeln</h2>
  <form method="post" action="/settings/sending"><div class="row">
    <div><label>Mails pro Sekunde (max.)</label><input type="number" name="ratePerSec" step="0.1" min="0.1" max="50" value="${s.ratePerSec}"></div>
    <div><label>Versuche pro Mail</label><input type="number" name="maxAttempts" min="1" max="20" value="${s.maxAttempts}"></div>
    <div><label>Max. Mails pro Adresse und Stunde (0 = unbegrenzt)</label><input type="number" name="perAddressCap" min="0" max="1000" value="${s.perAddressCap}"></div>
    <div><label>Website-URL (Platzhalter <code>{site_url}</code>)</label><input type="url" name="siteUrl" value="${esc(s.siteUrl)}"></div>
  </div><p><button>Speichern</button></p></form></div>`;

  return layout('Einstellungen', `<h1>Einstellungen</h1>${msg(v.notice, v.error)}${connect}${smtp}${sending}`, 'settings');
}

// ---------- template ----------

export interface TemplateView {
  subject: string;
  body: string;
  notice?: string;
  error?: string;
  preview?: { subject: string; html: string; text: string; unknown: string[] };
}

export function templatePage(v: TemplateView): string {
  const preview = v.preview ? `<div class="card"><h2>Vorschau</h2>
    ${v.preview.unknown.length ? `<p class="warn">Unbekannte Platzhalter: ${v.preview.unknown.map((u) => esc(`{${u}}`)).join(', ')}</p>` : ''}
    <p><strong>Betreff:</strong> ${esc(v.preview.subject)}</p>
    <iframe sandbox="" srcdoc="${esc(v.preview.html)}" title="Vorschau"></iframe>
    <details><summary>Text-Version</summary><pre>${esc(v.preview.text)}</pre></details></div>` : '';
  return layout('Mail-Text', `<h1>Mail-Text</h1>${msg(v.notice, v.error)}
<form method="post" action="/template" class="card">
  <p class="muted">Platzhalter: <code>{name}</code> <code>{first_name}</code> <code>{last_name}</code> <code>{email}</code> <code>{site_url}</code>
  <code>{answers}</code> (Tabelle aller Antworten) <code>{field:V60}</code> (einzelne Antwort nach Variablenname). Der Text darf HTML enthalten.</p>
  <label>Betreff<input type="text" name="subject" value="${esc(v.subject)}" required></label>
  <label>Text (HTML)<textarea name="body">${esc(v.body)}</textarea></label>
  <p><button>Speichern</button> <button class="secondary" formaction="/template/preview">Vorschau</button></p>
  <label>Test-Mail an <input type="email" name="to" placeholder="ich@example.org"></label>
  <p><button class="secondary" formaction="/template/test">Test-Mail senden</button></p>
</form>${preview}`, 'template');
}

// ---------- account ----------

export function accountPage(notice?: string, error?: string): string {
  return layout('Konto', `<h1>Konto</h1>${msg(notice, error)}
<form method="post" action="/account/password" class="card"><h2>Passwort ändern</h2>
  <label>Aktuelles Passwort<input type="password" name="current" autocomplete="current-password" required></label>
  <label>Neues Passwort (mindestens 8 Zeichen)<input type="password" name="next" autocomplete="new-password" required></label>
  <label>Neues Passwort wiederholen<input type="password" name="next2" autocomplete="new-password" required></label>
  <p><button>Ändern</button></p><p class="muted">Andere angemeldete Geräte werden abgemeldet.</p>
</form>`, 'account');
}
