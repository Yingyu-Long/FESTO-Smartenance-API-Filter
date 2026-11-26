"""JSON stdin/stdout entry point for the native OpenClaw plugin."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from backend.database.db import account_key, open_pool
from backend.services.incident_service import IncidentService

env_file = os.getenv("SMARTENANCE_ENV_FILE")
if env_file:
    load_dotenv(env_file)
else:
    project_dir = Path(__file__).resolve().parents[1]
    default_env_file = project_dir / ".env"
    if not default_env_file.is_file():
        default_env_file = project_dir / ".env.example"
    load_dotenv(default_env_file)


async def _run(tool: str, arguments: dict[str, Any]) -> Any:
    account = account_key()
    pool = await open_pool()
    try:
        service = IncidentService(pool, account)
        if tool == "get_machines":
            return await service.get_machines(
                arguments.get("search"),
                arguments.get("limit", 100),
                arguments.get("offset", 0),
            )
        if tool == "get_machine_details":
            return await service.get_machine_details(arguments["machine_id"])
        if tool == "get_machine_statistics":
            return await service.get_machine_statistics()
        if tool == "get_machine_incident_history":
            return await service.get_machine_incident_history(
                arguments["machine_id"],
                arguments.get("limit", 100),
                arguments.get("state"),
            )
        if tool == "get_machine_maintenance_history":
            return await service.get_machine_maintenance_history(
                arguments["machine_id"], arguments.get("limit", 100)
            )
        if tool == "compare_machines":
            return await service.compare_machines(arguments["machine_ids"])
        if tool == "get_machine_health_score":
            return await service.get_machine_health_score(arguments["machine_id"])
        if tool == "get_machine_risk_ranking":
            return await service.get_machine_risk_ranking(arguments.get("limit", 20))
        if tool == "get_factory_overview":
            return await service.get_factory_overview(arguments.get("machine_limit", 10))
        if tool == "get_factory_incident_summary":
            return await service.get_factory_incident_summary(
                arguments.get("lookback_days"),
                arguments.get("start_date"),
                arguments.get("end_date"),
                arguments.get("granularity", "month"),
                arguments.get("machine_limit", 20),
            )
        if tool == "get_employee_work_hours":
            return await service.get_employee_work_hours(arguments.get("month"))
        raise ValueError(f"Unknown Smartenance tool: {tool}")
    finally:
        await pool.close()


def _json_default(value: Any) -> str:
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def main() -> int:
    try:
        request = json.load(sys.stdin)
        tool = request.get("tool")
        arguments = request.get("arguments", {})
        if not isinstance(tool, str) or not isinstance(arguments, dict):
            raise ValueError("Expected JSON with a tool name and arguments object")
        result = asyncio.run(_run(tool, arguments))
        json.dump({"result": result}, sys.stdout, ensure_ascii=False, default=_json_default)
        sys.stdout.write("\n")
        return 0
    except Exception as exc:
        print(f"Smartenance query failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
