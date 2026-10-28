import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LamaQuestion } from '../src/core/types.ts';
import { buildQuestionMap, decodeAnswer, fieldChoices, decodeRow } from '../src/lamapoll/questions.ts';

// Shaped like GET /polls/{id}/questions (see the PHP reference questions.json).
const questions: LamaQuestion[] = [
  { id: 1, type: 'INPUT', question: { de: 'Vorname' }, groups: [{ inputType: 'SINGLELINE', varnames: ['V2'], codes: [], labels: [] }] },
  { id: 2, type: 'INPUT', question: { de: 'Nachname' }, groups: [{ inputType: 'SINGLELINE', varnames: ['V3'], codes: [], labels: [] }] },
  { id: 3, type: 'INPUT', question: { de: 'E-Mail' }, groups: [{ inputType: 'SINGLELINE', varnames: ['V76'], codes: [], labels: [] }] },
  { id: 4, type: 'INPUT', question: { de: 'Alter' }, groups: [{ inputType: 'INTEGER', varnames: ['V1'], codes: [], labels: [] }] },
  {
    id: 5, type: 'CHOICE', question: { de: 'Hotelzimmer' },
    groups: [{ varnames: ['V60'], codes: ['1', '2'], labels: [{ de: '<b>Einzel</b>zimmer' }, { de: 'Doppelzimmer' }] }],
  },
  {
    id: 6, type: 'CHOICE', question: { de: 'Vorab-Anreise oder Verlängerung' },
    groups: [{ varnames: ['V5', 'V6'], codes: ['1', '2'], labels: [{ de: 'Vorab-Anreise' }, { en: 'Extension' }] }],
  },
  { id: 7, type: 'CHOICE', question: { de: 'Zustimmung Datenschutz' }, groups: [{ varnames: ['V38'], codes: ['1'], labels: [{ de: 'Ja' }] }] },
];

test('decodes single choice codes to labels (tags stripped)', () => {
  const map = buildQuestionMap(questions, 'de');
  assert.equal(decodeAnswer('V60', '1', map), 'Einzelzimmer');
  assert.equal(decodeAnswer('V60', '2', map), 'Doppelzimmer');
  assert.equal(decodeAnswer('V60', '9', map), '9'); // unknown code stays raw
});

test('multi-varname choice: each varname is one checkbox option', () => {
  const map = buildQuestionMap(questions, 'de');
  assert.equal(decodeAnswer('V5', '1', map), 'Vorab-Anreise');
  assert.equal(decodeAnswer('V5', '0', map), '');
  assert.equal(decodeAnswer('V6', '1', map), 'Extension'); // falls back to another language
});

test('input values and unknown variables pass through; empty stays empty', () => {
  const map = buildQuestionMap(questions, 'de');
  assert.equal(decodeAnswer('V2', ' Anna ', map), 'Anna');
  assert.equal(decodeAnswer('V999', 'x', map), 'x');
  assert.equal(decodeAnswer('V2', '  ', map), '');
});

test('decodeRow builds readable answers in column order and skips empty ones', () => {
  const map = buildQuestionMap(questions, 'de');
  const row = { vID: '77', vCOMPLETED: '1', V2: 'Anna', V3: 'Müller', V60: '2', V5: '1', V6: '0', V38: '1', V1: '' };
  const { answers, fields } = decodeRow(row, map);
  assert.deepEqual(answers, [
    { label: 'Vorname', value: 'Anna' },
    { label: 'Nachname', value: 'Müller' },
    { label: 'Hotelzimmer', value: 'Doppelzimmer' },
    { label: 'Vorab-Anreise oder Verlängerung - Vorab-Anreise', value: 'Vorab-Anreise' },
    { label: 'Zustimmung Datenschutz', value: 'Ja' },
  ]);
  assert.equal(fields.V60, 'Doppelzimmer');
  assert.equal(fields.vID, undefined); // internal columns are not answers
});

test('fieldChoices lists text inputs for the email/name pickers, likely e-mail first', () => {
  const choices = fieldChoices(questions, 'de');
  assert.deepEqual(choices.map((c) => c.varname), ['V76', 'V2', 'V3']); // INTEGER and CHOICE excluded
  assert.equal(choices[0].label, 'E-Mail');
  assert.equal(choices[0].likelyEmail, true);
});
