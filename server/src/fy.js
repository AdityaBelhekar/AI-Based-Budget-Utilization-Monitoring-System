const DAY_MS = 864e5;

export const todayInIndia = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);

// The financial year (1 April to 31 March) that a YYYY-MM-DD date falls in.
export function financialYearOf(date) {
  const [y, m] = date.split('-').map(Number);
  const startYear = m >= 4 ? y : y - 1;
  return `${startYear}-${String(startYear + 1).slice(2)}`;
}

export function isRealDate(text) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

// Evaluated in Asia/Kolkata whatever the server's zone.
export function financialYearPosition(now = new Date()) {
  const today = todayInIndia(now);
  const [y, m, d] = today.split('-').map(Number);
  const financialYear = financialYearOf(today);
  const startYear = Number(financialYear.slice(0, 4));
  const start = Date.UTC(startYear, 3, 1);
  const dayOfYear = (Date.UTC(y, m - 1, d) - start) / DAY_MS + 1;
  const daysInYear = (Date.UTC(startYear + 1, 3, 1) - start) / DAY_MS;
  return { financialYear, dayOfYear, daysInYear, elapsedPct: Math.round((dayOfYear / daysInYear) * 10000) / 100 };
}
