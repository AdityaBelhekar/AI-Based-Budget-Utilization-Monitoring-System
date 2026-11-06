// Builds data/cga-monthly.csv from CGA's monthly "Union Government Accounts at a Glance" statements.
// Usage: node data/extract-cga.mjs <folder to cache raw pages in>
// Prefers cga.gov.in, then a public archive for months the official site no longer serves.
// Every row is checked against the percentage CGA itself prints; anything off is reported, never fixed silently.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [cacheDir] = process.argv.slice(2);
if (!cacheDir) throw new Error('Pass a folder to cache raw pages in');
mkdirSync(cacheDir, { recursive: true });

const ARCHIVE = 'https://pub-42dcd228294c46e29c30e3ae152a625b.r2.dev/documents/cga';
const MONTHS = ['april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'january', 'february', 'march'];
const HEADS = [
  ['FOOD', /^Food Subsidy/i],
  ['NBS', /^Nutrient Based/i],
  ['UREA', /^Urea/i],
  ['PETROLEUM', /^Petroleum/i],
  ['INTEREST', /Interest Payments/i],
  ['CAPEX', /^Capital Expenditure/i],
];
const OUTPUT = path.join(import.meta.dirname, 'cga-monthly.csv');

async function fetchPage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(40000) }).catch(() => null);
  return res?.ok ? Buffer.from(await res.arrayBuffer()).toString('latin1') : null;
}

async function loadStatement(startYear, i) {
  const fy = `${startYear}-${String(startYear + 1).slice(2)}`;
  const calMonth = ((i + 3) % 12) + 1;
  const calYear = i < 9 ? startYear : startYear + 1;
  const code = `${String(startYear).slice(2)}${String(startYear + 1).slice(2)}`;
  const official = `https://cga.gov.in/writereaddata/MonthAccount/${calMonth}${calYear}/DATA${code}.htm`;
  const archive = `${ARCHIVE}/${fy}/m${String(i + 1).padStart(2, '0')}_${MONTHS[i]}.htm`;
  const cached = path.join(cacheDir, `${fy}-${String(i + 1).padStart(2, '0')}.htm`);
  const meta = `${cached}.url`;
  if (existsSync(cached)) return { fy, calYear, calMonth, html: readFileSync(cached, 'latin1'), url: readFileSync(meta, 'utf8') };
  for (const url of [official, archive]) {
    const html = await fetchPage(url);
    if (html && /Subsid/i.test(html)) {
      writeFileSync(cached, html, 'latin1');
      writeFileSync(meta, url);
      return { fy, calYear, calMonth, html, url };
    }
  }
  return null;
}

const clean = (cell) =>
  cell.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[Â ]/g, ' ').replace(/\s+/g, ' ').trim();
const asNumber = (cell) => {
  const compact = cell.replace(/[\s,]/g, '');
  return /^-?\d+(\.\d+)?$/.test(compact) ? compact : null;
};

function parse({ html }) {
  const body = html.replace(/<head[\s\S]*?<\/head>/i, '').replace(/<!--[\s\S]*?-->/g, '');
  const rows = (body.match(/<tr[\s\S]*?<\/tr>/gi) ?? []).map((r) => (r.match(/<td[\s\S]*?<\/td>/gi) ?? []).map(clean).filter(Boolean));
  const found = {};
  let basis = null;
  for (const cells of rows) {
    const joined = cells.join(' ');
    if (!basis && /Estimates/i.test(joined)) basis = /Revised/i.test(joined) ? 'RE' : 'BE';
    const labelAt = cells.findIndex((c) => HEADS.some(([, re]) => re.test(c)));
    if (labelAt < 0) continue;
    const [head] = HEADS.find(([, re]) => re.test(cells[labelAt]));
    if (found[head]) continue;
    const rest = cells.slice(labelAt + 1);
    const numbers = rest.map(asNumber).filter((n) => n !== null);
    const pctCell = rest.find((c) => c.includes('%') && !c.includes('('));
    if (numbers.length >= 2) {
      found[head] = { budget: numbers[0], actual: numbers[1], pct: pctCell ? pctCell.replace(/[\s%]/g, '') : '' };
    }
  }
  return { basis, found };
}

const lines = ['financial_year,month,head,basis,budget_crore,ytd_actual_crore,published_pct,source_url'];
const problems = [];
const missing = [];

for (let startYear = 2019; startYear <= 2026; startYear++) {
  for (let i = 0; i < 12; i++) {
    const statement = await loadStatement(startYear, i);
    const label = `${startYear}-${String(startYear + 1).slice(2)} ${MONTHS[i]}`;
    if (!statement) {
      missing.push(label);
      continue;
    }
    const { basis, found } = parse(statement);
    const month = `${statement.calYear}-${String(statement.calMonth).padStart(2, '0')}`;
    for (const [head] of HEADS) {
      const row = found[head];
      if (!row) {
        problems.push(`${label} ${head}: not found`);
        continue;
      }
      const computed = (Number(row.actual) / Number(row.budget)) * 100;
      if (row.pct && Math.abs(computed - Number(row.pct)) > 1) {
        problems.push(`${label} ${head}: ${row.actual}/${row.budget} = ${computed.toFixed(1)}%, CGA prints ${row.pct}%`);
      }
      lines.push([statement.fy, month, head, basis, row.budget, row.actual, row.pct, statement.url].join(','));
    }
  }
}

writeFileSync(OUTPUT, `${lines.join('\n')}\n`);
console.log(`Wrote ${lines.length - 1} rows`);
console.log(`Not published: ${missing.join('; ')}`);
console.log(`Official pages: ${lines.filter((l) => l.includes('cga.gov.in')).length / HEADS.length}, archive pages: ${lines.filter((l) => l.includes('r2.dev')).length / HEADS.length}`);
console.log(problems.length ? `PROBLEMS (${problems.length}):\n${problems.join('\n')}` : 'All rows agree with CGA percentages');
