import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { LEDGER_EVENTS } from '../../core/types';
import type { JsonObject, LedgerEntry, LedgerFilter, Runtime } from '../../core/types';
import { fail, ok } from '../result';

const DEFAULT_LIMIT = 50;

const inputSchema = z.object({
  accountId: z.string().min(1).optional().describe('Only entries for this account id (from sources_list).'),
  planId: z.string().min(1).optional().describe('Only entries for this plan id.'),
  events: z
    .array(z.enum(LEDGER_EVENTS))
    .optional()
    .describe('Only these event types, for example ["action.applied", "action.failed"].'),
  since: z.iso
    .datetime({ offset: true })
    .optional()
    .describe('ISO 8601 timestamp; only entries at or after it.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(`Largest number of entries to return, newest first (1 to 500, default ${DEFAULT_LIMIT}).`),
});

const outputSchema = z.looseObject({
  entries: z.array(z.looseObject({})),
  integrity: z.looseObject({ ok: z.boolean(), entries: z.number(), brokenAt: z.number().nullable() }),
});

function entryLine(entry: LedgerEntry): string {
  return `#${entry.seq} ${entry.ts} ${entry.event} plan=${entry.planId ?? '-'} action=${entry.actionId ?? '-'}`;
}

export function register(server: McpServer, runtime: Runtime): void {
  server.registerTool(
    'ledger_list',
    {
      title: 'List ledger entries',
      description:
        'Reads the append-only audit ledger: snapshots, audits, plans, approvals and every applied, failed or unknown action. Use it to check what actually happened to a plan or an account. Returns the newest matching entries and whether the hash chain is intact.',
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const filter: LedgerFilter = { limit: args.limit ?? DEFAULT_LIMIT };
        if (args.accountId !== undefined) filter.accountId = args.accountId;
        if (args.planId !== undefined) filter.planId = args.planId;
        if (args.events !== undefined) filter.events = args.events;
        if (args.since !== undefined) filter.since = args.since;
        const entries = runtime.ledger.read(filter);
        const integrity = runtime.ledger.verify();
        const integrityLine = integrity.ok
          ? `Integrity: ok (${integrity.entries} entries)`
          : `Integrity: BROKEN at seq ${String(integrity.brokenAt)} (${integrity.entries} entries)`;
        const text = [
          entries.length > 0 ? entries.map(entryLine).join('\n') : 'No matching ledger entries.',
          integrityLine,
        ].join('\n');
        return ok(JSON.parse(JSON.stringify({ entries, integrity })) as JsonObject, text);
      } catch (error) {
        return fail(error);
      }
    },
  );
}
