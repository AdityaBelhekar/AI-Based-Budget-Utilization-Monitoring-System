// Display only. Amounts travel as integer paise; nothing here feeds a calculation.
const grouped = (digits: number) => new Intl.NumberFormat('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const crore = (paise: number, digits = 0) => grouped(digits).format(paise / 1e9);
export const rupees = (paise: number) => grouped(2).format(paise / 100);
export const signedCrore = (paise: number) => `${paise > 0 ? '+' : paise < 0 ? '-' : ''}${crore(Math.abs(paise))}`;
export const signedPts = (pts: number) => `${pts > 0 ? '+' : pts < 0 ? '-' : ''}${Math.abs(pts).toFixed(2)}`;
export const pct = (n: number) => `${n.toFixed(2)}%`;
// Large figures read in crore, small ones in rupees, as Indian accounts are written.
export const money = (paise: number) => (Math.abs(paise) >= 1e9 ? `Rs ${crore(paise, 2)} crore` : `Rs ${rupees(paise)}`);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthShort = (month: string) => MONTHS[Number(month.slice(5, 7)) - 1];
export const monthLong = (month: string) => `${MONTHS_LONG[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
export const day = (date: string) => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
export const dateTime = (iso: string) => `${day(iso.slice(0, 10))}, ${iso.slice(11, 16)} UTC`;

// Parses what a person types as rupees into exact paise, or null when it is not a valid amount.
export function parseRupees(text: string): number | null {
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(text.replace(/,/g, '').trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

export const STATUS_WORDS: Record<string, string> = { behind: 'Behind pace', ahead: 'Ahead of pace', on: 'On pace', over: 'Over budget' };
export const ALERT_TYPES: Record<string, string> = {
  under_utilization: 'Under-utilization',
  pace_deviation: 'Pace deviation',
  overspending: 'Overspending',
  dormant: 'Dormant funds',
  year_end_rush: 'Year-end rush',
  possible_duplicate: 'Possible duplicate',
  spike: 'Spending spike',
};
export const CATEGORIES = ['Salaries', 'Subsidy', 'Interest', 'Capital works', 'Equipment', 'Travel', 'Grants', 'Services', 'Other'];

// The year in India decides the financial year, whatever the browser's time zone.
const startYearNow = () => {
  const [y, m] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()).split('-').map(Number);
  return m >= 4 ? y : y - 1;
};
const label = (start: number) => `${start}-${String(start + 1).slice(2)}`;
export const currentFinancialYear = () => label(startYearNow());
// Today's place in the financial year, in India: for the sign-in page, before any data is loaded.
export function yearPositionToday() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const start = Date.UTC(startYearNow(), 3, 1);
  const day = (Date.parse(today) - start) / 864e5 + 1;
  const days = (Date.UTC(startYearNow() + 1, 3, 1) - start) / 864e5;
  return { financialYear: currentFinancialYear(), day, days, pct: Math.round((day / days) * 10000) / 100 };
}
// Published data starts in 2019-20.
export const financialYears = () => Array.from({ length: startYearNow() - 2019 + 1 }, (_, i) => label(startYearNow() - i));
