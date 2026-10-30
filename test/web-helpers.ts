import { after } from "node:test";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { Store } from "../src/core/store.ts";
import { Settings } from "../src/core/settings.ts";
import { createApp, type ApiClient } from "../src/web/app.ts";
import type { Mailer, OutgoingMail, SmtpMailer } from "../src/mail/mailer.ts";
import type { LamaPoll, LamaQuestion } from "../src/core/types.ts";
import { tempDir } from "./helpers.ts";

export const SETUP_TOKEN = "setup-token-123";
export const PASSWORD = "correct horse battery";

// The API also sends a "title"; the app must show the name.
export const POLLS = [
  { id: 42, name: "Sommertreffen 2026", title: "Öffentlicher Titel" },
  { id: 43, name: "Workshop" },
] as LamaPoll[];
export const QUESTIONS: LamaQuestion[] = [
  {
    id: 1,
    type: "INPUT",
    question: { de: "Vorname" },
    groups: [{ inputType: "SINGLELINE", varnames: ["V2"] }],
  },
  {
    id: 2,
    type: "INPUT",
    question: { de: "Nachname" },
    groups: [{ inputType: "SINGLELINE", varnames: ["V3"] }],
  },
  {
    id: 3,
    type: "INPUT",
    question: { de: "Handynummer" },
    groups: [{ inputType: "SINGLELINE", varnames: ["V71"] }],
  },
  {
    id: 4,
    type: "INPUT",
    question: { de: "E-Mail" },
    groups: [{ inputType: "SINGLELINE", varnames: ["V76"] }],
  },
  {
    id: 5,
    type: "CHOICE",
    question: { de: "Zimmer" },
    groups: [{ varnames: ["V60"], codes: ["1"], labels: [{ de: "Einzel" }] }],
  },
];

export class FakeMailer implements SmtpMailer {
  sent: OutgoingMail[] = [];
  verifyError: Error | null = null;
  sendError: Error | null = null;
  async send(m: OutgoingMail) {
    if (this.sendError) throw this.sendError;
    this.sent.push(m);
  }
  async verify() {
    if (this.verifyError) throw this.verifyError;
  }
}

export interface Fakes {
  api: ApiClient & { keys: string[]; failKey: boolean };
  mailer: FakeMailer;
}

export async function startApp(
  opts: { clock?: { now: number }; setup?: boolean } = {},
) {
  const store = new Store(join(tempDir(), "t.db"));
  const settings = new Settings(store);
  const clock = opts.clock ?? { now: 1_800_000_000_000 };
  const mailer = new FakeMailer();
  const api = {
    keys: [] as string[],
    failKey: false,
    async listPolls() {
      if (api.failKey)
        throw new Error("API-Schlüssel ungültig oder ohne Zugriff (HTTP 401)");
      return POLLS;
    },
    async listQuestions() {
      return QUESTIONS;
    },
  };
  const { app } = createApp({
    store,
    settings,
    setupToken: SETUP_TOKEN,
    now: () => clock.now,
    failDelayMs: 0,
    createApi: (s) => {
      api.keys.push(s.apiKey);
      return api;
    },
    createMailer: () => mailer as Mailer & SmtpMailer,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = new Browser(base);
  if (opts.setup !== false)
    await browser.post("/setup", {
      token: SETUP_TOKEN,
      password: PASSWORD,
      password2: PASSWORD,
    });
  return { store, settings, clock, mailer, api, browser, base };
}

/** A tiny browser: keeps cookies, never follows redirects (so tests see them). */
export class Browser {
  cookie = "";
  base: string;
  constructor(base: string) {
    this.base = base;
  }

  async #send(
    path: string,
    init: RequestInit & { headers?: Record<string, string> },
  ): Promise<Page> {
    const res = await fetch(this.base + path, {
      ...init,
      redirect: "manual",
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...init.headers,
      },
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      this.cookie = /=\s*$/.test(pair) || /max-age=0/i.test(c) ? "" : pair;
    }
    return new Page(res, await res.text());
  }
  get(path: string) {
    return this.#send(path, {});
  }
  post(
    path: string,
    form: Record<string, string | string[]> = {},
    headers: Record<string, string> = {},
  ) {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form))
      for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    return this.#send(path, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
    });
  }
}

export class Page {
  res: Response;
  html: string;
  constructor(res: Response, html: string) {
    this.res = res;
    this.html = html;
  }
  get status() {
    return this.res.status;
  }
  get location() {
    return this.res.headers.get("location");
  }
  get setCookie() {
    return this.res.headers.getSetCookie().join("\n");
  }
}
