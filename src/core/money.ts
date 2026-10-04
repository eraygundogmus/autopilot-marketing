import { AutopilotError } from './errors';

const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);

function finite(value: number | string, label: string): number {
  const parsed = typeof value === 'string' ? (value.trim() === '' ? Number.NaN : Number(value)) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new AutopilotError('invalid_input', `${label} must be a finite number, got ${JSON.stringify(value)}`, {
      hint: `Pass ${label} as a finite number.`,
    });
  }
  return parsed;
}

/** Decimal places of a currency's minor unit: 0 for JPY and KRW, 3 for KWD and BHD, otherwise 2. */
export function currencyExponent(currency: string): number {
  const code = currency.trim().toUpperCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/** Google Ads micros: 1 unit = 1,000,000 micros. */
export function toMicros(amount: number): number {
  return Math.round(finite(amount, 'amount') * 1e6);
}

export function fromMicros(micros: number | string): number {
  return finite(micros, 'micros') / 1e6;
}

/** Meta budgets and bids are integers in the currency's minor unit (5000 = 50.00 USD, 5000 = 5000 JPY). */
export function toMinorUnits(amount: number, currency: string): number {
  return Math.round(finite(amount, 'amount') * 10 ** currencyExponent(currency));
}

export function fromMinorUnits(minor: number | string, currency: string): number {
  return finite(minor, 'minor') / 10 ** currencyExponent(currency);
}

/** Rounds to the currency's minor unit. */
export function roundMoney(amount: number, currency: string): number {
  const value = finite(amount, 'amount');
  const exponent = currencyExponent(currency);
  const text = String(value);
  // Shifting the decimal point in the decimal string avoids binary noise (1.005 * 100 = 100.49999999999999).
  if (!text.includes('e')) {
    const shifted = Math.round(Number(`${text}e${exponent}`));
    const result = Number(`${shifted}e-${exponent}`);
    return result === 0 ? 0 : result;
  }
  const factor = 10 ** exponent;
  const result = Math.round(value * factor) / factor;
  return result === 0 ? 0 : result;
}

/** e.g. `1,234.50 USD`. */
export function formatMoney(amount: number, currency: string): string {
  const value = finite(amount, 'amount');
  const exponent = currencyExponent(currency);
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(value);
  return `${formatted} ${currency.trim().toUpperCase()}`;
}

/**
 * Meta's own table, which is not the ISO minor unit: these currencies have offset 1 (the API value
 * is the amount itself); every other currency has offset 100, including the three-decimal ones.
 * Source: developers.facebook.com/docs/marketing-api/currencies, read 2026-10-04.
 */
const META_OFFSET_ONE = new Set(['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND']);

export function metaCurrencyOffset(currency: string): 1 | 100 {
  return META_OFFSET_ONE.has(currency.trim().toUpperCase()) ? 1 : 100;
}

/**
 * A budget or bid as the Marketing API expects it. Throws `invalid_input` when the amount cannot be
 * expressed exactly in Meta's units: rounding here would send a different amount than the one a
 * person approved.
 */
export function toMetaUnits(amount: number, currency: string): number {
  const scaled = finite(amount, 'amount') * metaCurrencyOffset(currency);
  const units = Math.round(scaled);
  if (Math.abs(scaled - units) > 1e-6) {
    throw new AutopilotError('invalid_input', `${amount} ${currency.toUpperCase()} cannot be expressed in Meta's units for this currency.`, {
      hint: metaCurrencyOffset(currency) === 1 ? 'Use a whole amount for this currency.' : 'Use at most two decimal places.',
    });
  }
  return units;
}

export function fromMetaUnits(units: number | string, currency: string): number {
  return finite(units, 'units') / metaCurrencyOffset(currency);
}
