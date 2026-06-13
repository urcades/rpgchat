#!/usr/bin/env node
// Migration-drift guard. Fails if a target D1 database is missing any migration
// that exists locally in /migrations.
//
// This is the check that would have caught the blank-status-panel incident:
// migrations 0004-0007 were committed and deployed in the worker code, but never
// applied to the remote production DB. `npm test` could not see it (the test DB is
// always freshly migrated). This asks wrangler directly.
//
// Usage:
//   node scripts/check-migrations.mjs            # checks --remote (production)
//   node scripts/check-migrations.mjs --local    # checks the local dev DB
import { execSync } from 'node:child_process';

const target = process.argv.includes('--local') ? '--local' : '--remote';
console.log(`Checking D1 migration drift (${target})…`);

let out = '';
try {
  out = execSync(`npx wrangler d1 migrations list DB ${target}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
} catch (err) {
  // wrangler exits non-zero in some states but still prints the table we need.
  out = `${err.stdout || ''}${err.stderr || ''}`;
}

if (/No migrations to apply/i.test(out)) {
  console.log(`OK: ${target} D1 is up to date with /migrations.`);
  process.exit(0);
}

console.error(`\nDRIFT DETECTED: the ${target} D1 database is missing migrations.`);
console.error(`Apply them with:  npm run db:migrate:${target === '--local' ? 'local' : 'remote'}\n`);
console.error(out.trim());
process.exit(1);
