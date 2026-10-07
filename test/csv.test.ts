import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.ts';

test('parses simple semicolon csv', () => {
  assert.deepEqual(parseCsv('a;b\n1;2\n'), [['a', 'b'], ['1', '2']]);
});

test('handles quotes, escaped quotes, delimiters and newlines inside cells', () => {
  const csv = 'id;text\n1;"Müller; ""Max""\nzweite Zeile"\n2;x\n';
  assert.deepEqual(parseCsv(csv), [['id', 'text'], ['1', 'Müller; "Max"\nzweite Zeile'], ['2', 'x']]);
});

test('handles CRLF, BOM, empty cells and a missing final newline', () => {
  assert.deepEqual(parseCsv('﻿a;b;c\r\n1;;3'), [['a', 'b', 'c'], ['1', '', '3']]);
});

test('skips blank lines and returns [] for empty input', () => {
  assert.deepEqual(parseCsv('a;b\n\n1;2\n\n'), [['a', 'b'], ['1', '2']]);
  assert.deepEqual(parseCsv(''), []);
});

test('supports a custom delimiter', () => {
  assert.deepEqual(parseCsv('a,b\n1,2', ','), [['a', 'b'], ['1', '2']]);
});
