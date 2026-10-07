// Shared types. Only erasable syntax (no enums), so Node can run the .ts files directly.

/** Texts per language code, e.g. { de: "Vorname", en: "First name" }. */
export type Localized = Record<string, string>;

/** One group of a question as returned by GET /polls/{id}/questions. */
export interface LamaGroup {
  inputType?: string;
  varnames?: string[];
  codes?: string[];
  labels?: Localized[];
}

/** One question as returned by GET /polls/{id}/questions (only the fields we use). */
export interface LamaQuestion {
  id: number;
  type: 'MATRIX' | 'CHOICE' | 'SCALE' | 'INPUT' | 'RANKING' | string;
  question?: Localized;
  groups?: LamaGroup[];
}

/** One poll as returned by GET /polls. */
export interface LamaPoll {
  id: number;
  name?: string;
  title?: string;
  url?: string;
}

/** How a CSV variable (V76, ...) is decoded. */
export interface QuestionInfo {
  label: string;
  type: string;
  codeMap: Record<string, string>;
  optionLabel?: string;
}

export interface Answer { label: string; value: string }

/** A CSV row keyed by variable name (vID, vCOMPLETED, V2, ...). */
export type CsvRow = Record<string, string>;

export interface FieldChoice { varname: string; label: string; questionId: number; likelyEmail: boolean }
