import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

/** A fresh temp directory that is removed when the test file finishes. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lamamailer-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
