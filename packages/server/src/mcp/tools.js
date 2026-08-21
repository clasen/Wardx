const PROJECT = {
  type: 'string',
  minLength: 1,
  description: 'Project name as mapped from a Wardx project key.'
};

const ROLE = {
  type: 'string',
  minLength: 1,
  description:
    'Open client role name declared by an SDK instance, for example unity, game-server, desktop, or mobile. Not *.'
};

const ROLES = {
  type: 'array',
  minItems: 1,
  items: { type: 'string', minLength: 1 },
  description:
    'Role names that receive this key or assign this experiment. Use ["*"] for every role that syncs.'
};

export const TOOL_DEFS = [
  {
    name: 'list_projects',
    description: 'List project names isolated on this ingest server.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_project_overview',
    description:
      'Project description, onboarding gaps, Remote Config knobs (each with the roles that receive them), telemetry and clients grouped by role, and previously proposed experiments. Each role may include optional path (local checkout) and git (repository URL). A predefined catalog can make onboarding.complete true. If it is false, ask only about the listed gaps and persist with set_project_description / set_role_description / set_signal before proposing experiments.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        limit: { type: 'integer', minimum: 1, description: 'Maximum counters and events to return, highest first.' }
      },
      required: ['project'],
      additionalProperties: false
    }
  },
  {
    name: 'set_project_description',
    description: 'Set the MCP-only project description. Does not bump configVersion. Clients never receive this.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        description: { type: 'string' }
      },
      required: ['project', 'description'],
      additionalProperties: false
    }
  },
  {
    name: 'set_role_description',
    description:
      'Set the MCP-only description for one client role in the project. Does not bump configVersion. Clients never receive this.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        role: ROLE,
        description: { type: 'string', minLength: 1 }
      },
      required: ['project', 'role', 'description'],
      additionalProperties: false
    }
  },
  {
    name: 'set_role_source',
    description:
      'Set optional source location for this role: path for a checkout on this machine, git for a repository URL. Provide one or both. Does not bump configVersion. Clients never receive this.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        role: ROLE,
        path: {
          type: 'string',
          minLength: 1,
          description: 'Filesystem path of this role\'s source on the machine running the agent.'
        },
        git: {
          type: 'string',
          minLength: 1,
          description: 'Git remote URL for this role\'s source, when it is not a local checkout.'
        }
      },
      required: ['project', 'role'],
      additionalProperties: false
    }
  },
  {
    name: 'set_signal',
    description:
      'Document one Remote Config key, metric, or event name. Does not bump configVersion. Clients never receive this.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        name: { type: 'string', minLength: 1 },
        description: { type: 'string', minLength: 1 }
      },
      required: ['project', 'name', 'description'],
      additionalProperties: false
    }
  },
  {
    name: 'delete_signal',
    description: 'Remove one catalog signal. Does not bump configVersion.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        name: { type: 'string', minLength: 1 }
      },
      required: ['project', 'name'],
      additionalProperties: false
    }
  },
  {
    name: 'get_config',
    description: 'Read the Remote Config snapshot for a project: version, values, experiments.',
    inputSchema: {
      type: 'object',
      properties: { project: PROJECT },
      required: ['project'],
      additionalProperties: false
    }
  },
  {
    name: 'set_config_value',
    description:
      'Set one Remote Config key and the roles that receive it. Bumps configVersion so those clients receive the snapshot on the next sync. roles is ["*"] or a list of role names.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        key: { type: 'string', minLength: 1 },
        value: {},
        roles: ROLES
      },
      required: ['project', 'key', 'value', 'roles'],
      additionalProperties: false
    }
  },
  {
    name: 'delete_config_value',
    description: 'Delete one Remote Config key. Bumps configVersion.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        key: { type: 'string', minLength: 1 }
      },
      required: ['project', 'key'],
      additionalProperties: false
    }
  },
  {
    name: 'list_experiments',
    description: 'List previously proposed experiment definitions for a project, including MCP-only hypothesis when set.',
    inputSchema: {
      type: 'object',
      properties: { project: PROJECT },
      required: ['project'],
      additionalProperties: false
    }
  },
  {
    name: 'upsert_experiment',
    description:
      'Propose or replace an experiment. experiment.roles lists which client roles assign it. variant.values may only contain Remote Config keys visible to those roles. Optional hypothesis stays on the server. Bumps configVersion.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        experiment: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1 },
            enabled: { type: 'boolean' },
            allocation: { type: 'number', minimum: 0, maximum: 1 },
            salt: { type: 'string', minLength: 1 },
            roles: ROLES,
            primaryMetric: { type: 'string', minLength: 1 },
            hypothesis: { type: 'string', minLength: 1 },
            variants: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string', minLength: 1 },
                  weight: { type: 'number', minimum: 0 },
                  values: { type: 'object' }
                },
                required: ['key', 'weight', 'values'],
                additionalProperties: false
              }
            }
          },
          required: ['id', 'enabled', 'allocation', 'salt', 'roles', 'variants'],
          additionalProperties: false
        }
      },
      required: ['project', 'experiment'],
      additionalProperties: false
    }
  },
  {
    name: 'set_experiment_enabled',
    description: 'Enable or disable an experiment. Bumps configVersion.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        id: { type: 'string', minLength: 1 },
        enabled: { type: 'boolean' }
      },
      required: ['project', 'id', 'enabled'],
      additionalProperties: false
    }
  },
  {
    name: 'get_aggregates',
    description:
      'Read 1-minute telemetry windows for a project, with catalog descriptions on names. Optional names, from, and to filter the payload.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        names: { type: 'array', items: { type: 'string' } },
        from: { type: 'number' },
        to: { type: 'number' },
        role: ROLE
      },
      required: ['project'],
      additionalProperties: false
    }
  },
  {
    name: 'get_recent_logs',
    description:
      'Recent log rows for a project, newest first. Drill from a series into a sample row. Optional level, message, attrs (exact match on listed keys), and limit.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
        message: { type: 'string', minLength: 1, description: 'Exact log message.' },
        attrs: {
          type: 'object',
          additionalProperties: { type: ['string', 'number', 'boolean'] },
          description: 'Exact match on these attr keys, for example { "code": "timeout" }.'
        },
        role: ROLE,
        limit: { type: 'integer', minimum: 1, description: 'Maximum rows to return, newest first.' }
      },
      required: ['project'],
      additionalProperties: false
    }
  },
  {
    name: 'analyze_experiment',
    description:
      'Previously proposed experiment plus exposure and goal counts by variant, primaryMetric total, and catalog legend.',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT,
        experimentId: { type: 'string', minLength: 1 }
      },
      required: ['project', 'experimentId'],
      additionalProperties: false
    }
  }
];

