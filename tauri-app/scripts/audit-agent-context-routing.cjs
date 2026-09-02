#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_DB_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'com.agentree.agentree',
  'telemetry.db'
);

function parseArgs(argv) {
  const args = {
    dbPath: process.env.AGENTREE_TELEMETRY_DB || DEFAULT_DB_PATH,
    days: null,
    limit: 25,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];
    if ((token === '--db' || token === '--db-path') && next) {
      args.dbPath = next;
      i += 1;
    } else if (token === '--days' && next) {
      args.days = Number(next);
      i += 1;
    } else if (token === '--limit' && next) {
      args.limit = Math.max(1, Number(next) || args.limit);
      i += 1;
    } else if (token === '--json') {
      args.json = true;
    } else if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node tauri-app/scripts/audit-agent-context-routing.cjs [options]

Options:
  --db <path>       SQLite telemetry.db path. Defaults to local Agentree app data.
  --days <n>        Only include assistant nodes created in the last n days.
  --limit <n>       Number of suspicious/detail rows to print. Default: 25.
  --json           Print raw JSON instead of readable tables.

Environment:
  AGENTREE_TELEMETRY_DB can override the default DB path.
`);
}

function whereClause(args) {
  if (!Number.isFinite(args.days) || args.days <= 0) {
    return '';
  }
  const since = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000).toISOString();
  return `AND n.created_at >= '${since.replace(/'/g, "''")}'`;
}

function pct(value) {
  if (value == null || Number.isNaN(Number(value))) return '-';
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function num(value, digits = 1) {
  if (value == null || Number.isNaN(Number(value))) return '-';
  return Number(value).toFixed(digits);
}

function printTable(title, rows, columns) {
  console.log(`\n${title}`);
  if (!rows.length) {
    console.log('(no rows)');
    return;
  }

  const widths = columns.map((column) => Math.max(
    column.label.length,
    ...rows.map((row) => String(column.format ? column.format(row[column.key], row) : row[column.key] ?? '').length)
  ));

  const line = columns.map((column, index) => column.label.padEnd(widths[index])).join('  ');
  console.log(line);
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) {
    console.log(columns.map((column, index) => {
      const value = column.format ? column.format(row[column.key], row) : row[column.key] ?? '';
      return String(value).padEnd(widths[index]);
    }).join('  '));
  }
}

function assertDb(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`telemetry DB not found: ${dbPath}`);
  }
}

function runSqlJson(dbPath, sql) {
  const output = execFileSync('sqlite3', ['-readonly', '-json', dbPath, sql], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  }).trim();
  return output ? JSON.parse(output) : [];
}

function queryOne(dbPath, sql) {
  return runSqlJson(dbPath, sql)[0] || {};
}

