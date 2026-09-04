import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { executeTool, TOOL_DEFS, toolError, toolResult } from './tools.js';
import { QueuedConcurrencyGate } from '../capacity/ConcurrencyGate.js';

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8')
);

const PROJECT_URI_PREFIX = 'wardx://project/';

export const MCP_INSTRUCTIONS = [
  'Wardx ingest control plane. HTTP POST /v1/sync is the only client path; this MCP interface reads telemetry and writes Remote Config and experiments.',
  'A project is one product. Each SDK instance declares a role, an open name such as backend, frontend, desktop, or unity. Different roles of the same project may emit similar names; series stay separate by role.',
  'Remote Config keys list the roles that receive them, or ["*"] for every role. Experiments list the roles that assign them. A sync only downloads keys and experiments visible to that instance\'s role.',
  'The SDK ships names with no descriptions. Meaning lives in the MCP catalog: a predefined catalog in the server config, or answers written during onboarding. Both are valid.',
  'Start with list_projects, then get_project_overview or read wardx://project/{name}. Overview knobs include roles. Overview.roles groups outcomes and clients by role name. path and git on a role are optional: path is a local checkout, git is a repository URL. Use them when present to edit that surface. Do not ask for them. Do not invent them.',
  'If onboarding.complete is true, skip questions and continue. If it is false, ask only about missingDescription, undescribedRoles, and the listed undescribed knobs and outcomes. Persist answers with set_project_description, set_role_description, and set_signal. Do not invent descriptions. Do not re-ask names that already have a description. Do not propose, enable, or interpret experiments until onboarding.complete is true.',
  'Knobs are existing Remote Config keys you may experiment on. Outcomes are metrics and events. Descriptions come from the project catalog.',
  'Use get_aggregates for current windows and bounded get_aggregate_history for closed hourly or daily baselines. Drill into bounded volatile samples with get_recent_events or get_recent_logs. get_recent_events contains only names explicitly allowed by catalog.inspectEvents. Those recent rows expose raw attrs and instance IDs; events outside the allowlist and all historical rows never contain raw attrs or instance IDs. Historical rows also exclude exemplars and subject hashes. If a role has path or git, use that checkout to inspect or edit the source. Wardx does not change application code.',
  'Overview histogram outcomes are ranked by max and include the exemplar of that max. Compare max to a numeric Remote Config cap. Then get_aggregates on the amount, count, and size names, and get_recent_logs with the anomaly message or exemplar attrs (grantId, source, reason). That is a fleet jump, not a player to punish. The wallet row lives in the application database.',
  'Every mutation requires the current expectedVersion and a non-empty reason. Use list_config_changes to inspect retained changes and rollback_config_change to create an auditable inverse version.',
  'Propose experiments with upsert_experiment. A closable experiment declares assignmentUnitKind, outcomeKind, control, targetSampleSizePerVariant, earliestAnalysisAt, familyWiseAlpha, minimumEffect, direction, terminalRetentionMs, and all evidence health thresholds before enablement. Analysis policy stays off the client wire.',
  'List and analyze experiments with list_experiments and analyze_experiment. Before both fixed horizons it is collecting. Terminal statuses are winner, no_difference, inconclusive, or invalid, and the first terminal result is durable. Only trusted deduplicated evidence is eligible; telemetryVariants keeps all provenance visible. ship_experiment requires a persisted healthy terminal winner plus expectedVersion and reason.',
  'Do not store secrets in Remote Config. Names prefixed wardx.internal. are SDK internals.'
].join(' ');

function projectUri(name) {
  return `${PROJECT_URI_PREFIX}${encodeURIComponent(name)}`;
}

function projectFromUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith(PROJECT_URI_PREFIX)) {
    throw new Error(`unknown resource: ${uri}`);
  }
  const name = decodeURIComponent(uri.slice(PROJECT_URI_PREFIX.length));
  if (!name) throw new Error(`unknown resource: ${uri}`);
  return name;
}

export function createMcpServer(control) {
  const readGate = new QueuedConcurrencyGate(
    control.config.control.maxConcurrentMcpReads,
    control.config.control.maxPendingMcpReads
  );
  const mutationTools = new Set([
    'set_project_description',
    'set_role_description',
    'set_role_source',
    'set_signal',
    'delete_signal',
    'set_persist_log',
    'delete_persist_log',
    'set_config_value',
    'delete_config_value',
    'upsert_experiment',
    'set_experiment_enabled',
    'rollback_config_change',
    'ship_experiment'
  ]);
  const withReadLease = async (work) => {
    const release = await readGate.acquire();
    try {
      return await work();
    } finally {
      release();
    }
  };
  const server = new Server(
    { name: 'wardx', version: pkg.version },
    { capabilities: { tools: {}, resources: {} }, instructions: MCP_INSTRUCTIONS }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const execute = () => executeTool(control, request.params.name, request.params.arguments || {});
      const result = mutationTools.has(request.params.name) ? await execute() : await withReadLease(execute);
      return toolResult(result);
    } catch (err) {
      return toolError(err);
    }
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: control.listProjects().map((name) => {
      const description = control.getCatalog(name).description;
      return {
        uri: projectUri(name),
        name,
        mimeType: 'application/json',
        description:
          description.length > 0
            ? description
            : `Remote Config knobs, outcomes, and previously proposed experiments for ${name}`
      };
    })
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try {
      return await withReadLease(() => {
        const project = projectFromUri(request.params.uri);
        const overview = control.getOverview(project);
        return {
          contents: [
            {
              uri: request.params.uri,
              mimeType: 'application/json',
              text: JSON.stringify(overview)
            }
          ]
        };
      });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
  });
  return server;
}

export async function startMcpStdio(control) {
  const server = createMcpServer(control);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
