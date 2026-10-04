import type { CheckDefinition } from '../../core/types';
import { googleAdsEfficiencyChecks } from './google-ads-efficiency';
import { googleAdsStructureChecks } from './google-ads-structure';

export const googleAdsChecks: CheckDefinition[] = [...googleAdsEfficiencyChecks, ...googleAdsStructureChecks];