function limitSql(limit) {
  return Math.max(1, Number(limit) || 25);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  assertDb(args.dbPath);
  const filter = whereClause(args);
  const limit = limitSql(args.limit);

  const totals = queryOne(args.dbPath, `
    SELECT
      COUNT(*) AS assistant_nodes,
      COUNT(n.thread_id) AS with_thread_id,
      COUNT(DISTINCT n.thread_id) AS distinct_agentree_threads,
      SUM(CASE WHEN json_extract(n.execution_data_json, '$.meta.provider_thread_id') IS NOT NULL THEN 1 ELSE 0 END) AS nodes_with_provider_thread_meta,
      SUM(CASE WHEN COALESCE(json_extract(n.execution_data_json, '$.meta.agentree_context_injected_estimated_tokens'), 0) > 0 THEN 1 ELSE 0 END) AS nodes_with_injected_context
    FROM local_nodes n
    WHERE n.role = 'assistant'
      ${filter}
  `);

  const byStrategy = runSqlJson(args.dbPath, `
    WITH latest_meta AS (
      SELECT * FROM (
        SELECT
          assistant_node_id,
          json_extract(payload, '$.meta.provider') AS provider,
          json_extract(payload, '$.meta.provider_thread_strategy') AS strategy,
          ROW_NUMBER() OVER (PARTITION BY assistant_node_id ORDER BY timestamp DESC, seq DESC) AS rn
        FROM agent_run_events
        WHERE event_type = 'provider_meta'
          AND (
            json_extract(payload, '$.meta.provider_thread_strategy') IS NOT NULL
            OR json_extract(payload, '$.meta.provider_thread_id') IS NOT NULL
          )
      )
      WHERE rn = 1
    ),
    latest_usage AS (
      SELECT * FROM (
        SELECT
          assistant_node_id,
          json_extract(payload, '$.usage.input_tokens') AS input_tokens,
          json_extract(payload, '$.usage.cached_input_tokens') AS cached_input_tokens,
          ROW_NUMBER() OVER (PARTITION BY assistant_node_id ORDER BY timestamp DESC, seq DESC) AS rn
        FROM agent_run_events
        WHERE event_type = 'usage'
      )
      WHERE rn = 1
    )
    SELECT
      COALESCE(m.provider, json_extract(n.execution_data_json, '$.meta.provider'), 'unknown') AS provider,
      COALESCE(m.strategy, json_extract(n.execution_data_json, '$.meta.provider_thread_strategy'), 'missing') AS strategy,
      COUNT(*) AS runs,
      AVG(u.input_tokens) AS avg_input_tokens,
      AVG(u.cached_input_tokens) AS avg_cached_input_tokens,
      AVG(1.0 * u.cached_input_tokens / NULLIF(u.input_tokens, 0)) AS avg_cache_hit_ratio,
      MIN(1.0 * u.cached_input_tokens / NULLIF(u.input_tokens, 0)) AS min_cache_hit_ratio,
      MAX(1.0 * u.cached_input_tokens / NULLIF(u.input_tokens, 0)) AS max_cache_hit_ratio,
      AVG(COALESCE(json_extract(n.execution_data_json, '$.meta.agentree_context_injected_estimated_tokens'), 0)) AS avg_injected_est_tokens
    FROM local_nodes n
    LEFT JOIN latest_meta m ON m.assistant_node_id = n.id
    LEFT JOIN latest_usage u ON u.assistant_node_id = n.id
    WHERE n.role = 'assistant'
      ${filter}
    GROUP BY 1, 2
    ORDER BY runs DESC
  `);

  const byRoutingReason = runSqlJson(args.dbPath, `
    WITH latest_usage AS (
      SELECT * FROM (
        SELECT
          assistant_node_id,
          json_extract(payload, '$.usage.input_tokens') AS input_tokens,
          json_extract(payload, '$.usage.cached_input_tokens') AS cached_input_tokens,
          ROW_NUMBER() OVER (PARTITION BY assistant_node_id ORDER BY timestamp DESC, seq DESC) AS rn
        FROM agent_run_events
        WHERE event_type = 'usage'
      )
      WHERE rn = 1
    )
    SELECT
      COALESCE(json_extract(n.execution_data_json, '$.meta.provider_context_routing_reason'), '<missing>') AS routing_reason,
      COALESCE(json_extract(n.execution_data_json, '$.meta.provider_context_routing_mode'), '<missing>') AS routing_mode,
      COUNT(*) AS runs,
      AVG(u.input_tokens) AS avg_input_tokens,
      AVG(u.cached_input_tokens) AS avg_cached_input_tokens,
      AVG(1.0 * u.cached_input_tokens / NULLIF(u.input_tokens, 0)) AS avg_cache_hit_ratio,
      AVG(COALESCE(json_extract(n.execution_data_json, '$.meta.agentree_context_injected_estimated_tokens'), 0)) AS avg_injected_est_tokens,
      MIN(n.created_at) AS first_created,
      MAX(n.created_at) AS last_created
    FROM local_nodes n
    LEFT JOIN latest_usage u ON u.assistant_node_id = n.id
    WHERE n.role = 'assistant'
      ${filter}
    GROUP BY 1, 2
    ORDER BY runs DESC
  `);

  const suspiciousThreads = runSqlJson(args.dbPath, `
    WITH latest_meta AS (
      SELECT * FROM (
        SELECT
          assistant_node_id,
          json_extract(payload, '$.meta.provider_thread_strategy') AS strategy,
          json_extract(payload, '$.meta.provider_thread_id') AS provider_thread_id,
          ROW_NUMBER() OVER (PARTITION BY assistant_node_id ORDER BY timestamp DESC, seq DESC) AS rn
        FROM agent_run_events
        WHERE event_type = 'provider_meta'
          AND (
            json_extract(payload, '$.meta.provider_thread_strategy') IS NOT NULL
            OR json_extract(payload, '$.meta.provider_thread_id') IS NOT NULL
          )
      )
      WHERE rn = 1
    )
    SELECT
      n.thread_id,
      COUNT(*) AS assistant_runs,
      SUM(CASE WHEN COALESCE(m.strategy, json_extract(n.execution_data_json, '$.meta.provider_thread_strategy')) = 'resume' THEN 1 ELSE 0 END) AS resumes,
      SUM(CASE WHEN COALESCE(m.strategy, json_extract(n.execution_data_json, '$.meta.provider_thread_strategy')) = 'fresh_thread' THEN 1 ELSE 0 END) AS fresh_threads,
      SUM(CASE WHEN COALESCE(m.strategy, json_extract(n.execution_data_json, '$.meta.provider_thread_strategy')) IN ('fork', 'fork_then_rollback') THEN 1 ELSE 0 END) AS forks,
      COUNT(DISTINCT COALESCE(m.provider_thread_id, json_extract(n.execution_data_json, '$.meta.provider_thread_id'))) AS distinct_provider_threads,
      MAX(n.created_at) AS last_created
    FROM local_nodes n
    LEFT JOIN latest_meta m ON m.assistant_node_id = n.id
    WHERE n.role = 'assistant'
      AND n.thread_id IS NOT NULL
      ${filter}
    GROUP BY n.thread_id
    HAVING assistant_runs >= 3
      AND distinct_provider_threads >= assistant_runs - 1
      AND fresh_threads > resumes + forks
    ORDER BY assistant_runs DESC, distinct_provider_threads DESC
    LIMIT ${limit}
  `);

  const suspiciousFreshRuns = runSqlJson(args.dbPath, `
    WITH latest_meta AS (
      SELECT * FROM (
        SELECT
          assistant_node_id,
          json_extract(payload, '$.meta.provider_thread_strategy') AS strategy,
          ROW_NUMBER() OVER (PARTITION BY assistant_node_id ORDER BY timestamp DESC, seq DESC) AS rn
        FROM agent_run_events
        WHERE event_type = 'provider_meta'
          AND json_extract(payload, '$.meta.provider_thread_strategy') IS NOT NULL
      )
      WHERE rn = 1
    ),
    latest_usage AS (
      SELECT * FROM (
        SELECT
          assistant_node_id,
          json_extract(payload, '$.usage.input_tokens') AS input_tokens,
          json_extract(payload, '$.usage.cached_input_tokens') AS cached_input_tokens,
          ROW_NUMBER() OVER (PARTITION BY assistant_node_id ORDER BY timestamp DESC, seq DESC) AS rn
        FROM agent_run_events
        WHERE event_type = 'usage'
      )
      WHERE rn = 1
    )
    SELECT
      n.id,
      n.created_at,
      n.thread_id,
      COALESCE(json_extract(n.execution_data_json, '$.meta.provider_context_routing_reason'), '<missing>') AS routing_reason,
      COALESCE(json_extract(n.execution_data_json, '$.context_profile.context_parent_node_id'), n.parent_id) AS context_parent,
      json_extract(parent.execution_data_json, '$.meta.provider_thread_id') AS parent_provider_thread_id,
      json_extract(parent.execution_data_json, '$.meta.provider_turn_id') AS parent_provider_turn_id,
      json_extract(parent.execution_data_json, '$.meta.provider_user_turn_count') AS parent_user_turn_count,
      u.input_tokens,
      u.cached_input_tokens,
      1.0 * u.cached_input_tokens / NULLIF(u.input_tokens, 0) AS cache_hit_ratio
    FROM local_nodes n
    JOIN latest_meta m ON m.assistant_node_id = n.id
    LEFT JOIN latest_usage u ON u.assistant_node_id = n.id
    LEFT JOIN local_nodes parent ON parent.id = COALESCE(json_extract(n.execution_data_json, '$.context_profile.context_parent_node_id'), n.parent_id)
    WHERE n.role = 'assistant'
      AND m.strategy = 'fresh_thread'
      AND json_extract(parent.execution_data_json, '$.meta.provider_thread_id') IS NOT NULL
      ${filter}
    ORDER BY n.created_at DESC
    LIMIT ${limit}
  `);

  const payload = {
    generatedAt: new Date().toISOString(),
    dbPath: args.dbPath,
    filters: { days: args.days, limit: args.limit },
    totals,
    byStrategy,
    byRoutingReason,
    suspiciousThreads,
    suspiciousFreshRuns,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log('Agentree Context Routing Audit');
  console.log(`DB: ${args.dbPath}`);
  if (args.days) console.log(`Window: last ${args.days} days`);
  console.log(`Generated: ${payload.generatedAt}`);

  printTable('Totals', [totals], [
    { key: 'assistant_nodes', label: 'assistant_nodes' },
    { key: 'with_thread_id', label: 'with_thread_id' },
    { key: 'distinct_agentree_threads', label: 'agentree_threads' },
    { key: 'nodes_with_provider_thread_meta', label: 'provider_thread_meta' },
    { key: 'nodes_with_injected_context', label: 'injected_context' },
  ]);

  printTable('By Provider Strategy', byStrategy, [
    { key: 'provider', label: 'provider' },
    { key: 'strategy', label: 'strategy' },
    { key: 'runs', label: 'runs' },
    { key: 'avg_input_tokens', label: 'avg_input', format: (value) => num(value) },
    { key: 'avg_cached_input_tokens', label: 'avg_cached', format: (value) => num(value) },
    { key: 'avg_cache_hit_ratio', label: 'avg_hit', format: (value) => pct(value) },
    { key: 'min_cache_hit_ratio', label: 'min_hit', format: (value) => pct(value) },
    { key: 'max_cache_hit_ratio', label: 'max_hit', format: (value) => pct(value) },
    { key: 'avg_injected_est_tokens', label: 'avg_injected', format: (value) => num(value) },
  ]);

  printTable('By Routing Reason', byRoutingReason, [
    { key: 'routing_reason', label: 'routing_reason' },
    { key: 'routing_mode', label: 'routing_mode' },
    { key: 'runs', label: 'runs' },
    { key: 'avg_input_tokens', label: 'avg_input', format: (value) => num(value) },
    { key: 'avg_cached_input_tokens', label: 'avg_cached', format: (value) => num(value) },
    { key: 'avg_cache_hit_ratio', label: 'avg_hit', format: (value) => pct(value) },
    { key: 'avg_injected_est_tokens', label: 'avg_injected', format: (value) => num(value) },
    { key: 'last_created', label: 'last_created' },
  ]);

  printTable('Suspicious Agentree Threads', suspiciousThreads, [
    { key: 'thread_id', label: 'thread_id' },
    { key: 'assistant_runs', label: 'runs' },
    { key: 'resumes', label: 'resumes' },
    { key: 'fresh_threads', label: 'fresh' },
    { key: 'forks', label: 'forks' },
    { key: 'distinct_provider_threads', label: 'provider_threads' },
    { key: 'last_created', label: 'last_created' },
  ]);

  printTable('Fresh Threads With Provider-Capable Parent', suspiciousFreshRuns, [
    { key: 'id', label: 'node_id' },
    { key: 'created_at', label: 'created_at' },
    { key: 'thread_id', label: 'thread_id' },
    { key: 'routing_reason', label: 'routing_reason' },
    { key: 'parent_provider_thread_id', label: 'parent_provider_thread' },
    { key: 'parent_user_turn_count', label: 'parent_turns' },
    { key: 'input_tokens', label: 'input', format: (value) => num(value, 0) },
    { key: 'cached_input_tokens', label: 'cached', format: (value) => num(value, 0) },
    { key: 'cache_hit_ratio', label: 'hit', format: (value) => pct(value) },
  ]);
}

try {
  main();
} catch (error) {
  console.error(`[audit-agent-context-routing] ${error.message}`);
  process.exit(1);
}
