// The admin web app: first-run setup, login, guided LamaPoll setup, SMTP, mail template, queue management.
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { fileURLToPath } from "node:url";
import { hashPassword, newToken, safeEqual, verifyPassword } from "./auth.ts";
import type { Settings, SettingsData } from "../core/settings.ts";
import { maskSecrets } from "../core/settings.ts";
import type { Store } from "../core/store.ts";
import { STALE_SENDING_MS } from "../core/store.ts";
import type { FieldChoice, LamaPoll, LamaQuestion } from "../core/types.ts";
import { sleep } from "../core/util.ts";
import { LamaPollClient } from "../lamapoll/client.ts";
import { fieldChoices } from "../lamapoll/questions.ts";
import { createSmtpMailer, type SmtpMailer } from "../mail/mailer.ts";
import { renderMail, SAMPLE_CONTEXT } from "../mail/template.ts";
import * as v from "./views.ts";

export interface ApiClient {
  listPolls(): Promise<LamaPoll[]>;
  listQuestions(pollId: number): Promise<LamaQuestion[]>;
}

export interface AppDeps {
  store: Store;
  settings: Settings;
  setupToken?: string; // required on first start to set the admin password; printed to the server log
  now?: () => number;
  failDelayMs?: number; // pause after a wrong password
  createApi?: (s: { baseUrl: string; apiKey: string }) => ApiClient;
  createMailer?: (s: SettingsData) => SmtpMailer;
}

const SESSION_MS = 12 * 3600_000;
const COOKIE = "sid";
const ADMIN_KEY = "admin_hash";

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);
const validEmail = (s: string): boolean =>
  /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s);
const text = (req: Request, name: string): string =>
  String(req.body?.[name] ?? "").trim();

