import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Store } from "../src/core/store.ts";
import { Settings, DEFAULTS, maskSecrets } from "../src/core/settings.ts";
import { tempDir } from "./helpers.ts";

function open() {
  const path = join(tempDir(), "t.db");
  return { path, store: new Store(path) };
}

test("returns defaults on a fresh database", () => {
  const s = new Settings(open().store).get();
  assert.deepEqual(s, DEFAULTS);
  assert.equal(s.enabled, false);
  assert.equal(s.smtpPort, 587);
  assert.equal(s.pollIntervalSec, 20);
});

test("update merges, persists across reopen, and keeps other values", () => {
  const { path, store } = open();
  const settings = new Settings(store);
  settings.update({ apiKey: "secret", pollId: 42 });
  settings.update({ smtpHost: "smtp.example.org" });
  store.close();
  const again = new Settings(new Store(path)).get();
  assert.equal(again.apiKey, "secret");
  assert.equal(again.pollId, 42);
  assert.equal(again.smtpHost, "smtp.example.org");
  assert.equal(again.smtpPort, 587);
});

test("readiness checks tell what is still missing", () => {
  const settings = new Settings(open().store);
  assert.deepEqual(settings.missing(), [
    "LamaPoll API-Schlüssel",
    "Umfrage",
    "E-Mail-Feld",
    "SMTP-Server",
    "Absender-Adresse",
  ]);
  settings.update({
    apiKey: "k",
    pollId: 1,
    emailVar: "V76",
    smtpHost: "h",
    fromEmail: "a@b.de",
  });
  assert.deepEqual(settings.missing(), []);
  assert.equal(settings.isReady(), true);
});

test("maskSecrets hides api key and smtp password for display", () => {
  const masked = maskSecrets({
    ...DEFAULTS,
    apiKey: "abcdef123456",
    smtpPassword: "pw",
  });
  assert.equal(masked.apiKey, "••••3456");
  assert.equal(masked.smtpPassword, "••••");
  assert.equal(maskSecrets(DEFAULTS).apiKey, "");
});
