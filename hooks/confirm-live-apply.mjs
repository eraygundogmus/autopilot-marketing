#!/usr/bin/env node
// PreToolUse hook for plan_apply. It asks the person to confirm a live run.
// It is an extra prompt, not the authorisation: the MCP server enforces
// policy and approval itself. Dry runs and unreadable input pass silently.
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw).tool_input;
  } catch {
    process.exit(0);
  }
  if (!input || input.dryRun !== false) process.exit(0);
  const planId = typeof input.planId === 'string' ? input.planId : 'unknown';
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: `This applies plan ${planId} to a live ad account. Continue only if you have reviewed the plan.`,
      },
    }) + '\n',
  );
  process.exit(0);
});
