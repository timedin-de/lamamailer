import type { Answer, CsvRow, FieldChoice, Localized, LamaQuestion, QuestionInfo } from './types.ts';

// Turns LamaPoll question definitions (GET /polls/{id}/questions) into
//  - a variable map used to decode raw CSV answers into readable text (ported from the PHP reference),
//  - the lists offered in the admin UI (email / name field pickers).

const stripTags = (s: unknown): string => String(s ?? '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/** Picks a text for the preferred language, then English, then whatever exists. */
function pick(obj: Localized | undefined, lang: string): string {
  if (!obj || typeof obj !== 'object') return '';
  return obj[lang] ?? obj.de ?? obj.en ?? Object.values(obj)[0] ?? '';
}

/**
 * Keyed by LamaPoll variable name (V2, V76, ...).
 */
export function buildQuestionMap(questions: LamaQuestion[], lang = 'de'): Map<string, QuestionInfo> {
  const map = new Map<string, QuestionInfo>();
  for (const q of questions) {
    const label = stripTags(pick(q.question, lang)) || '?';
    for (const g of q.groups ?? []) {
      const varnames = g.varnames ?? [];
      const codes = g.codes ?? [];
      const labels = g.labels ?? [];
      if (varnames.length > 1) {
        // Checkboxes: every varname is one option; the value "1" means selected.
        varnames.forEach((vn, i) => map.set(vn, { label, type: q.type, codeMap: {}, optionLabel: stripTags(pick(labels[i], lang)) }));
      } else if (varnames.length === 1) {
        const codeMap: Record<string, string> = {};
        codes.forEach((code, i) => { codeMap[String(code)] = stripTags(pick(labels[i], lang)) || String(code); });
        map.set(varnames[0], { label, type: q.type, codeMap });
      }
    }
  }
  return map;
}

/** Decodes one raw cell into the text a person would read. Empty string = nothing to show. */
export function decodeAnswer(varname: string, raw: unknown, map: Map<string, QuestionInfo>): string {
  const value = String(raw ?? '').trim();
  if (value === '') return '';
  const info = map.get(varname);
  if (!info) return value;
  if (info.type === 'CHOICE') {
    if (info.optionLabel) return value === '1' ? info.optionLabel : '';
    return info.codeMap[value] ?? value;
  }
  return value;
}

/**
 * Decodes a whole CSV row.
 * Returns answers in column order (for the table in the mail) and fields keyed by variable name.
 */
export function decodeRow(row: CsvRow, map: Map<string, QuestionInfo>): { answers: Answer[]; fields: Record<string, string> } {
  const answers: Answer[] = [];
  const fields: Record<string, string> = {};
  for (const [varname, raw] of Object.entries(row)) {
    const info = map.get(varname);
    if (!info) continue; // internal columns (vID, vCOMPLETED, ...) and unknown variables
    const value = decodeAnswer(varname, raw, map);
    if (value === '') continue;
    fields[varname] = value;
    answers.push({ label: info.optionLabel ? `${info.label} - ${info.optionLabel}` : info.label, value });
  }
  return { answers, fields };
}

/** Text inputs the admin can choose as "email" / "name" field. Likely e-mail fields come first. */
export function fieldChoices(questions: LamaQuestion[], lang = 'de'): FieldChoice[] {
  const out: FieldChoice[] = [];
  for (const q of questions) {
    if (q.type !== 'INPUT') continue;
    const label = stripTags(pick(q.question, lang));
    for (const g of q.groups ?? []) {
      if (g.inputType && g.inputType !== 'SINGLELINE') continue;
      const varname = g.varnames?.[0];
      if (!varname) continue;
      out.push({ varname, label, questionId: q.id, likelyEmail: /e-?mail|mail-?adresse/i.test(label) });
    }
  }
  // stable sort: likely e-mail fields first, everything else keeps the poll order
  return out.map((c, i) => ({ c, i })).sort((a, b) => Number(b.c.likelyEmail) - Number(a.c.likelyEmail) || a.i - b.i).map((x) => x.c);
}
