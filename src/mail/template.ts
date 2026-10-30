// Mail template engine. Placeholders use single braces:
//   {name} {first_name} {last_name} {email} {site_url} {field:V60} {answers}
// Values are HTML-escaped in the body. {answers} renders a question/answer table of the whole signup.
// Unknown {words} are left as they are and reported, so typos are visible in the preview.
import { readFileSync } from "node:fs";
import type { Answer } from "../core/types.ts";

export interface MailContext {
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  siteUrl: string;
  answers: Answer[];
  fields: Record<string, string>; // decoded answers by variable name
}

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
  unknown: string[];
}

export const DEFAULT_SUBJECT = "Deine Anmeldung ist eingegangen";

// Starting point for the editor in the admin UI; the saved text lives in the settings.
export const DEFAULT_BODY = readFileSync(
  new URL("./default-body.html", import.meta.url),
  "utf8",
).trimEnd();

export const SAMPLE_CONTEXT: MailContext = {
  name: "Max Mustermann",
  firstName: "Max",
  lastName: "Mustermann",
  email: "max@example.org",
  siteUrl: "https://example.org",
  answers: [
    { label: "Hotelzimmer", value: "Doppelzimmer" },
    { label: "Anreise: Datum", value: "2026-10-09" },
  ],
  fields: {},
};

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function answersTable(answers: Answer[]): string {
  if (answers.length === 0) return "";
  const cell = "padding:8px 10px;border:1px solid #ddd;vertical-align:top;";
  const rows = answers
    .map(
      (a) =>
        `<tr><td style="${cell}width:45%;">${escapeHtml(a.label)}</td><td style="${cell}">${escapeHtml(a.value).replace(/\r?\n/g, "<br>")}</td></tr>`,
    )
    .join("");
  return (
    `<h2 style="font-size:17px;margin:24px 0 8px;">Deine Anmeldung</h2>` +
    `<table style="border-collapse:collapse;width:100%;font-size:13px;">` +
    `<tr><th style="${cell}text-align:left;background:#f3f3f3;">Frage</th><th style="${cell}text-align:left;background:#f3f3f3;">Antwort</th></tr>` +
    rows +
    `</table>`
  );
}

/** Looks up a plain-text value for a placeholder, or undefined if it is not a known placeholder. */
function valueOf(key: string, ctx: MailContext): string | undefined {
  switch (key) {
    case "name":
      return ctx.name;
    case "first_name":
      return ctx.firstName;
    case "last_name":
      return ctx.lastName;
    case "email":
      return ctx.email;
    case "site_url":
      return ctx.siteUrl;
  }
  if (key.startsWith("field:")) return ctx.fields[key.slice(6)] ?? "";
  return undefined;
}

const PLACEHOLDER = /\{([a-z_]+(?::[\w.]+)?)\}/g;

function fill(
  template: string,
  ctx: MailContext,
  format: (value: string) => string,
  unknown: Set<string>,
  answers?: string,
): string {
  return template.replace(PLACEHOLDER, (match, key: string) => {
    if (key === "answers" && answers !== undefined) return answers;
    const v = valueOf(key, ctx);
    if (v !== undefined) return format(v);
    if (!key.includes(":")) unknown.add(key); // {word} that we do not know; "{color:red}" is just CSS
    return match;
  });
}

export function renderMail(
  subjectTemplate: string,
  bodyTemplate: string,
  ctx: MailContext,
): RenderedMail {
  const unknown = new Set<string>();
  const subject = fill(subjectTemplate, ctx, (v) => v, unknown, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" "); // one line: no header injection
  const html = fill(
    bodyTemplate,
    ctx,
    escapeHtml,
    unknown,
    answersTable(ctx.answers),
  );
  return { subject, html, text: htmlToText(html), unknown: [...unknown] };
}

export function htmlToText(html: string): string {
  return (
    html
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
      .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, ": ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|tr|li|table)>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&")
      .split("\n")
      .map((l) => l.trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  );
}
