// Regularly asks LamaPoll for new completed submissions and puts them in the queue.
import type { Store, NewSignup } from '../core/store.ts';
import type { Settings, SettingsData } from '../core/settings.ts';
import type { ResultsOptions } from './client.ts';
import { LamaPollClient } from './client.ts';
import { buildQuestionMap, decodeAnswer, decodeRow } from './questions.ts';
import type { CsvRow } from '../core/types.ts';
import { sleep } from '../core/util.ts';

export interface ResultsSource { legacyResults(pollId: number, opts: ResultsOptions): Promise<CsvRow[]> }

export interface PollerDeps {
  store: Store;
  settings: Settings;
  createSource?: (s: SettingsData) => ResultsSource;
  now?: () => number;
}

export type PollResult = { status: 'idle' } | { status: 'ok'; added: number; fetched: number } | { status: 'error'; error: string };

const DAY_MS = 86_400_000;
const OVERLAP_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 5 * 60_000;

/** Waits the interval, doubled per consecutive failure up to 5 minutes (never below the interval). */
export function pollWaitMs(intervalMs: number, failures: number): number {
  return Math.max(intervalMs, Math.min(intervalMs * 2 ** failures, MAX_BACKOFF_MS));
}

const validEmail = (s: string): boolean => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s);

export class Poller {
  #d: Required<PollerDeps>;

  constructor(deps: PollerDeps) {
    this.#d = {
      now: Date.now,
      createSource: (s) => new LamaPollClient({ baseUrl: s.baseUrl, apiKey: s.apiKey }),
      ...deps,
    };
  }

  /** Polls until the signal is aborted. Settings are re-read every round, so UI changes apply live. */
  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      const res = await this.pollOnce();
      failures = res.status === 'error' ? failures + 1 : 0;
      await sleep(pollWaitMs(Math.max(5, this.#d.settings.get().pollIntervalSec) * 1000, failures), signal);
    }
  }

  async pollOnce(): Promise<PollResult> {
    const { store, settings } = this.#d;
    const s = settings.get();
    if (!s.enabled || !settings.isReady()) return { status: 'idle' };

    const started = this.#d.now();
    const wm = store.watermark();
    const firstRunDone = store.firstRunDone();

    // dateFrom: the PHP reference sent a plain date, so "date" mode goes one day back (covers time zones);
    // already known submissions are ignored by their unique key anyway.
    let dateFrom: string | undefined;
    if (wm !== null) dateFrom = s.dateFromFormat === 'date' ? new Date(wm - DAY_MS).toISOString().slice(0, 10) : new Date(wm - OVERLAP_MS).toISOString();

    let rows: CsvRow[];
    try {
      rows = await this.#d.createSource(s).legacyResults(s.pollId!, { dateFrom, lang: s.lang || undefined });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (settings.get().pollId === s.pollId) store.setKv('last_poll', JSON.stringify({ at: started, ok: false, error }));
      return { status: 'error', error };
    }
    // The admin may have switched the poll (or paused) while the request was running: drop the stale result.
    const current = settings.get();
    if (current.pollId !== s.pollId || !current.enabled) return { status: 'idle' };

    const map = buildQuestionMap(s.questions, s.lang || 'de');
    const items: NewSignup[] = [];
    for (const row of rows) {
      const id = (row.vID ?? '').trim();
      if (!id) continue;
      if ('vCOMPLETED' in row && row.vCOMPLETED !== '1') continue; // only finished signups

      const email = (row[s.emailVar] ?? '').trim();
      const { answers, fields } = decodeRow(row, map);
      const part = (v: string) => (v ? decodeAnswer(v, row[v], map) : '');
      const firstName = part(s.firstNameVar), lastName = part(s.lastNameVar);
      const item: NewSignup = {
        key: `id:${id}`, email, name: [firstName, lastName].filter(Boolean).join(' '),
        fields: { answers, fields, firstName, lastName }, status: 'pending',
      };
      if (!validEmail(email)) { item.status = 'failed'; item.error = 'ungültige oder fehlende E-Mail-Adresse'; }
      else if (!firstRunDone && !s.sendExisting) { item.status = 'skipped'; item.error = 'war schon vor dem ersten Start vorhanden'; }
      items.push(item);
    }

    const added = store.addSignups(items, started, started);
    store.setKv('last_poll', JSON.stringify({ at: started, ok: true, added, fetched: rows.length }));
    return { status: 'ok', added, fetched: rows.length };
  }
}
