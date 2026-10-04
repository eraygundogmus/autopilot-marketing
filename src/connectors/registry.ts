import { toAutopilotError } from '../core/errors';
import type { AccountConfig, AutopilotConfig, Connector, ConnectorDeps, ConnectorStatus } from '../core/types';
import { createDemoConnector } from './demo';
import { createGa4Connector } from './ga4';
import { createGoogleAdsConnector } from './google-ads';
import { createMauticConnector } from './mautic';
import { createMetaAdsConnector } from './meta-ads';
import { createSearchConsoleConnector } from './search-console';

/** The demo connector when `account.source` is 'demo', else the platform's API connector. */
export function createConnector(account: AccountConfig, deps: Omit<ConnectorDeps, 'account'>): Connector {
  const full: ConnectorDeps = { ...deps, account };
  if (account.source === 'demo') return createDemoConnector(full);
  switch (account.platform) {
    case 'google_ads':
      return createGoogleAdsConnector(full);
    case 'meta_ads':
      return createMetaAdsConnector(full);
    case 'ga4':
      return createGa4Connector(full);
    case 'search_console':
      return createSearchConsoleConnector(full);
    case 'mautic':
      return createMauticConnector(full);
  }
}

export function connectorStatuses(config: AutopilotConfig, deps: Omit<ConnectorDeps, 'account'>): ConnectorStatus[] {
  return config.accounts.map((account) => {
    try {
      return createConnector(account, deps).status();
    } catch (error) {
      return {
        platform: account.platform,
        accountId: account.id,
        source: account.source ?? 'api',
        ready: false,
        missingEnv: [],
        datasets: [],
        actions: [],
        note: toAutopilotError(error).message,
      };
    }
  });
}
