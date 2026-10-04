import { ACTION_KINDS } from '../core/types';
import type { Connector, ConnectorDeps } from '../core/types';
import { fetchMauticSnapshot, mauticAuthMissing } from './mautic-read';
import { applyMauticAction, readMauticState } from './mautic-write';
import { diagnoseMautic } from './other-diagnose';

export function createMauticConnector(deps: ConnectorDeps): Connector {
  return {
    platform: 'mautic',
    source: 'api',
    status: () => {
      const missingEnv = mauticAuthMissing(deps);
      return {
        platform: 'mautic',
        accountId: deps.account.id,
        source: 'api',
        ready: missingEnv.length === 0,
        missingEnv,
        datasets: ['segments', 'emails', 'lifecycle_campaigns'],
        actions: ACTION_KINDS.filter((kind) => kind.startsWith('mautic.')),
        ...(missingEnv.length === 0
          ? {}
          : { note: 'Alternatively set MAUTIC_USERNAME and MAUTIC_PASSWORD for Basic auth.' }),
      };
    },
    fetchSnapshot: (request) => fetchMauticSnapshot(deps, request),
    readState: (draft) => readMauticState(deps, draft),
    apply: (action, options) => applyMauticAction(deps, action, options),
    diagnose: () => diagnoseMautic(deps),
  };
}
