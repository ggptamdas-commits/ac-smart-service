import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const worker = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const migration = await readFile(new URL('../migrations/0002_production_audit.sql', import.meta.url), 'utf8');
const dashboard = await readFile(new URL('../../dashboard/index.html', import.meta.url), 'utf8');

assert.match(migration, /CREATE TABLE IF NOT EXISTS webhook_logs/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS login_attempts/);
assert.match(migration, /ALTER TABLE service_requests ADD COLUMN source_message_id/);
assert.match(migration, /idx_reminder_logs_idempotency/);
assert.match(worker, /INSERT OR IGNORE INTO webhook_logs/);
assert.match(worker, /source_message_id/);
assert.match(worker, /sender, text, message_type, delivery_status\) VALUES \(\?, "admin"/);
assert.match(worker, /isAllowedStatusTransition/);
assert.match(worker, /allowedOrigins\.includes\(origin\)/);
assert.doesNotMatch(worker, /Access-Control-Allow-Origin.*\*/);
assert.doesNotMatch(worker, /provider_result: sendRes/);
assert.match(dashboard, /credentials: 'same-origin'/);
assert.match(dashboard, /Object\.entries\(configs \|\| \{\}\)/);

console.log('audit regressions: PASS');
