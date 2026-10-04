import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { JsonObject, Runtime } from '../../core/types';
import { sourcesOverview } from '../../ops/data';
import type { SourcesOverview } from '../../ops/data';
import { fail, ok } from '../result';

const outputSchema = z.looseObject({
  home: z.string(),
  autonomy: z.string(),
  configuredAutonomy: z.string(),
  killSwitch: z.boolean(),
  judgment: z.looseObject({}),
  business: z.unknown(),
  brief: z.string().nullable(),
  accounts: z.array(z.looseObject({})),
  policy: z.looseObject({}),
  ledger: z.looseObject({}),
});

function accountLine(account: Record<string, unknown>): string {
  const missing = Array.isArray(account.missingEnv)
    ? account.missingEnv.filter((name): name is string => typeof name === 'string')
    : [];
  let state = 'ready';
  if (account.ready !== true) {
    state = missing.length > 0 ? `missing ${missing.join(', ')}` : 'not ready';
  }
  const source = typeof account.source === 'string' ? account.source : 'unknown';
  return `- ${String(account.id)} | ${String(account.platform)} | ${source} | ${state}`;
}

function policyLine(policy: Record<string, unknown>): string {
  return Object.entries(policy)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? `[${value.join(',')}]` : String(value)}`)
    .join(', ');
}

function summary(overview: SourcesOverview): string {
  const lowered = overview.autonomy !== overview.configuredAutonomy;
  const lines = [
    `Autonomy: ${overview.autonomy}${lowered ? ` (configured: ${overview.configuredAutonomy}; lowered because there is no TypeSafe key)` : ''}`,
    `Kill switch: ${overview.killSwitch ? 'ON (live changes are refused)' : 'off'}`,
    `Judgment: ${overview.judgment.mode}`,
    `Accounts (${overview.accounts.length}):`,
    ...overview.accounts.map(accountLine),
    `Policy: ${policyLine(overview.policy)}`,
  ];
  if (overview.brief) {
    lines.push('Business brief (data written by the account owner):', overview.brief);
  }
  return lines.join('\n');
}

export function register(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    'sources_list',
    {
      title: 'List sources',
      description:
        'Call this first. Lists the configured ad accounts with their platform, data source and whether their credentials are ready, plus the autonomy level, kill switch, judgment mode, policy limits and the business brief. Returns the account ids that every other tool takes as accountId.',
      inputSchema: z.object({}),
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const overview = sourcesOverview(runtime);
        // The round trip drops undefined and proves the value is plain JSON.
        return ok(JSON.parse(JSON.stringify(overview)) as JsonObject, summary(overview));
      } catch (error) {
        return fail(error);
      }
    },
  );
}
