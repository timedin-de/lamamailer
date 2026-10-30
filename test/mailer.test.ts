import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { createSmtpMailer } from "../src/mail/mailer.ts";
import { DEFAULTS } from "../src/core/settings.ts";

// Minimal plain-text SMTP server: accepts one mail and records the DATA part.
const received: string[] = [];
const server = createServer((socket) => {
  socket.setEncoding("utf8");
  let buf = "",
    inData = false,
    data = "";
  const say = (s: string) => socket.write(s + "\r\n");
  say("220 fake ESMTP");
  socket.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\r\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (inData) {
        if (line === ".") {
          inData = false;
          received.push(data);
          say("250 queued");
        } else data += line + "\n";
      } else if (/^(EHLO|HELO)/i.test(line)) say("250 fake");
      else if (/^DATA/i.test(line)) {
        inData = true;
        say("354 go");
      } else if (/^QUIT/i.test(line)) {
        say("221 bye");
        socket.end();
      } else say("250 ok");
    }
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());
const port = (server.address() as AddressInfo).port;

const settings = {
  ...DEFAULTS,
  smtpHost: "127.0.0.1",
  smtpPort: port,
  smtpSecurity: "none" as const,
  fromEmail: "events@example.org",
  fromName: "Event Team",
  replyTo: "help@example.org",
};

test("sends a multipart mail with sender, reply-to, utf-8 subject and both text and html", async () => {
  const mailer = createSmtpMailer(settings);
  await mailer.send({
    to: "anna@example.com",
    toName: "Anna Müller",
    subject: "Anmeldung bestätigt",
    html: "<p>Hallo <b>Anna</b></p>",
    text: "Hallo Anna\n",
  });
  const mail = received.at(-1)!;
  for (const want of [
    "From: Event Team <events@example.org>",
    "Reply-To: help@example.org",
    "anna@example.com",
    "Message-ID:",
    "multipart/alternative",
    "text/plain",
    "text/html",
  ]) {
    assert.ok(mail.includes(want), `mail is missing ${want}\n${mail}`);
  }
});

test("connection problems reject with a readable error", async () => {
  const mailer = createSmtpMailer({ ...settings, smtpPort: 1 });
  await assert.rejects(
    () =>
      mailer.send({
        to: "a@b.de",
        toName: "",
        subject: "s",
        html: "h",
        text: "t",
      }),
    /ECONNREFUSED|connect/i,
  );
});
