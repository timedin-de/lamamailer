// Server-rendered HTML pages (German UI). The markup lives in ./templates/*.html (Handlebars); this file only
// prepares the data. {{value}} is HTML-escaped by Handlebars; {{{raw}}} is used only for the page body in layout.html.
import { readFileSync } from "node:fs";
import Handlebars from "handlebars";
import type { SettingsData } from "../core/settings.ts";
import type { Signup } from "../core/store.ts";
import type { FieldChoice, LamaPoll } from "../core/types.ts";

const hbs = Handlebars.create();
const source = (name: string): string =>
  readFileSync(new URL(`./templates/${name}.html`, import.meta.url), "utf8");
hbs.registerPartial("messages", source("partials/messages"));
hbs.registerPartial("options", source("partials/options"));

const compile = (name: string) => hbs.compile(source(name));
const templates = {
  layout: compile("layout"),
  setup: compile("setup"),
  login: compile("login"),
  dashboard: compile("dashboard"),
  settings: compile("settings"),
  template: compile("template"),
  account: compile("account"),
};

type Nav = "dashboard" | "settings" | "template" | "account" | "";
type Page = Exclude<keyof typeof templates, "layout">;

function render(
  page: Page,
  title: string,
  data: object,
  nav: Nav = "",
): string {
  return templates.layout({
    title,
    nav: nav ? { [nav]: true } : null,
    body: templates[page](data),
  });
}

interface Option {
  value: string;
  label: string;
  selected: boolean;
}
const opt = (value: string, label: string, selected: boolean): Option => ({
  value,
  label,
  selected,
});

// ---------- setup / login ----------

export const setupPage = (error?: string): string =>
  render("setup", "Einrichtung", { error });

export const loginPage = (error?: string): string =>
  render("login", "Anmelden", { error });

// ---------- dashboard ----------

export type DashState = "unconfigured" | "ready" | "active" | "paused";
export interface DashboardView {
  state: DashState;
  missing: string[];
  pollTitle: string;
  lastPoll: {
    at: number;
    ok: boolean;
    error?: string;
    added?: number;
    fetched?: number;
  } | null;
  counts: Record<string, number>;
  rows: (Signup & { stale: boolean })[];
  filter: string;
  staleCount: number;
  error?: string;
}

const fmt = (ms: number) => (ms ? new Date(ms).toLocaleString("de-DE") : "–");

export function dashboardPage(v: DashboardView): string {
  return render(
    "dashboard",
    "Übersicht",
    {
      ...v,
      is: { [v.state]: true },
      lastPoll: v.lastPoll && {
        ...v.lastPoll,
        at: fmt(v.lastPoll.at),
        fetched: v.lastPoll.fetched ?? 0,
        added: v.lastPoll.added ?? 0,
      },
      counts: Object.entries(v.counts).map(([status, n]) => ({ status, n })),
      rows: v.rows.map((r) => ({
        ...r,
        createdAt: fmt(r.createdAt),
        canRetry: r.stale || r.status === "failed" || r.status === "skipped",
      })),
    },
    "dashboard",
  );
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
  key: "API-Schlüssel gespeichert.",
  poll: "Umfrage übernommen.",
  fields: "Felder gespeichert.",
  refresh: "Fragen neu geladen.",
  advanced: "Erweiterte Einstellungen gespeichert.",
  smtp: "SMTP-Einstellungen gespeichert.",
  sending: "Versand-Regeln gespeichert.",
  saved: "Gespeichert.",
  password: "Passwort geändert.",
};
export const noticeFor = (key: unknown): string | undefined =>
  typeof key === "string" ? NOTICES[key] : undefined;

export function settingsPage(v: SettingsView): string {
  const { s } = v;
  const fieldOptions = (current: string, optional: boolean): Option[] => [
    ...(optional ? [opt("", "— keines —", current === "")] : []),
    ...v.choices.map((c) =>
      opt(c.varname, `${c.label} · ${c.varname}`, c.varname === current),
    ),
  ];

  return render(
    "settings",
    "Einstellungen",
    {
      s,
      notice: v.notice,
      error: v.error,
      pollsError: v.pollsError,
      pollOptions: v.polls && [
        opt("", "— bitte wählen —", !s.pollId),
        ...v.polls.map((p) =>
          opt(String(p.id), `${p.name} (#${p.id})`, p.id === s.pollId),
        ),
      ],
      emailOptions: fieldOptions(s.emailVar, false),
      firstNameOptions: fieldOptions(s.firstNameVar, true),
      lastNameOptions: fieldOptions(s.lastNameVar, true),
      choiceCount: v.choices.length,
      dateFromOptions: [
        opt(
          "date",
          "Nur Datum (wie im PHP-Skript)",
          s.dateFromFormat === "date",
        ),
        opt("datetime", "Datum und Uhrzeit", s.dateFromFormat === "datetime"),
      ],
      securityOptions: [
        opt("starttls", "STARTTLS (Port 587)", s.smtpSecurity === "starttls"),
        opt("tls", "TLS (Port 465)", s.smtpSecurity === "tls"),
        opt("none", "Keine (nur lokal)", s.smtpSecurity === "none"),
      ],
    },
    "settings",
  );
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
  return render(
    "template",
    "Mail-Text",
    {
      ...v,
      preview: v.preview && {
        ...v.preview,
        unknown: v.preview.unknown.map((u) => `{${u}}`),
      },
    },
    "template",
  );
}

// ---------- account ----------

export const accountPage = (notice?: string, error?: string): string =>
  render("account", "Konto", { notice, error }, "account");
