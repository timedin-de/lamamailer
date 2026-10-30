import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderMail,
  SAMPLE_CONTEXT,
  DEFAULT_SUBJECT,
  DEFAULT_BODY,
  type MailContext,
} from "../src/mail/template.ts";

const ctx: MailContext = {
  name: "Anna Müller",
  firstName: "Anna",
  lastName: "Müller",
  email: "anna@example.org",
  siteUrl: "https://example.org",
  answers: [
    { label: "Hotelzimmer", value: "Doppelzimmer" },
    { label: "Hinweis", value: "Zeile 1\nZeile 2" },
  ],
  fields: { V60: "Doppelzimmer" },
};

test("fills known placeholders in subject and body", () => {
  const r = renderMail(
    "Hallo {first_name}",
    "<p>{name} / {last_name} / {email} / {site_url} / {field:V60}</p>",
    ctx,
  );
  assert.equal(r.subject, "Hallo Anna");
  assert.match(
    r.html,
    /<p>Anna Müller \/ Müller \/ anna@example\.org \/ https:\/\/example\.org \/ Doppelzimmer<\/p>/,
  );
});

test("escapes HTML in values so signups cannot inject markup", () => {
  const evil: MailContext = {
    ...ctx,
    name: "<script>alert(1)</script>",
    firstName: "<b>x</b>",
    answers: [{ label: "<i>q</i>", value: '"><img src=x>' }],
  };
  const r = renderMail("s", "{name} {first_name} {answers}", evil);
  assert.doesNotMatch(r.html, /<script>|<b>x|<img|<i>q/);
  assert.match(r.html, /&lt;script&gt;/);
});

test("{answers} renders a question/answer table and keeps line breaks", () => {
  const r = renderMail("s", "{answers}", ctx);
  assert.match(r.html, /<table/);
  assert.match(r.html, />Hotelzimmer</);
  assert.match(r.html, />Doppelzimmer</);
  assert.match(r.html, /Zeile 1<br>\s*Zeile 2/);
});

test("{answers} is empty when there are no answers", () => {
  assert.doesNotMatch(
    renderMail("s", "x{answers}y", { ...ctx, answers: [] }).html,
    /<table/,
  );
});

test("unknown placeholders are reported and left untouched; CSS braces are not placeholders", () => {
  const r = renderMail(
    "s",
    "<style>a{color:red} .x { margin: 0 }</style>{signup_type} {name}",
    ctx,
  );
  assert.deepEqual(r.unknown, ["signup_type"]);
  assert.match(r.html, /\{signup_type\} Anna Müller/);
  assert.match(r.html, /a\{color:red\} \.x \{ margin: 0 \}/);
});

test("subject is a single plain-text line (no HTML escaping, no line breaks)", () => {
  const r = renderMail("Hi {name}\r\nBcc: x@y.de", "b", {
    ...ctx,
    name: "A & B",
  });
  assert.equal(r.subject, "Hi A & B Bcc: x@y.de");
});

test("text version has no tags/styles and keeps the answers readable", () => {
  const r = renderMail(
    "s",
    "<style>p{color:red}</style><h1>Hallo</h1><p>Hi {name}</p>{answers}",
    ctx,
  );
  assert.doesNotMatch(r.text, /<|color:red/);
  assert.match(r.text, /Hallo\n/);
  assert.match(r.text, /Hotelzimmer\s*:?\s*Doppelzimmer/);
});

test("missing field placeholders become empty text", () => {
  assert.match(renderMail("s", "[{field:V999}]", ctx).html, /\[\]/);
});

test("the default template renders cleanly with sample data", () => {
  const r = renderMail(DEFAULT_SUBJECT, DEFAULT_BODY, SAMPLE_CONTEXT);
  assert.deepEqual(r.unknown, []);
  assert.match(r.html, /Max Mustermann/);
});
