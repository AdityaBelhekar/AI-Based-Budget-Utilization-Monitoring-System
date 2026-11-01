const DAY_MS = 864e5;

// Indian financial year (1 April to 31 March), evaluated in Asia/Kolkata whatever the server's zone.
export function financialYearPosition(now = new Date()) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now).split('-').map(Number);
  const startYear = m >= 4 ? y : y - 1;
  const start = Date.UTC(startYear, 3, 1);
  const dayOfYear = (Date.UTC(y, m - 1, d) - start) / DAY_MS + 1;
  const daysInYear = (Date.UTC(startYear + 1, 3, 1) - start) / DAY_MS;
  return {
    financialYear: `${startYear}-${String(startYear + 1).slice(2)}`,
    dayOfYear,
    daysInYear,
    elapsedPct: Math.round((dayOfYear / daysInYear) * 10000) / 100,
  };
}
