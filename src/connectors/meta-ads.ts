import { missingEnv } from '../core/env';
import { ACTION_KINDS } from '../core/types';
import type { Connector, ConnectorDeps } from '../core/types';
import { diagnoseMetaAds } from './meta-ads-diagnose';
import { fetchMetaAdsSnapshot } from './meta-ads-read';
import { applyMetaAdsAction, readMetaAdsState } from './meta-ads-write';

export function createMetaAdsConnector(deps: ConnectorDeps): Connector {
  return {
    platform: 'meta_ads',
    source: 'api',
    status: () => {
      const missing = missingEnv(deps.env, deps.account, ['META_ACCESS_TOKEN']);
      return {
        platform: 'meta_ads',
        accountId: deps.account.id,
        source: 'api',
        ready: missing.length === 0,
        missingEnv: missing,
        datasets: ['campaigns', 'ad_groups', 'ads', 'placements', 'daily'],
        actions: ACTION_KINDS.filter((kind) => kind.startsWith('meta_ads.')),
      };
    },
    fetchSnapshot: (request) => fetchMetaAdsSnapshot(deps, request),
    readState: (draft) => readMetaAdsState(deps, draft),
    apply: (action, options) => applyMetaAdsAction(deps, action, options),
    diagnose: () => diagnoseMetaAds(deps),
  };
}
