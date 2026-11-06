// All money is integer paise. These parse decimal strings digit by digit, so no float ever touches an amount.
const PAISE_PER_CRORE = 1_000_000_000;

function parseDecimal(text, maxDecimals) {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(text).trim());
  if (!match || (match[3]?.length ?? 0) > maxDecimals) throw new Error(`Not a valid amount: ${text}`);
  return { sign: match[1] ? -1 : 1, whole: Number(match[2]), fraction: (match[3] ?? '').padEnd(maxDecimals, '0') };
}

function checked(paise) {
  if (!Number.isSafeInteger(paise)) throw new Error('Amount is too large');
  return paise === 0 ? 0 : paise;
}

export function rupeesToPaise(text) {
  const { sign, whole, fraction } = parseDecimal(text, 2);
  return checked(sign * (whole * 100 + Number(fraction || 0)));
}

// CGA publishes crore to at most 2 decimal places.
export function croreToPaise(text) {
  const { sign, whole, fraction } = parseDecimal(text, 2);
  return checked(sign * (whole * PAISE_PER_CRORE + Number(fraction || 0) * (PAISE_PER_CRORE / 100)));
}

export const utilizationPct = (spentPaise, allocatedPaise) =>
  allocatedPaise > 0 ? Math.round((spentPaise / allocatedPaise) * 10000) / 100 : 0;
