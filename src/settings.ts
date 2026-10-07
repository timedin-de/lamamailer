// Every setting is edited in the admin UI and stored as one JSON document in the database.
import type { Store } from './store.ts';
import type { LamaQuestion } from './types.ts';
import { DEFAULT_BODY, DEFAULT_SUBJECT } from './template.ts';

export interface SettingsData {
  // LamaPoll
  apiKey: string;
  baseUrl: string;
  pollId: number | null;
  pollTitle: string;
  emailVar: string; // variable holding the e-mail address, e.g. "V76"
  firstNameVar: string;
  lastNameVar: string;
  lang: string; // language used for question texts and answer labels
  dateFromFormat: 'date' | 'datetime'; // how dateFrom is sent to the API (the PHP reference used a plain date)
  questions: LamaQuestion[]; // cached question definitions of the selected poll
  pollIntervalSec: number;
  // SMTP
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: 'starttls' | 'tls' | 'none';
  smtpUser: string;
  smtpPassword: string;
  fromEmail: string;
  fromName: string;
  replyTo: string;
  // Mail
  subject: string;
  body: string;
  siteUrl: string;
  // Sending
  ratePerSec: number;
  maxAttempts: number;
  perAddressCap: number; // max mails per address per hour, 0 = unlimited
  // Control
  enabled: boolean;
  sendExisting: boolean; // mail signups that already exist when the mailer is first activated
}

export const DEFAULTS: SettingsData = {
  apiKey: '', baseUrl: 'https://app.lamapoll.de/api/v2', pollId: null, pollTitle: '',
  emailVar: '', firstNameVar: '', lastNameVar: '', lang: 'de', dateFromFormat: 'date', questions: [], pollIntervalSec: 20,
  smtpHost: '', smtpPort: 587, smtpSecurity: 'starttls', smtpUser: '', smtpPassword: '', fromEmail: '', fromName: '', replyTo: '',
  subject: DEFAULT_SUBJECT, body: DEFAULT_BODY, siteUrl: '',
  ratePerSec: 5, maxAttempts: 5, perAddressCap: 5,
  enabled: false, sendExisting: false,
};

const KEY = 'settings';

export class Settings {
  #store: Store;
  constructor(store: Store) { this.#store = store; }

  get(): SettingsData {
    const raw = this.#store.getKv(KEY);
    return { ...DEFAULTS, ...(raw ? (JSON.parse(raw) as Partial<SettingsData>) : {}) };
  }

  update(patch: Partial<SettingsData>): SettingsData {
    const next = { ...this.get(), ...patch };
    this.#store.setKv(KEY, JSON.stringify(next));
    return next;
  }

  /** What still has to be configured before the mailer can be activated (German, shown in the UI). */
  missing(): string[] {
    const s = this.get();
    const out: string[] = [];
    if (!s.apiKey) out.push('LamaPoll API-Schlüssel');
    if (!s.pollId) out.push('Umfrage');
    if (!s.emailVar) out.push('E-Mail-Feld');
    if (!s.smtpHost) out.push('SMTP-Server');
    if (!s.fromEmail) out.push('Absender-Adresse');
    return out;
  }

  isReady(): boolean { return this.missing().length === 0; }
}

const mask = (v: string): string => (v === '' ? '' : v.length > 4 ? `••••${v.slice(-4)}` : '••••');

/** For display only: secrets are never sent back to the browser. */
export function maskSecrets(s: SettingsData): SettingsData {
  return { ...s, apiKey: mask(s.apiKey), smtpPassword: mask(s.smtpPassword) };
}
