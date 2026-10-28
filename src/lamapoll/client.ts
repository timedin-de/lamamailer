// Small client for the LamaPoll API v2: poll list, question list and the legacyResults CSV export.
import { parseCsv } from "./csv.ts";
import type { CsvRow, LamaPoll, LamaQuestion } from "../core/types.ts";

export class LamaPollError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "LamaPollError";
    this.status = status;
  }
}

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  pageSize?: number; // items per page for list calls
  timeoutMs?: number; // never wait forever
}

export interface ResultsOptions {
  dateFrom?: string; // "YYYY-MM-DD" or ISO date-time
  lang?: string;
}

export class LamaPollClient {
  #opts: Required<ClientOptions>;

  constructor(opts: ClientOptions) {
    this.#opts = {
      pageSize: 100,
      timeoutMs: 30_000,
      ...opts,
      baseUrl: opts.baseUrl.replace(/\/+$/, ""),
    };
  }

  async #get(
    path: string,
    params: Record<string, string> = {},
  ): Promise<unknown> {
    const url = `${this.#opts.baseUrl}${path}?${new URLSearchParams(params)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#opts.apiKey}`,
        },
        signal: AbortSignal.timeout(this.#opts.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError")
        throw new LamaPollError(
          "Zeitüberschreitung bei der Anfrage an LamaPoll",
        );
      throw new LamaPollError(
        `LamaPoll nicht erreichbar: ${err instanceof Error ? ((err.cause as Error | undefined)?.message ?? err.message) : err}`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new LamaPollError(
        `API-Schlüssel ungültig oder ohne Zugriff (HTTP ${res.status})`,
        res.status,
      );
    }
    if (!res.ok)
      throw new LamaPollError(
        `LamaPoll antwortet mit HTTP ${res.status}`,
        res.status,
      );
    try {
      return await res.json();
    } catch {
      throw new LamaPollError("Unerwartete Antwort von LamaPoll (kein JSON)");
    }
  }

  /** Fetches every page of a list endpoint. */
  async #list<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; ; offset += this.#opts.pageSize) {
      const page = (await this.#get(path, {
        limit: String(this.#opts.pageSize),
        offset: String(offset),
      })) as T[];
      if (!Array.isArray(page))
        throw new LamaPollError(
          "Unerwartete Antwort von LamaPoll (keine Liste)",
        );
      out.push(...page);
      if (page.length < this.#opts.pageSize) return out;
    }
  }

  async listPolls(): Promise<LamaPoll[]> {
    const polls = await this.#list<LamaPoll>("/polls");
    return polls.map((p) => ({ ...p, name: p.name || `Umfrage ${p.id}` }));
  }

  listQuestions(pollId: number): Promise<LamaQuestion[]> {
    return this.#list<LamaQuestion>(`/polls/${pollId}/questions`);
  }

  /** Completed submissions as rows keyed by variable name (vID, vCOMPLETED, V2, ...). */
  async legacyResults(pollId: number, opts: ResultsOptions): Promise<CsvRow[]> {
    const params: Record<string, string> = {
      status: "completed",
      delimiter: ";",
      withResponseStats: "true",
      withAttributes: "false",
      withPageStats: "false", // stats give vCOMPLETED; page times are big
      useCodings: "true",
      useMultiline: "true",
      showQuestionHeaders: "false",
    };
    if (opts.dateFrom) params.dateFrom = opts.dateFrom;
    if (opts.lang) params.lang = opts.lang;

    // The response is { numCols, numLines, data } - there is no success flag.
    const body = (await this.#get(
      `/polls/${pollId}/legacyResults`,
      params,
    )) as {
      data?: unknown;
    };
    if (typeof body?.data !== "string")
      throw new LamaPollError(
        "Unerwartete Antwort von LamaPoll (keine CSV-Daten)",
      );

    const [header, ...records] = parseCsv(body.data, ";");
    if (!header) return [];
    const names = header.map((h) => h.trim());
    return records.map((cells) => {
      const row: CsvRow = {};
      names.forEach((name, i) => {
        if (name) row[name] = cells[i] ?? "";
      });
      return row;
    });
  }
}