/** Parses an integer form value; returns null if it is not a whole number in [min, max]. */
function int(raw: string, min: number, max: number): number | null {
  if (!/^-?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

export function createApp(deps: AppDeps) {
  const { store, settings } = deps;
  const now = deps.now ?? Date.now;
  const setupToken = deps.setupToken ?? newToken(8);
  const failDelayMs = deps.failDelayMs ?? 1000;
  const createApi =
    deps.createApi ??
    ((s) => new LamaPollClient({ baseUrl: s.baseUrl, apiKey: s.apiKey }));
  const createMailer = deps.createMailer ?? createSmtpMailer;

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback"); // behind Caddy: req.secure follows X-Forwarded-Proto
  app.use(express.urlencoded({ extended: false, limit: "2mb" }));

  // Stylesheet: public, so it is served before the setup and login checks.
  app.use(
    "/static",
    express.static(fileURLToPath(new URL("./static/", import.meta.url)), {
      index: false,
    }),
    (_req: Request, res: Response) => void res.status(404).send("Not found"),
  );

  const html = (res: Response, status: number, body: string) =>
    res.status(status).type("html").send(body);

  // ---------- security: same-site only, session cookie ----------

  // Refuses state-changing requests that were triggered from another site. Together with the
  // SameSite=Strict cookie this blocks CSRF without tokens in every form.
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      if (req.headers["sec-fetch-site"] === "cross-site")
        return void res.status(403).send("cross-site request refused");
      const origin = req.headers.origin;
      if (origin) {
        let host = "";
        try {
          host = new URL(origin).host;
        } catch {
          /* invalid origin header */
        }
        if (host !== req.headers.host)
          return void res.status(403).send("cross-origin request refused");
      }
    }
    next();
  });

  const cookieOf = (req: Request): string | undefined => {
    for (const part of (req.headers.cookie ?? "").split(";")) {
      const [k, ...rest] = part.trim().split("=");
      if (k === COOKIE) return rest.join("=");
    }
    return undefined;
  };

  const startSession = (req: Request, res: Response): void => {
    const token = newToken();
    store.createSession(token, now() + SESSION_MS);
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: req.secure,
      path: "/",
      maxAge: SESSION_MS,
    });
  };

  const hasAdmin = (): boolean => store.getKv(ADMIN_KEY) !== null;

  const auth = (req: Request, res: Response, next: NextFunction): void => {
    const token = cookieOf(req);
    if (token && store.sessionValid(token, now())) return next();
    res.redirect(303, "/login");
  };

  // Until an admin password exists, only /setup is reachable; afterwards /setup is gone.
  app.use((req, res, next) => {
    if (!hasAdmin())
      return req.path === "/setup" ? next() : void res.redirect(303, "/setup");
    if (req.path === "/setup") return void res.status(404).send("Not found");
    next();
  });

  // ---------- setup / login / logout ----------

  app.get("/setup", (_req, res) => html(res, 200, v.setupPage()));

  app.post("/setup", (req, res) => {
    if (!safeEqual(text(req, "token"), setupToken))
      return html(res, 403, v.setupPage("Falscher Setup-Code."));
    const pw = String(req.body?.password ?? "");
    if (pw.length < 8)
      return html(
        res,
        422,
        v.setupPage("Das Passwort braucht mindestens 8 Zeichen."),
      );
    if (pw !== String(req.body?.password2 ?? ""))
      return html(
        res,
        422,
        v.setupPage("Die Passwörter stimmen nicht überein."),
      );
    store.setKv(ADMIN_KEY, hashPassword(pw));
    startSession(req, res);
    res.redirect(303, "/");
  });

  app.get("/login", (_req, res) => html(res, 200, v.loginPage()));

  app.post("/login", async (req, res) => {
    if (
      !verifyPassword(String(req.body?.password ?? ""), store.getKv(ADMIN_KEY)!)
    ) {
      await sleep(failDelayMs); // slows down guessing
      return html(res, 401, v.loginPage("Falsches Passwort"));
    }
    startSession(req, res);
    res.redirect(303, "/");
  });

  app.post("/logout", (req, res) => {
    const token = cookieOf(req);
    if (token) store.deleteSession(token);
    res.clearCookie(COOKIE, { path: "/" });
    res.redirect(303, "/login");
  });

  // Everything below needs a session.
  app.use(auth);

  // ---------- dashboard ----------

  async function renderDashboard(
    res: Response,
    status: number,
    filter: string,
    error?: string,
  ) {
    const s = settings.get();
    const missing = settings.missing();
    const state: v.DashState = missing.length
      ? "unconfigured"
      : s.enabled
        ? "active"
        : store.getKv("activated") === "1"
          ? "paused"
          : "ready";
    const rows = store
      .list(filter, 200)
      .map((r) => ({ ...r, stale: store.isStale(r, now()) }));
    const lastRaw = store.getKv("last_poll");
    html(
      res,
      status,
      v.dashboardPage({
        state,
        missing,
        pollTitle: s.pollTitle || `#${s.pollId}`,
        lastPoll: lastRaw ? JSON.parse(lastRaw) : null,
        counts: store.counts(),
        rows,
        filter,
        staleCount: rows.filter((r) => r.stale).length,
        error,
      }),
    );
  }

  app.get("/", (req, res) =>
    renderDashboard(res, 200, String(req.query.status ?? "")),
  );

  app.post("/activate", (req, res) => {
    if (!settings.isReady())
      return renderDashboard(
        res,
        422,
        "",
        "Die Einrichtung ist noch nicht vollständig.",
      );
    settings.update({
      enabled: true,
      sendExisting: text(req, "sendExisting") === "1",
    });
    store.setKv("activated", "1"); // from now on "disabled" means "paused", not "never started"
    res.redirect(303, "/");
  });
  app.post("/pause", (_req, res) => {
    settings.update({ enabled: false });
    res.redirect(303, "/");
  });
  app.post("/resume", (_req, res) => {
    if (!settings.isReady())
      return renderDashboard(
        res,
        422,
        "",
        "Die Einrichtung ist noch nicht vollständig.",
      );
    settings.update({ enabled: true });
    res.redirect(303, "/");
  });

  const rowAction =
    (op: (id: number) => void) => (req: Request, res: Response) => {
      const id = int(String(req.params.id), 1, Number.MAX_SAFE_INTEGER);
      if (id === null) return void res.status(400).send("bad id");
      op(id);
      res.redirect(303, "/");
    };
  app.post(
    "/retry/:id",
    rowAction((id) => store.requeue(id)),
  );
  app.post(
    "/confirm/:id",
    rowAction((id) => store.forceSent(id, now())),
  );

  // ---------- settings ----------

  async function renderSettings(
    res: Response,
    status: number,
    extra: { notice?: string; error?: string } = {},
  ) {
    const s = settings.get();
    let polls: LamaPoll[] | null = null;
    let pollsError: string | undefined;
    if (s.apiKey) {
      try {
        polls = await createApi(s).listPolls();
      } catch (e) {
        pollsError = errorMessage(e);
      }
    }
    const choices = s.pollId ? fieldChoices(s.questions, s.lang || "de") : [];
    html(
      res,
      status,
      v.settingsPage({
        s: maskSecrets(s),
        polls,
        pollsError,
        choices,
        ...extra,
      }),
    );
  }

  app.get("/settings", (req, res) =>
    renderSettings(res, 200, { notice: v.noticeFor(req.query.msg) }),
  );

  app.post("/settings/lamapoll/key", async (req, res) => {
    const apiKey = text(req, "apiKey");
    if (!apiKey)
      return renderSettings(res, 422, {
        error: "Bitte einen API-Schlüssel eingeben.",
      });
    try {
      await createApi({ baseUrl: settings.get().baseUrl, apiKey }).listPolls(); // proves the key works
    } catch (e) {
      return renderSettings(res, 422, { error: errorMessage(e) }); // not saved
    }
    settings.update({ apiKey });
    res.redirect(303, "/settings?msg=key");
  });

  /** Guesses sensible defaults for the pickers: the "E-Mail" question, "Vorname" and "Nachname". */
  function guessFields(choices: FieldChoice[]) {
    const find = (re: RegExp) =>
      choices.find((c) => re.test(c.label))?.varname ?? "";
    return {
      emailVar: choices.find((c) => c.likelyEmail)?.varname ?? "",
      firstNameVar: find(/^(vorname|first ?name)$/i),
      lastNameVar: find(/^(nachname|familienname|last ?name|surname)$/i),
    };
  }

  app.post("/settings/lamapoll/poll", async (req, res) => {
    const s = settings.get();
    const id = int(text(req, "pollId"), 1, Number.MAX_SAFE_INTEGER);
    try {
      const poll =
        id === null
          ? undefined
          : (await createApi(s).listPolls()).find((p) => p.id === id);
      if (!poll)
        return renderSettings(res, 422, {
          error: "Bitte eine Umfrage aus der Liste wählen.",
        });
      const questions = await createApi(s).listQuestions(poll.id);
      const keep = poll.id === s.pollId;
      const guessed = guessFields(fieldChoices(questions, s.lang || "de"));
      if (!keep) store.clearPollData(); // a new poll starts from scratch: empty queue, first run again
      settings.update({
        pollId: poll.id,
        pollTitle: poll.name || `Umfrage ${poll.id}`,
        questions,
        ...(keep && s.emailVar ? {} : guessed), // switching polls resets the field choice
        ...(keep ? {} : { enabled: false, sendExisting: false }), // ... and waits for a new "Starten"
      });
    } catch (e) {
      return renderSettings(res, 502, { error: errorMessage(e) });
    }
    res.redirect(303, "/settings?msg=poll");
  });

  app.post("/settings/lamapoll/fields", async (req, res) => {
    const s = settings.get();
    const valid = new Set(
      fieldChoices(s.questions, s.lang || "de").map((c) => c.varname),
    );
    const emailVar = text(req, "emailVar"),
      firstNameVar = text(req, "firstNameVar"),
      lastNameVar = text(req, "lastNameVar");
    if (!valid.has(emailVar))
      return renderSettings(res, 422, {
        error: "Bitte ein E-Mail-Feld aus der Liste wählen.",
      });
    if (
      (firstNameVar && !valid.has(firstNameVar)) ||
      (lastNameVar && !valid.has(lastNameVar))
    ) {
      return renderSettings(res, 422, { error: "Ungültiges Namensfeld." });
    }
    settings.update({ emailVar, firstNameVar, lastNameVar });
    res.redirect(303, "/settings?msg=fields");
  });

  app.post("/settings/lamapoll/refresh", async (_req, res) => {
    const s = settings.get();
    if (!s.pollId)
      return renderSettings(res, 422, { error: "Erst eine Umfrage wählen." });
    try {
      const questions = await createApi(s).listQuestions(s.pollId);
      const valid = new Set(
        fieldChoices(questions, s.lang || "de").map((c) => c.varname),
      );
      settings.update({
        questions,
        ...(valid.has(s.emailVar) ? {} : { emailVar: "" }),
        ...(valid.has(s.firstNameVar) ? {} : { firstNameVar: "" }),
        ...(valid.has(s.lastNameVar) ? {} : { lastNameVar: "" }),
      });
    } catch (e) {
      return renderSettings(res, 502, { error: errorMessage(e) });
    }
    res.redirect(303, "/settings?msg=refresh");
  });

  app.post("/settings/advanced", (req, res) => {
    const baseUrl = text(req, "baseUrl").replace(/\/+$/, "");
    const lang = text(req, "lang"),
      format = text(req, "dateFromFormat");
    const interval = int(text(req, "pollIntervalSec"), 5, 3600);
    if (!/^https?:\/\/\S+$/.test(baseUrl))
      return renderSettings(res, 422, {
        error: "Die API-Adresse muss mit http:// oder https:// beginnen.",
      });
    if (lang && !/^[a-z]{2}$/.test(lang))
      return renderSettings(res, 422, {
        error: "Die Sprache muss ein Kürzel wie „de“ sein.",
      });
    if (format !== "date" && format !== "datetime")
      return renderSettings(res, 422, { error: "Ungültiges Datumsformat." });
    if (interval === null)
      return renderSettings(res, 422, {
        error: "Das Intervall muss zwischen 5 und 3600 Sekunden liegen.",
      });
    settings.update({
      baseUrl,
      lang,
      dateFromFormat: format,
      pollIntervalSec: interval,
    });
    res.redirect(303, "/settings?msg=advanced");
  });

  app.post("/settings/smtp", (req, res) => {
    const host = text(req, "smtpHost"),
      user = text(req, "smtpUser"),
      fromEmail = text(req, "fromEmail"),
      replyTo = text(req, "replyTo");
    const security = text(req, "smtpSecurity");
    const port = int(text(req, "smtpPort"), 1, 65535);
    if (!host)
      return renderSettings(res, 422, {
        error: "Bitte einen SMTP-Server angeben.",
      });
    if (port === null)
      return renderSettings(res, 422, { error: "Ungültiger Port." });
    if (security !== "starttls" && security !== "tls" && security !== "none")
      return renderSettings(res, 422, { error: "Ungültige Verschlüsselung." });
    if (!validEmail(fromEmail))
      return renderSettings(res, 422, { error: "Ungültige Absender-Adresse." });
    if (replyTo && !validEmail(replyTo))
      return renderSettings(res, 422, {
        error: "Ungültige „Antwort an“-Adresse.",
      });
    const typed = String(req.body?.smtpPassword ?? "");
    settings.update({
      smtpHost: host,
      smtpPort: port,
      smtpSecurity: security,
      smtpUser: user,
      fromEmail,
      replyTo,
      fromName: text(req, "fromName"),
      smtpPassword: !user
        ? ""
        : typed !== ""
          ? typed
          : settings.get().smtpPassword, // empty field keeps the saved password
    });
    res.redirect(303, "/settings?msg=smtp");
  });

  app.post("/settings/smtp/verify", async (_req, res) => {
    const s = settings.get();
    if (!s.smtpHost)
      return renderSettings(res, 422, {
        error: "Bitte zuerst den SMTP-Server speichern.",
      });
    try {
      await createMailer(s).verify();
    } catch (e) {
      return renderSettings(res, 502, {
        error: `SMTP-Verbindung fehlgeschlagen: ${errorMessage(e)}`,
      });
    }
    renderSettings(res, 200, { notice: "Verbindung erfolgreich." });
  });

  app.post("/settings/sending", (req, res) => {
    const rate = Number(text(req, "ratePerSec"));
    const attempts = int(text(req, "maxAttempts"), 1, 20);
    const cap = int(text(req, "perAddressCap"), 0, 1000);
    const siteUrl = text(req, "siteUrl");
    if (!(rate >= 0.1 && rate <= 50))
      return renderSettings(res, 422, {
        error: "Mails pro Sekunde: 0,1 bis 50.",
      });
    if (attempts === null)
      return renderSettings(res, 422, {
        error: "Versuche pro Mail: 1 bis 20.",
      });
    if (cap === null)
      return renderSettings(res, 422, {
        error: "Mails pro Adresse und Stunde: 0 bis 1000.",
      });
    if (siteUrl && !/^https?:\/\/\S+$/.test(siteUrl))
      return renderSettings(res, 422, {
        error: "Die Website-URL muss mit http:// oder https:// beginnen.",
      });
    settings.update({
      ratePerSec: rate,
      maxAttempts: attempts,
      perAddressCap: cap,
      siteUrl,
    });
    res.redirect(303, "/settings?msg=sending");
  });

  // ---------- mail template ----------

  const preview = (subject: string, body: string) =>
    renderMail(subject, body, {
      ...SAMPLE_CONTEXT,
      siteUrl: settings.get().siteUrl || SAMPLE_CONTEXT.siteUrl,
    });

  app.get("/template", (req, res) => {
    const s = settings.get();
    html(
      res,
      200,
      v.templatePage({
        subject: s.subject,
        body: s.body,
        notice: v.noticeFor(req.query.msg),
      }),
    );
  });

  app.post("/template", (req, res) => {
    const subject = text(req, "subject"),
      body = String(req.body?.body ?? "");
    if (!subject)
      return html(
        res,
        422,
        v.templatePage({
          subject,
          body,
          error: "Der Betreff darf nicht leer sein.",
        }),
      );
    settings.update({ subject, body });
    res.redirect(303, "/template?msg=saved");
  });

  app.post("/template/preview", (req, res) => {
    const subject = text(req, "subject"),
      body = String(req.body?.body ?? "");
    html(
      res,
      200,
      v.templatePage({ subject, body, preview: preview(subject, body) }),
    );
  });

  app.post("/template/test", async (req, res) => {
    const subject = text(req, "subject"),
      body = String(req.body?.body ?? ""),
      to = text(req, "to");
    const view = { subject, body };
    if (!validEmail(to))
      return html(
        res,
        400,
        v.templatePage({ ...view, error: "Ungültige Empfänger-Adresse." }),
      );
    const mail = preview(subject, body);
    try {
      await createMailer(settings.get()).send({
        to,
        toName: SAMPLE_CONTEXT.name,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
      });
    } catch (e) {
      return html(
        res,
        502,
        v.templatePage({
          ...view,
          preview: mail,
          error: `Senden fehlgeschlagen: ${errorMessage(e)}`,
        }),
      );
    }
    html(
      res,
      200,
      v.templatePage({
        ...view,
        preview: mail,
        notice: `Test-Mail an ${to} gesendet.`,
      }),
    );
  });

  // ---------- account ----------

  app.get("/account", (req, res) =>
    html(res, 200, v.accountPage(v.noticeFor(req.query.msg))),
  );

  app.post("/account/password", (req, res) => {
    const next = String(req.body?.next ?? "");
    if (
      !verifyPassword(String(req.body?.current ?? ""), store.getKv(ADMIN_KEY)!)
    )
      return html(
        res,
        422,
        v.accountPage(undefined, "Das aktuelle Passwort ist falsch."),
      );
    if (next.length < 8)
      return html(
        res,
        422,
        v.accountPage(
          undefined,
          "Das neue Passwort braucht mindestens 8 Zeichen.",
        ),
      );
    if (next !== String(req.body?.next2 ?? ""))
      return html(
        res,
        422,
        v.accountPage(undefined, "Die Passwörter stimmen nicht überein."),
      );
    store.setKv(ADMIN_KEY, hashPassword(next));
    store.deleteAllSessions(); // logs out every other device
    startSession(req, res);
    res.redirect(303, "/account?msg=password");
  });

  // Unexpected errors: show a plain message instead of a stack trace.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("request failed:", err);
    res.status(500).type("text").send("Interner Fehler");
  });

  return { app, setupToken, staleAfterMs: STALE_SENDING_MS };
}
