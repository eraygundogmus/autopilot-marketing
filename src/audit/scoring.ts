import type { AuditScore, CheckCategory, CheckResult, ScoreStatus, Severity } from '../core/types';

export const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 5, high: 3, medium: 1, low: 0.5, info: 0 };

interface Tally {
  passWeight: number;
  failWeight: number;
  unknownWeight: number;
  /** Counts of checks, including weight-0 (info) ones. */
  evaluated: number;
  total: number;
}

function emptyTally(): Tally {
  return { passWeight: 0, failWeight: 0, unknownWeight: 0, evaluated: 0, total: 0 };
}

function add(tally: Tally, check: CheckResult): void {
  const weight = SEVERITY_WEIGHT[check.severity];
  if (check.status === 'pass') {
    tally.passWeight += weight;
    tally.evaluated += 1;
    tally.total += 1;
  } else if (check.status === 'fail') {
    tally.failWeight += weight;
    tally.evaluated += 1;
    tally.total += 1;
  } else if (check.status === 'unknown') {
    tally.unknownWeight += weight;
    tally.total += 1;
  }
}

/** Null when no weighted check was evaluated. */
function valueOf(tally: Tally): number | null {
  const evaluatedWeight = tally.passWeight + tally.failWeight;
  if (evaluatedWeight <= 0) return null;
  return Math.round(100 * (1 - tally.failWeight / evaluatedWeight));
}

function gradeOf(value: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (value >= 90) return 'A';
  if (value >= 75) return 'B';
  if (value >= 60) return 'C';
  if (value >= 40) return 'D';
  return 'F';
}

/**
 * value = 100 * (1 - failed weight / evaluated weight), where evaluated = pass + fail.
 * coverage = evaluated weight / (pass + fail + unknown weight). `not_applicable` is ignored.
 * coverage >= 0.8 complete, >= 0.6 provisional, else insufficient_evidence with value and grade null.
 * Grades: A >= 90, B >= 75, C >= 60, D >= 40, else F.
 */
export function scoreAudit(checks: CheckResult[]): AuditScore {
  const overall = emptyTally();
  const categories = new Map<CheckCategory, Tally>();

  for (const check of checks) {
    if (check.status === 'not_applicable') continue;
    add(overall, check);
    let tally = categories.get(check.category);
    if (!tally) {
      tally = emptyTally();
      categories.set(check.category, tally);
    }
    add(tally, check);
  }

  const evaluatedWeight = overall.passWeight + overall.failWeight;
  const totalWeight = evaluatedWeight + overall.unknownWeight;
  const coverage = totalWeight > 0 ? evaluatedWeight / totalWeight : 1;
  const status: ScoreStatus =
    coverage >= 0.8 ? 'complete' : coverage >= 0.6 ? 'provisional' : 'insufficient_evidence';

  const value = status === 'insufficient_evidence' ? null : valueOf(overall);

  const byCategory: AuditScore['byCategory'] = {};
  for (const [category, tally] of categories) {
    byCategory[category] = { value: valueOf(tally), evaluated: tally.evaluated, total: tally.total };
  }

  return { value, grade: value === null ? null : gradeOf(value), coverage, status, byCategory };
}
