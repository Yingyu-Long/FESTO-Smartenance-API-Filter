import { spawn } from "node:child_process";
import { getIncidentStore } from "../festo/database.ts";
import { detectPythonBridge, readHermesConfig } from "./config.ts";
import {
  IncidentService,
  resolveSmartenanceAccountKey,
  type SnapshotStore,
} from "./incident-service.ts";

export interface HermesToolDefinition {
  name: string;
  category: "smartenance";
  description: string;
  parameters: Record<string, unknown>;
}

export const HERMES_TOOLS: HermesToolDefinition[] = [
  {
    name: "list_smartenance_accounts",
    category: "smartenance",
    description:
      "List all synced Smartenance accounts in PostgreSQL with machine counts, stored incident counts, and latest sync timestamps.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_factory_overview",
    category: "smartenance",
    description:
      "Get a factory-wide Smartenance snapshot overview: total machines, active vs closed incidents, incident breakdown by state, snapshot completeness, sync timestamps, and top machines with active incidents.",
    parameters: {
      type: "object",
      properties: {
        machine_limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum top machines to return (default 10).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_factory_incident_summary",
    category: "smartenance",
    description:
      "Analyze factory incident trends over a time window (provide either lookback_days OR ISO-8601 start_date/end_date, never both) grouped by day, week, or month, with state breakdown and top affected machines.",
    parameters: {
      type: "object",
      properties: {
        lookback_days: {
          type: "integer",
          minimum: 1,
          maximum: 36500,
          description: "Number of past days from now to summarize (mutually exclusive with start_date/end_date).",
        },
        start_date: {
          type: "string",
          description: "Inclusive ISO-8601 start date or timestamp (e.g. 2026-10-01).",
        },
        end_date: {
          type: "string",
          description: "Exclusive ISO-8601 end date or timestamp (defaults to now).",
        },
        granularity: {
          type: "string",
          enum: ["day", "week", "month"],
          description: "Trend grouping bucket (default month).",
        },
        machine_limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum top affected machines to return (default 20).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_employee_work_hours",
    category: "smartenance",
    description:
      "Summarize recorded repair-task labor hours (维修工时) by assigned staff (维修负责人 and 协作人员) for a calendar month in Asia/Shanghai (YYYY-MM; defaults to previous calendar month), flagging missing or unattributed hours.",
    parameters: {
      type: "object",
      properties: {
        month: {
          type: "string",
          description: "Target calendar month in YYYY-MM format (optional; omit for previous month).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_machines",
    category: "smartenance",
    description:
      "Search or list Smartenance machines in PostgreSQL by UUID, machine name, or machine number, returning incident and active incident counts.",
    parameters: {
      type: "object",
      properties: {
        search: {
          type: "string",
          description: "Optional case-insensitive substring to match machine name, number, or UUID.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Page size (default 100).",
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Pagination offset (default 0).",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_machine_details",
    category: "smartenance",
    description:
      "Get full Smartenance machine metadata, stored incident count, and sync completeness by machine UUID, machine number, or exact machine name.",
    parameters: {
      type: "object",
      properties: {
        machine_id: {
          type: "string",
          description: "Machine UUID, machine number, or exact machine name.",
        },
      },
      required: ["machine_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_machine_statistics",
    category: "smartenance",
    description:
      "Get incident statistics for every machine in the account (total, active, closed, and recent 90-day incidents), ranked by total and active incident volume.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_machine_incident_history",
    category: "smartenance",
    description:
      "Get chronological incident history (newest first) for a specific machine, optionally filtered by state (e.g. Open, InWork, Closed).",
    parameters: {
      type: "object",
      properties: {
        machine_id: {
          type: "string",
          description: "Machine UUID, machine number, or exact machine name.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Maximum incidents to return (default 100).",
        },
        state: {
          type: "string",
          description: "Optional incident state filter (e.g. Open, InWork, Closed).",
        },
      },
      required: ["machine_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_machine_maintenance_history",
    category: "smartenance",
    description:
      "Get chronological repair task / maintenance history (newest first) for a specific machine across all of its incidents.",
    parameters: {
      type: "object",
      properties: {
        machine_id: {
          type: "string",
          description: "Machine UUID, machine number, or exact machine name.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Maximum repair tasks to return (default 100).",
        },
      },
      required: ["machine_id"],
      additionalProperties: false,
    },
  },
  {
    name: "compare_machines",
    category: "smartenance",
    description:
      "Compare 2 to 20 machines side-by-side by health score, risk level, active incidents, and recent 90-day incidents, identifying the least healthy machine.",
    parameters: {
      type: "object",
      properties: {
        machine_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 20,
          description: "List of 2 to 20 unique machine UUIDs, numbers, or names.",
        },
      },
      required: ["machine_ids"],
      additionalProperties: false,
    },
  },
  {
    name: "get_machine_health_score",
    category: "smartenance",
    description:
      "Compute the health score (0-100) and risk level (low/medium/high) for a single machine based on active incidents and recent 90-day incident frequency.",
    parameters: {
      type: "object",
      properties: {
        machine_id: {
          type: "string",
          description: "Machine UUID, machine number, or exact machine name.",
        },
      },
      required: ["machine_id"],
      additionalProperties: false,
    },
  },
  {
    name: "get_machine_risk_ranking",
    category: "smartenance",
    description:
      "Rank machines across the factory from highest risk (lowest health score) to healthiest based on active incidents and recent 90-day incidents.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum ranked machines to return (default 20).",
        },
      },
      additionalProperties: false,
    },
  },
];

function optInt(value: unknown, fallback?: number): number | undefined {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`Expected an integer, got ${JSON.stringify(value)}`);
  }
  return n;
}

function optStr(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s || undefined;
}

function reqStr(args: Record<string, unknown>, key: string): string {
  const val = optStr(args[key]);
  if (!val) throw new Error(`${key} is required`);
  return val;
}

async function runViaPythonBridge(
  pythonPath: string,
  accountKey: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(pythonPath, ["-m", "backend.tool_runner"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SMARTENANCE_ACCOUNT_KEY: accountKey,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(stderr.trim() || `Python tool_runner exited with code ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as { result: unknown };
        resolvePromise(parsed.result);
      } catch (err) {
        rejectPromise(err);
      }
    });
    child.stdin.end(JSON.stringify({ tool, arguments: args }));
  });
}

export async function executeHermesTool(
  tool: string,
  rawArgs: unknown = {},
  options: { store?: SnapshotStore; accountKey?: string } = {},
): Promise<unknown> {
  const args =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};

  const store = options.store ?? getIncidentStore();
  const preferredAccount =
    options.accountKey ?? (await readHermesConfig(store)).smartenanceAccountKey;
  const { accountKey, accounts } = await resolveSmartenanceAccountKey(store, preferredAccount);

  if (tool === "list_smartenance_accounts") {
    return {
      count: accounts.length,
      selected_account_key: accountKey || null,
      accounts,
    };
  }

  if (process.env.HERMES_TOOL_RUNNER === "python" && accountKey) {
    const bridge = detectPythonBridge();
    if (bridge.bridgeExists && bridge.usingVenv) {
      return runViaPythonBridge(bridge.pythonPath, accountKey, tool, args);
    }
  }

  const service = new IncidentService(store, accountKey);

  switch (tool) {
    case "get_factory_overview":
      return service.getFactoryOverview(optInt(args.machine_limit, 10));
    case "get_factory_incident_summary":
      return service.getFactoryIncidentSummary(
        optInt(args.lookback_days),
        optStr(args.start_date) ?? null,
        optStr(args.end_date) ?? null,
        optStr(args.granularity) ?? "month",
        optInt(args.machine_limit, 20),
      );
    case "get_employee_work_hours":
      return service.getEmployeeWorkHours(optStr(args.month) ?? null);
    case "get_machines":
      return service.getMachines(
        optStr(args.search) ?? null,
        optInt(args.limit, 100),
        optInt(args.offset, 0),
      );
    case "get_machine_details":
      return service.getMachineDetails(reqStr(args, "machine_id"));
    case "get_machine_statistics":
      return service.getMachineStatistics();
    case "get_machine_incident_history":
      return service.getMachineIncidentHistory(
        reqStr(args, "machine_id"),
        optInt(args.limit, 100),
        optStr(args.state) ?? null,
      );
    case "get_machine_maintenance_history":
      return service.getMachineMaintenanceHistory(
        reqStr(args, "machine_id"),
        optInt(args.limit, 100),
      );
    case "compare_machines": {
      if (!Array.isArray(args.machine_ids)) {
        throw new Error("machine_ids must be an array of strings");
      }
      return service.compareMachines(args.machine_ids.map((item) => String(item)));
    }
    case "get_machine_health_score":
      return service.getMachineHealthScore(reqStr(args, "machine_id"));
    case "get_machine_risk_ranking":
      return service.getMachineRiskRanking(optInt(args.limit, 20));
    default:
      throw new Error(`Unknown Smartenance tool: ${tool}`);
  }
}
