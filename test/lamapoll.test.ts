import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LamaPollClient, LamaPollError } from '../src/lamapoll/client.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;
const requests: { url: URL; auth: string | undefined }[] = [];
let handler: Handler = (_req, res) => { res.statusCode = 404; res.end(); };

const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  requests.push({ url, auth: req.headers.authorization });
  handler(req, res, url);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
after(() => { server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v2`;

const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};
const client = (extra = {}) => new LamaPollClient({ baseUrl: base, apiKey: 'KEY', pageSize: 2, ...extra });

test('listPolls sends the bearer key and follows pagination', async () => {
  requests.length = 0;
  const all = [{ id: 1, name: 'A', title: 'A-title' }, { id: 2, name: 'B' }, { id: 3, title: 'C-title', url: 'https://x/c' }];
  handler = (_req, res, url) => {
    const off = Number(url.searchParams.get('offset')), lim = Number(url.searchParams.get('limit'));
    json(res, all.slice(off, off + lim));
  };
  const polls = await client().listPolls();
  assert.deepEqual(polls.map((p) => [p.id, p.name]), [[1, 'A'], [2, 'B'], [3, 'Umfrage 3']]); // name only, never the title
  assert.ok(requests.every((r) => r.auth === 'Bearer KEY'));
  assert.equal(requests.length, 2); // 2 + 1 items -> second page is short, stop
});

test('listQuestions paginates and targets the poll', async () => {
  requests.length = 0;
  const all = [{ id: 10, type: 'INPUT' }, { id: 11, type: 'CHOICE' }, { id: 12, type: 'INPUT' }];
  handler = (_req, res, url) => {
    const off = Number(url.searchParams.get('offset')), lim = Number(url.searchParams.get('limit'));
    json(res, all.slice(off, off + lim));
  };
  const qs = await client().listQuestions(42);
  assert.equal(qs.length, 3);
  assert.equal(requests[0].url.pathname, '/api/v2/polls/42/questions');
});

test('a rejected key becomes a clear LamaPollError', async () => {
  handler = (_req, res) => json(res, { message: 'unauthorized' }, 401);
  await assert.rejects(() => client().listPolls(), (e: unknown) => e instanceof LamaPollError && e.status === 401 && /API-Schlüssel/.test(e.message));
});

test('legacyResults requests the export like the PHP reference and returns rows keyed by variable', async () => {
  requests.length = 0;
  const csv = 'vID;vCOMPLETED;V2;V76\n101;1;Anna;anna@example.org\n102;1;"Ben ""B""";ben@example.org\n';
  handler = (_req, res) => json(res, { numCols: 4, numLines: 3, data: csv });
  const rows = await client().legacyResults(42, { dateFrom: '2026-10-06', lang: 'de' });
  const q = requests[0].url.searchParams;
  assert.equal(requests[0].url.pathname, '/api/v2/polls/42/legacyResults');
  assert.deepEqual(
    Object.fromEntries(['status', 'delimiter', 'dateFrom', 'lang', 'withPageStats', 'withAttributes', 'withResponseStats', 'useCodings', 'useMultiline'].map((k) => [k, q.get(k)])),
    { status: 'completed', delimiter: ';', dateFrom: '2026-10-06', lang: 'de', withPageStats: 'false', withAttributes: 'false', withResponseStats: 'true', useCodings: 'true', useMultiline: 'true' },
  );
  assert.deepEqual(rows, [
    { vID: '101', vCOMPLETED: '1', V2: 'Anna', V76: 'anna@example.org' },
    { vID: '102', vCOMPLETED: '1', V2: 'Ben "B"', V76: 'ben@example.org' },
  ]);
});

test('legacyResults omits dateFrom/lang when not given and handles empty data', async () => {
  requests.length = 0;
  handler = (_req, res) => json(res, { numCols: 0, numLines: 0, data: '' });
  assert.deepEqual(await client().legacyResults(1, {}), []);
  assert.equal(requests[0].url.searchParams.has('dateFrom'), false);
  assert.equal(requests[0].url.searchParams.has('lang'), false);
});

test('legacyResults surfaces a response without CSV data and HTTP errors', async () => {
  handler = (_req, res) => json(res, { numCols: 0, numLines: 0 });
  await assert.rejects(() => client().legacyResults(1, {}), (e: unknown) => e instanceof LamaPollError && /keine CSV-Daten/.test(e.message));
  handler = (_req, res) => json(res, { data: 42 });
  await assert.rejects(() => client().legacyResults(1, {}), LamaPollError);
  handler = (_req, res) => json(res, { message: 'boom' }, 500);
  await assert.rejects(() => client().legacyResults(1, {}), (e: unknown) => e instanceof LamaPollError && e.status === 500);
});

test('network errors and timeouts are reported as LamaPollError', async () => {
  const dead = new LamaPollClient({ baseUrl: 'http://127.0.0.1:1/api/v2', apiKey: 'k' });
  await assert.rejects(() => dead.listPolls(), LamaPollError);
  handler = () => { /* never answers */ };
  await assert.rejects(() => client({ timeoutMs: 100 }).listPolls(), /Zeitüberschreitung/);
});
