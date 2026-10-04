import { ACTION_KINDS } from '../core/types';
import type { Connector, ConnectorDeps, DatasetName } from '../core/types';
import { diagnoseGoogleAds } from './google-ads-diagnose';
import { fetchGoogleAdsSnapshot } from './google-ads-read';
import { applyGoogleAdsAction, readGoogleAdsState } from './google-ads-write';
import { googleAuthMissing } from './google-auth';

const DATASETS: DatasetName[] = [
  'campaigns',
  'ad_groups',
  'ads',
  'keywords',
  'search_terms',
  'devices',
  'daily',
  'conversion_actions',
];

export function createGoogleAdsConnector(deps: ConnectorDeps): Connector {
  return {
    platform: 'google_ads',
    source: 'api',
    status: () => {
      const missingEnv = googleAuthMissing(deps.env, deps.account);
      return {
        platform: 'google_ads',
        accountId: deps.account.id,
        source: 'api',
        ready: missingEnv.length === 0,
        missingEnv,
        datasets: [...DATASETS],
        actions: ACTION_KINDS.filter((kind) => kind.startsWith('google_ads.')),
      };
    },
    fetchSnapshot: (request) => fetchGoogleAdsSnapshot(deps, request),
    readState: (draft) => readGoogleAdsState(deps, draft),
    apply: (action, options) => applyGoogleAdsAction(deps, action, options),
    diagnose: () => diagnoseGoogleAds(deps),
  };
}