export function executeTool(control, name, args = {}) {
  switch (name) {
    case 'list_projects':
      return { projects: control.listProjects() };
    case 'get_project_overview':
      return control.getOverview(args.project, args.limit);
    case 'set_project_description':
      return control.setProjectDescription(args.project, args.description);
    case 'set_role_description':
      return control.setRoleDescription(args.project, args.role, args.description);
    case 'set_role_source':
      return control.setRoleSource(args.project, args.role, { path: args.path, git: args.git });
    case 'set_signal':
      return control.setSignal(args.project, args.name, args.description);
    case 'delete_signal':
      return control.deleteSignal(args.project, args.name);
    case 'get_config':
      return control.getConfig(args.project);
    case 'set_config_value':
      return control.setValue(args.project, args.key, args.value, args.roles);
    case 'delete_config_value':
      return control.deleteValue(args.project, args.key);
    case 'list_experiments':
      return { experiments: control.listExperiments(args.project) };
    case 'upsert_experiment':
      return control.upsertExperiment(args.project, args.experiment);
    case 'set_experiment_enabled':
      return control.setExperimentEnabled(args.project, args.id, args.enabled);
    case 'get_aggregates':
      return {
        windows: control.aggregates(args.project, {
          names: args.names,
          from: args.from,
          to: args.to,
          role: args.role
        })
      };
    case 'get_recent_logs':
      return {
        logs: control.recentLogs(args.project, {
          level: args.level,
          message: args.message,
          attrs: args.attrs,
          role: args.role,
          limit: args.limit
        })
      };
    case 'analyze_experiment':
      return control.analyzeExperiment(args.project, args.experimentId);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }]
  };
}

export function toolError(err) {
  return {
    isError: true,
    content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }]
  };
}
