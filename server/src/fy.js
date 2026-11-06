const DAY_MS = 864e5;
const round2 = (n) => Math.round(n * 100) / 100;

export const todayInIndia = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);

// The financial year (1 April to 31 March) that a YYYY-MM-DD date falls in.
export function financialYearOf(date) {
  const [y, m] = date.split('-').map(Number);
  const startYear = m >= 4 ? y : y - 1;
  return `${startYear}-${String(startYear + 1).slice(2)}`;
}

export function fyBounds(financialYear) {
  const s = Number(financialYear.slice(0, 4));
  return { start: `${s}-04-01`, end: `${s + 1}-03-31`, q4: `${s + 1}-01-01`, march: `${s + 1}-03-01` };
}

// The 12 months of a financial year as YYYY-MM, April first.
export const fyMonths = (financialYear) => {
  const s = Number(financialYear.slice(0, 4));
  return Array.from({ length: 12 }, (_, i) => `${i < 9 ? s : s + 1}-${String(((i + 3) % 12) + 1).padStart(2, '0')}`);
};

export const monthEnd = (month) => {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

export const daysBetween = (from, to) => (Date.parse(to) - Date.parse(from)) / DAY_MS;

export function isRealDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

// Where a YYYY-MM-DD date sits in its financial year, counting that day as passed.
export function positionAt(date) {
  const financialYear = financialYearOf(date);
  const { start, end } = fyBounds(financialYear);
  const dayOfYear = daysBetween(start, date) + 1;
  const daysInYear = daysBetween(start, end) + 1;
  return { financialYear, dayOfYear, daysInYear, elapsedPct: round2((dayOfYear / daysInYear) * 100) };
}

// Evaluated in Asia/Kolkata whatever the server's zone.
export const financialYearPosition = (now = new Date()) => positionAt(todayInIndia(now));
