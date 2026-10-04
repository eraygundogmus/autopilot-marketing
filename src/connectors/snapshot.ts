import { digest, shortId } from '../core/ids';
import type { AccountConfig, DatasetCoverage, DatasetName, DateRange, Row, Snapshot, SourceKind } from '../core/types';

/**
 * Assembles a snapshot. A dataset without explicit coverage counts as complete: an empty result is
 * still a result. Connectors mark `partial` and `missing` themselves.
 */
export function buildSnapshot(input: {
  account: AccountConfig;
  source: SourceKind;
  dateRange: DateRange;
  currency: string;
  timezone: string;
  datasets: Partial<Record<DatasetName, Row[]>>;
  coverage?: Partial<Record<DatasetName, DatasetCoverage>>;
  warnings?: string[];
  conversionDefinition?: string;
  attribution?: string;
  now: Date;
}): Snapshot {
  const coverage: Partial<Record<DatasetName, DatasetCoverage>> = { ...input.coverage };
  for (const [name, rows] of Object.entries(input.datasets) as Array<[DatasetName, Row[]]>) {
    coverage[name] ??= { status: 'complete', rows: rows.length };
  }
  const contentHash = digest(input.datasets);
  return {
    id: shortId('snap', {
      platform: input.account.platform,
      accountId: input.account.id,
      source: input.source,
      dateRange: input.dateRange,
      contentHash,
    }),
    schemaVersion: 1,
    platform: input.account.platform,
    accountId: input.account.id,
    externalAccountId: input.account.externalId,
    source: input.source,
    currency: input.currency,
    timezone: input.timezone,
    dateRange: input.dateRange,
    createdAt: input.now.toISOString(),
    datasets: input.datasets,
    coverage,
    warnings: input.warnings ?? [],
    ...(input.conversionDefinition === undefined ? {} : { conversionDefinition: input.conversionDefinition }),
    ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
    contentHash,
  };
}
