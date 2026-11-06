// RFC 4180 parser: quoted fields may contain commas, line breaks and doubled quotes.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

// Returns one object per data row, keyed by the header row.
export function parseCsvRecords(text) {
  const [header = [], ...rows] = parseCsv(text.replace(/^﻿/, ''));
  return { header, records: rows.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']))) };
}
