// Minimal CSV parser (RFC 4180 style): quoted cells, "" escapes, delimiters and newlines inside quotes.
// Written by hand to avoid a dependency; the LamaPoll export uses ";" as delimiter.

/** Returns rows of cells; blank lines are skipped. */
export function parseCsv(text: string, delimiter = ';'): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // byte order mark
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  const endCell = () => { row.push(cell); cell = ''; };
  const endRow = () => {
    endCell();
    if (!(row.length === 1 && row[0] === '')) rows.push(row); // skip blank lines
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === delimiter) endCell();
    else if (c === '\n') endRow();
    else if (c === '\r') { /* ignore, \n ends the row */ }
    else cell += c;
  }
  if (cell !== '' || row.length > 0) endRow(); // last line without newline
  return rows;
}
