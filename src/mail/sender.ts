// Works through the queue: claim a row, render the mail, send it, record the outcome.
import type { Store, Signup } from "../core/store.ts";
import type { Settings } from "../core/settings.ts";
import type { Mailer } from "./mailer.ts";
import { renderMail, type MailContext } from "./template.ts";
import { sleep } from "../core/util.ts";

export interface SenderDeps {
  store: Store;
  settings: Settings;
  getMailer: () => Mailer; // resolved per mail, so SMTP changes in the UI apply immediately
  now?: () => number;
}

/** 30s, 1m, 2m, 4m, ... capped at 30 minutes. */
export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 30 * 60_000);
}

export function contextOf(s: Signup, siteUrl: string): MailContext {
  return {
    name: s.name,
    email: s.email,
    siteUrl,
    firstName: s.fields.firstName ?? "",
    lastName: s.fields.lastName ?? "",
    answers: s.fields.answers ?? [],
    fields: s.fields.fields ?? {},
  };
}

export class Sender {
  #d: Required<SenderDeps>;
  // A failure is usually the server (rate limit, outage), not the row: pause the whole queue instead
  // of hammering it with the next rows. In memory only; after a restart the first failure pauses again.
  #failStreak = 0;
  #pausedUntil = 0;
  constructor(deps: SenderDeps) {
    this.#d = { now: Date.now, ...deps };
  }

  /** Sends until the signal is aborted. Waits 1/ratePerSec between mails, 1s when idle. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let did = false;
      try {
        did = await this.sendNext();
      } catch (err) {
        console.error("sender error:", err);
      }
      const rate = Math.max(0.1, this.#d.settings.get().ratePerSec);
      await sleep(did ? 1000 / rate : 1000, signal);
    }
  }

  /** Handles one due row. Returns false if there was nothing to do. */
  async sendNext(): Promise<boolean> {
    const { store, settings } = this.#d;
    const s = settings.get();
    if (!s.enabled) return false;

    const now = this.#d.now();
    if (now < this.#pausedUntil) return false;
    const row = store.claim(now); // the row is now "sending"
    if (!row) return false;

    if (s.perAddressCap > 0) {
      // The claimed row itself counts as one, hence ">" and not ">=".
      if (store.sentSince(row.email, now - 3_600_000) > s.perAddressCap) {
        store.markFinal(
          row.id,
          "skipped",
          `mehr als ${s.perAddressCap} Mails/Stunde an diese Adresse`,
        );
        return true;
      }
    }

    const mail = renderMail(s.subject, s.body, contextOf(row, s.siteUrl));
    try {
      await this.#d.getMailer().send({
        to: row.email,
        toName: row.name,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (row.attempts >= s.maxAttempts)
        store.markFinal(row.id, "failed", message);
      else store.markRetry(row.id, now + backoffMs(row.attempts), message);
      this.#pausedUntil = now + backoffMs(++this.#failStreak);
      return true;
    }
    this.#failStreak = 0;
    store.markSent(row.id, this.#d.now());
    return true;
  }
}
