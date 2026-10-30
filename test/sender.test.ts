import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Store, type NewSignup } from "../src/core/store.ts";
import { Settings } from "../src/core/settings.ts";
import { Sender, backoffMs } from "../src/mail/sender.ts";
import type { Mailer, OutgoingMail } from "../src/mail/mailer.ts";
import { tempDir } from "./helpers.ts";

const T0 = 1_800_000_000_000;

class FakeMailer implements Mailer {
  sent: OutgoingMail[] = [];
  failures: (Error | null)[] = [];
  calls = 0;
  async send(mail: OutgoingMail): Promise<void> {
    const failure = this.failures[this.calls++];
    if (failure) throw failure;
    this.sent.push(mail);
  }
}

function setup(patch = {}) {
  const store = new Store(join(tempDir(), "t.db"));
  const settings = new Settings(store);
  settings.update({
    apiKey: "k",
    pollId: 1,
    emailVar: "V76",
    smtpHost: "h",
    fromEmail: "a@b.de",
    enabled: true,
    maxAttempts: 3,
    perAddressCap: 0,
    ...patch,
  });
  const mailer = new FakeMailer();
  const clock = { now: T0 };
  const sender = new Sender({
    store,
    settings,
    getMailer: () => mailer,
    now: () => clock.now,
  });
  const add = (
    key: string,
    email: string,
    name = "Anna Müller",
    extra: Partial<NewSignup> = {},
  ) =>
    store.addSignups(
      [
        {
          key,
          email,
          name,
          status: "pending",
          fields: {
            firstName: "Anna",
            lastName: "Müller",
            answers: [{ label: "Zimmer", value: "Doppel" }],
            fields: { V60: "Doppel" },
          },
          ...extra,
        },
      ],
      T0,
      T0,
    );
  const status = (key: string) =>
    store.list("", 100).find((r) => r.key === key)!;
  return { store, settings, mailer, clock, sender, add, status };
}

test("idle when the queue is empty or the mailer is disabled", async () => {
  const t = setup();
  assert.equal(await t.sender.sendNext(), false);
  t.add("id:1", "a@x.de");
  t.settings.update({ enabled: false });
  assert.equal(await t.sender.sendNext(), false);
  assert.equal(t.status("id:1").status, "pending");
});

test("sends the rendered mail with sender, recipient and answers table, then marks sent", async () => {
  const t = setup({
    fromName: "Event Team",
    replyTo: "help@x.de",
    siteUrl: "https://x.de",
    subject: "Hallo {first_name}",
    body: "<p>{name}</p>{answers}",
  });
  t.add("id:1", "anna@x.de");
  assert.equal(await t.sender.sendNext(), true);
  const [m] = t.mailer.sent;
  assert.equal(m.to, "anna@x.de");
  assert.equal(m.toName, "Anna Müller");
  assert.equal(m.subject, "Hallo Anna");
  assert.match(m.html, /<p>Anna Müller<\/p>.*Zimmer.*Doppel/s);
  assert.match(m.text, /Zimmer: Doppel/);
  assert.equal(t.status("id:1").status, "sent");
});

test("failures are retried with backoff and finally marked failed", async () => {
  const t = setup();
  t.mailer.failures = [
    new Error("451"),
    new Error("451"),
    new Error("550 no such user"),
  ];
  t.add("id:1", "a@x.de");
  await t.sender.sendNext();
  assert.equal(t.status("id:1").status, "pending");
  assert.equal(t.status("id:1").nextTryAt, T0 + 30_000);
  assert.equal(await t.sender.sendNext(), false); // not due yet
  t.clock.now = T0 + 30_000;
  await t.sender.sendNext();
  assert.equal(t.status("id:1").nextTryAt, T0 + 30_000 + 60_000);
  t.clock.now = T0 + 600_000;
  await t.sender.sendNext();
  assert.equal(t.status("id:1").status, "failed");
  assert.equal(t.status("id:1").error, "550 no such user");
  assert.equal(t.mailer.calls, 3);
});

test("a transient failure followed by success ends as sent", async () => {
  const t = setup();
  t.mailer.failures = [new Error("timeout")];
  t.add("id:1", "a@x.de");
  await t.sender.sendNext();
  t.clock.now += 60_000;
  await t.sender.sendNext();
  assert.deepEqual(
    [t.status("id:1").status, t.status("id:1").attempts],
    ["sent", 2],
  );
});

test("a failure pauses the whole queue so a rate limit can recover", async () => {
  const t = setup({ maxAttempts: 10 });
  t.mailer.failures = [
    new Error("421 rate limit"),
    new Error("421 rate limit"),
  ];
  ["id:1", "id:2", "id:3"].forEach((k) => t.add(k, `${k.slice(3)}@x.de`));
  await t.sender.sendNext(); // id:1 fails
  assert.equal(await t.sender.sendNext(), false); // id:2 is due but the queue is paused
  assert.equal(t.mailer.calls, 1);
  t.clock.now = T0 + 30_000;
  await t.sender.sendNext(); // id:1 is due again and fails again
  assert.equal(t.mailer.calls, 2);
  t.clock.now = T0 + 30_000 + 59_999; // second consecutive failure doubles the pause
  assert.equal(await t.sender.sendNext(), false);
  t.clock.now = T0 + 30_000 + 60_000;
  await t.sender.sendNext(); // success resets the pause
  await t.sender.sendNext();
  await t.sender.sendNext();
  assert.equal(t.mailer.sent.length, 3);
});

test("per-address cap skips excess mails to one address only", async () => {
  const t = setup({ perAddressCap: 2 });
  ["id:1", "id:2", "id:3"].forEach((k) => t.add(k, "a@x.de"));
  t.add("id:4", "b@x.de");
  for (let i = 0; i < 4; i++) await t.sender.sendNext();
  assert.equal(t.mailer.sent.length, 3);
  assert.equal(t.status("id:3").status, "skipped");
  assert.match(t.status("id:3").error, /2/);
});

test("backoff doubles from 30s and caps at 30 minutes", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 20].map(backoffMs),
    [30_000, 60_000, 120_000, 240_000, 1_800_000],
  );
});
