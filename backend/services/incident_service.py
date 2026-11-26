import json
import math
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

import asyncpg


class MachineNotFoundError(LookupError):
    pass


class AmbiguousMachineError(ValueError):
    pass


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, dict):
        raise ValueError("Database contains a row with an invalid JSON object")
    return value


def _date(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _incident_date(incident: dict[str, Any]) -> Optional[datetime]:
    return _date(incident.get("occurredAt")) or _date(incident.get("createdAt"))


def _active(incident: dict[str, Any]) -> bool:
    return str(incident.get("state", "")).strip().casefold() != "closed"


class IncidentService:
    def __init__(self, pool: asyncpg.Pool, account: str):
        self.pool = pool
        self.account = account

    async def _snapshots(self) -> list[dict[str, Any]]:
        # Read both tables from the same database snapshot so a concurrent sync
        # cannot make incident_count and the fetched incident rows disagree.
        async with self.pool.acquire() as connection:
            async with connection.transaction(isolation="repeatable_read", readonly=True):
                machines = await connection.fetch(
                    """
                    SELECT machine_id::text AS machine_id, machine, incident_count, synced_at
                    FROM smartenance_machines
                    WHERE account_key = $1
                    ORDER BY machine_id
                    """,
                    self.account,
                )
                incidents = await connection.fetch(
                    """
                    SELECT machine_id::text AS machine_id, incident
                    FROM smartenance_incidents
                    WHERE account_key = $1
                    ORDER BY machine_id, incident_id
                    """,
                    self.account,
                )
        by_machine: dict[str, list[dict[str, Any]]] = {}
        for row in incidents:
            by_machine.setdefault(row["machine_id"], []).append(_json_object(row["incident"]))

        snapshots = []
        for row in machines:
            machine_id = row["machine_id"]
            snapshot_incidents = by_machine.get(machine_id, [])
            snapshots.append(
                {
                    "id": machine_id,
                    "machine": _json_object(row["machine"]),
                    "incidents": snapshot_incidents,
                    "incident_count": row["incident_count"],
                    "synced_at": row["synced_at"].isoformat(),
                    "snapshot_complete": len(snapshot_incidents) == row["incident_count"],
                }
            )
        return snapshots

    async def _factory_rows(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """Read only the scalar fields needed for account-wide summaries."""
        async with self.pool.acquire() as connection:
            async with connection.transaction(isolation="repeatable_read", readonly=True):
                machines = await connection.fetch(
                    """
                    SELECT
                        machine_id::text AS machine_id,
                        machine->>'name' AS name,
                        machine->>'number' AS number,
                        revision,
                        incident_count,
                        synced_at
                    FROM smartenance_machines
                    WHERE account_key = $1
                    ORDER BY machine_id
                    """,
                    self.account,
                )
                incidents = await connection.fetch(
                    """
                    SELECT
                        machine_id::text AS machine_id,
                        incident->>'state' AS state,
                        incident->>'occurredAt' AS occurred_at,
                        incident->>'createdAt' AS created_at
                    FROM smartenance_incidents
                    WHERE account_key = $1
                    ORDER BY machine_id, incident_id
                    """,
                    self.account,
                )
        return [dict(row) for row in machines], [dict(row) for row in incidents]

    @staticmethod
    def _state_label(value: Any) -> str:
        state = str(value or "").strip()
        return state or "Unknown"

    @staticmethod
    def _summary_window(
        lookback_days: int | None,
        start_date: str | None,
        end_date: str | None,
    ) -> tuple[datetime, datetime]:
        now = datetime.now(timezone.utc)
        if lookback_days is not None:
            if start_date is not None or end_date is not None:
                raise ValueError("Use lookback_days or start_date/end_date, not both")
            if lookback_days < 1 or lookback_days > 36500:
                raise ValueError("lookback_days must be between 1 and 36500")
            start = now - timedelta(days=lookback_days)
            end = now
        else:
            if not start_date:
                raise ValueError("Provide lookback_days or start_date")
            start = _date(start_date)
            if start is None:
                raise ValueError("start_date must be an ISO-8601 date or timestamp")
            end = _date(end_date) if end_date else now
            if end is None:
                raise ValueError("end_date must be an ISO-8601 date or timestamp")
        if start >= end:
            raise ValueError("The start of the range must be earlier than its end")
        return start, end

    @staticmethod
    def _period_key(value: datetime, granularity: str) -> str:
        if granularity == "day":
            return value.date().isoformat()
        if granularity == "week":
            iso_year, iso_week, _ = value.isocalendar()
            return f"{iso_year}-W{iso_week:02d}"
        return value.strftime("%Y-%m")

    async def get_factory_overview(self, machine_limit: int = 10) -> dict[str, Any]:
        if machine_limit < 1 or machine_limit > 100:
            raise ValueError("machine_limit must be between 1 and 100")

        machines, incidents = await self._factory_rows()
        machine_counts: dict[str, dict[str, int]] = {
            row["machine_id"]: {"incident_count": 0, "active_incident_count": 0}
            for row in machines
        }
        state_counts: dict[str, dict[str, Any]] = {}
        undated_incident_count = 0
        for incident in incidents:
            machine_id = incident["machine_id"]
            if machine_id not in machine_counts:
                continue
            if _incident_date(
                {"occurredAt": incident["occurred_at"], "createdAt": incident["created_at"]}
            ) is None:
                undated_incident_count += 1
            count = machine_counts[machine_id]
            count["incident_count"] += 1
            state = self._state_label(incident["state"])
            state_key = state.casefold()
            state_item = state_counts.setdefault(
                state_key, {"state": state, "incident_count": 0}
            )
            state_item["incident_count"] += 1
            if state_key != "closed":
                count["active_incident_count"] += 1

        machine_summaries = []
        incomplete_machine_count = 0
        machines_with_incidents = 0
        machines_with_active_incidents = 0
        for machine in machines:
            counts = machine_counts[machine["machine_id"]]
            is_complete = counts["incident_count"] == machine["incident_count"]
            incomplete_machine_count += not is_complete
            machines_with_incidents += counts["incident_count"] > 0
            machines_with_active_incidents += counts["active_incident_count"] > 0
            machine_summaries.append(
                {
                    "machine_id": machine["machine_id"],
                    "name": machine["name"],
                    "number": machine["number"],
                    "incident_count": counts["incident_count"],
                    "recorded_incident_count": machine["incident_count"],
                    "active_incident_count": counts["active_incident_count"],
                    "closed_incident_count": (
                        counts["incident_count"] - counts["active_incident_count"]
                    ),
                    "snapshot_complete": is_complete,
                }
            )

        machine_summaries.sort(
            key=lambda row: (
                -row["active_incident_count"],
                -row["incident_count"],
                row["machine_id"],
            )
        )
        sync_times = [row["synced_at"] for row in machines]
        revisions = [row["revision"] for row in machines]
        active_count = sum(row["active_incident_count"] for row in machine_counts.values())
        return {
            "machine_count": len(machines),
            "incident_count": len(incidents),
            "recorded_incident_count": sum(row["incident_count"] for row in machines),
            "active_incident_count": active_count,
            "closed_incident_count": len(incidents) - active_count,
            "incidents_by_state": sorted(
                state_counts.values(),
                key=lambda row: (-row["incident_count"], row["state"].casefold()),
            ),
            "machines_with_incidents": machines_with_incidents,
            "machines_with_active_incidents": machines_with_active_incidents,
            "undated_incident_count_in_snapshot": undated_incident_count,
            "snapshot_complete": incomplete_machine_count == 0,
            "incomplete_machine_count": incomplete_machine_count,
            "latest_synced_at": max(sync_times).isoformat() if sync_times else None,
            "oldest_synced_at": min(sync_times).isoformat() if sync_times else None,
            "revision_min": min(revisions) if revisions else None,
            "revision_max": max(revisions) if revisions else None,
            "top_machines": machine_summaries[:machine_limit],
        }

    async def get_factory_incident_summary(
        self,
        lookback_days: int | None = None,
        start_date: str | None = None,
        end_date: str | None = None,
        granularity: str = "month",
        machine_limit: int = 20,
    ) -> dict[str, Any]:
        if granularity not in {"day", "week", "month"}:
            raise ValueError("granularity must be day, week, or month")
        if machine_limit < 1 or machine_limit > 100:
            raise ValueError("machine_limit must be between 1 and 100")
        start, end = self._summary_window(lookback_days, start_date, end_date)
        machines, incidents = await self._factory_rows()
        machine_by_id = {row["machine_id"]: row for row in machines}
        by_state: dict[str, dict[str, Any]] = {}
        by_machine: dict[str, dict[str, Any]] = {}
        by_period: dict[str, dict[str, int]] = {}
        undated_incident_count = 0

        for incident in incidents:
            occurred = _incident_date(
                {"occurredAt": incident["occurred_at"], "createdAt": incident["created_at"]}
            )
            if occurred is None:
                undated_incident_count += 1
                continue
            if not start <= occurred < end:
                continue

            state = self._state_label(incident["state"])
            state_key = state.casefold()
            is_active = state_key != "closed"
            state_item = by_state.setdefault(
                state_key, {"state": state, "incident_count": 0}
            )
            state_item["incident_count"] += 1

            machine_id = incident["machine_id"]
            machine_item = by_machine.setdefault(
                machine_id, {"incident_count": 0, "active_incident_count": 0}
            )
            machine_item["incident_count"] += 1
            machine_item["active_incident_count"] += is_active

            period = self._period_key(occurred, granularity)
            period_item = by_period.setdefault(
                period,
                {"incident_count": 0, "active_incident_count": 0, "closed_incident_count": 0},
            )
            period_item["incident_count"] += 1
            period_item["active_incident_count"] += is_active
            period_item["closed_incident_count"] += not is_active

        machine_summaries = []
        for machine_id, counts in by_machine.items():
            machine = machine_by_id[machine_id]
            machine_summaries.append(
                {
                    "machine_id": machine_id,
                    "name": machine["name"],
                    "number": machine["number"],
                    **counts,
                    "closed_incident_count": (
                        counts["incident_count"] - counts["active_incident_count"]
                    ),
                }
            )
        machine_summaries.sort(
            key=lambda row: (
                -row["incident_count"],
                -row["active_incident_count"],
                row["machine_id"],
            )
        )
        sync_times = [row["synced_at"] for row in machines]
        actual_count_by_machine: dict[str, int] = {}
        for incident in incidents:
            machine_id = incident["machine_id"]
            actual_count_by_machine[machine_id] = actual_count_by_machine.get(machine_id, 0) + 1
        incomplete_machine_count = sum(
            actual_count_by_machine.get(machine["machine_id"], 0) != machine["incident_count"]
            for machine in machines
        )
        return {
            "range": {
                "start_inclusive": start.isoformat(),
                "end_exclusive": end.isoformat(),
                "timezone": "UTC",
            },
            "date_basis": "occurredAt, falling back to createdAt",
            "granularity": granularity,
            "incident_count": sum(item["incident_count"] for item in by_state.values()),
            "active_incident_count": sum(
                item["active_incident_count"] for item in by_period.values()
            ),
            "closed_incident_count": sum(
                item["closed_incident_count"] for item in by_period.values()
            ),
            "machines_affected": len(by_machine),
            "incidents_by_state": sorted(
                by_state.values(),
                key=lambda row: (-row["incident_count"], row["state"].casefold()),
            ),
            "trend": [
                {"period": period, **counts}
                for period, counts in sorted(by_period.items())
            ],
            "top_machines": machine_summaries[:machine_limit],
            "undated_incident_count_in_snapshot": undated_incident_count,
            "machine_count": len(machines),
            "snapshot_complete": incomplete_machine_count == 0,
            "incomplete_machine_count": incomplete_machine_count,
            "latest_synced_at": max(sync_times).isoformat() if sync_times else None,
        }

    @staticmethod
    def _employee_hours_month_window(month: str | None) -> tuple[str, datetime, datetime]:
        shanghai = ZoneInfo("Asia/Shanghai")
        if month is None:
            current = datetime.now(shanghai)
            year, month_number = current.year, current.month - 1
            if month_number == 0:
                year -= 1
                month_number = 12
            month = f"{year:04d}-{month_number:02d}"

        if not isinstance(month, str) or not re.fullmatch(r"\d{4}-\d{2}", month):
            raise ValueError("month must use YYYY-MM format")
        try:
            year, month_number = (int(part) for part in month.split("-"))
            start = datetime(year, month_number, 1, tzinfo=shanghai)
        except ValueError as exc:
            raise ValueError("month must be a valid calendar month in YYYY-MM format") from exc

        if month_number == 12:
            end = datetime(year + 1, 1, 1, tzinfo=shanghai)
        else:
            end = datetime(year, month_number + 1, 1, tzinfo=shanghai)
        return month, start, end

    async def get_employee_work_hours(self, month: str | None = None) -> dict[str, Any]:
        """Summarize repair-task labor hours by the people assigned to each task."""
        period, start, end = self._employee_hours_month_window(month)
        async with self.pool.acquire() as connection:
            async with connection.transaction(isolation="repeatable_read", readonly=True):
                machines = await connection.fetch(
                    """
                    SELECT machine_id::text AS machine_id, incident_count, synced_at
                    FROM smartenance_machines
                    WHERE account_key = $1
                    ORDER BY machine_id
                    """,
                    self.account,
                )
                incidents = await connection.fetch(
                    """
                    SELECT machine_id::text AS machine_id, incident
                    FROM smartenance_incidents
                    WHERE account_key = $1
                    ORDER BY machine_id, incident_id
                    """,
                    self.account,
                )

        actual_count_by_machine: dict[str, int] = {}
        employee_totals: dict[str, dict[str, Any]] = {}
        total_work_hours = 0.0
        unattributed_work_hours = 0.0
        repair_task_count = 0
        repair_tasks_with_work_hours = 0
        repair_tasks_without_work_hours = 0
        repair_tasks_without_staff = 0
        repair_tasks_with_invalid_work_hours = 0
        crew_count_mismatch_task_count = 0
        undated_repair_task_count_in_snapshot = 0

        def add_employee(raw_name: Any, people: dict[str, str]) -> None:
            if not isinstance(raw_name, str):
                return
            name = raw_name.strip()
            if name:
                people.setdefault(name.casefold(), name)

        for row in incidents:
            machine_id = row["machine_id"]
            actual_count_by_machine[machine_id] = actual_count_by_machine.get(machine_id, 0) + 1
            incident = _json_object(row["incident"])
            for task in incident.get("repairTasks") or []:
                if not isinstance(task, dict):
                    continue
                task_date = _date(task.get("createdAt"))
                if task_date is None:
                    undated_repair_task_count_in_snapshot += 1
                    continue
                if not start <= task_date < end:
                    continue

                repair_task_count += 1
                fields = {
                    str(field.get("label") or "").strip(): field.get("value")
                    for field in task.get("customFields") or []
                    if isinstance(field, dict)
                }
                raw_hours = fields.get("维修工时")
                if raw_hours is None:
                    repair_tasks_without_work_hours += 1
                    continue
                if (
                    isinstance(raw_hours, bool)
                    or not isinstance(raw_hours, (int, float))
                    or not math.isfinite(raw_hours)
                    or raw_hours < 0
                ):
                    repair_tasks_with_invalid_work_hours += 1
                    continue

                work_hours = float(raw_hours)
                total_work_hours += work_hours
                repair_tasks_with_work_hours += 1

                people: dict[str, str] = {}
                add_employee(fields.get("维修负责人"), people)
                collaborators = fields.get("协作人员")
                if isinstance(collaborators, list):
                    for collaborator in collaborators:
                        add_employee(collaborator, people)
                elif isinstance(collaborators, str):
                    add_employee(collaborators, people)

                if not people:
                    repair_tasks_without_staff += 1
                    unattributed_work_hours += work_hours
                    continue

                duration = fields.get("维修时间")
                if (
                    isinstance(duration, (int, float))
                    and not isinstance(duration, bool)
                    and math.isfinite(duration)
                    and duration > 0
                    and abs((work_hours / duration) - len(people)) > 0.05
                ):
                    crew_count_mismatch_task_count += 1

                per_employee_hours = work_hours / len(people)
                for key, name in people.items():
                    total = employee_totals.setdefault(
                        key, {"employee": name, "work_hours": 0.0, "repair_task_count": 0}
                    )
                    total["work_hours"] += per_employee_hours
                    total["repair_task_count"] += 1

        incomplete_machine_count = sum(
            actual_count_by_machine.get(row["machine_id"], 0) != row["incident_count"]
            for row in machines
        )
        sync_times = [row["synced_at"] for row in machines]
        employees = sorted(
            employee_totals.values(),
            key=lambda item: (-item["work_hours"], item["employee"].casefold()),
        )
        for employee in employees:
            employee["work_hours"] = round(employee["work_hours"], 2)

        return {
            "period": period,
            "range": {
                "start_inclusive": start.isoformat(),
                "end_exclusive": end.isoformat(),
                "timezone": "Asia/Shanghai",
            },
            "date_basis": "repairTask.createdAt",
            "work_hours_field": "维修工时",
            "allocation": "Split each repair task's recorded work hours equally among its distinct 维修负责人 and 协作人员 values.",
            "total_work_hours": round(total_work_hours, 2),
            "attributed_work_hours": round(total_work_hours - unattributed_work_hours, 2),
            "unattributed_work_hours": round(unattributed_work_hours, 2),
            "employee_count": len(employees),
            "employees": employees,
            "repair_task_count": repair_task_count,
            "repair_tasks_with_work_hours": repair_tasks_with_work_hours,
            "repair_tasks_without_work_hours": repair_tasks_without_work_hours,
            "repair_tasks_without_staff": repair_tasks_without_staff,
            "repair_tasks_with_invalid_work_hours": repair_tasks_with_invalid_work_hours,
            "crew_count_mismatch_task_count": crew_count_mismatch_task_count,
            "undated_repair_task_count_in_snapshot": undated_repair_task_count_in_snapshot,
            "machine_count": len(machines),
            "snapshot_complete": incomplete_machine_count == 0,
            "incomplete_machine_count": incomplete_machine_count,
            "latest_synced_at": max(sync_times).isoformat() if sync_times else None,
        }

    @staticmethod
    def _label(machine: dict[str, Any]) -> str:
        return str(machine.get("number") or machine.get("name") or machine.get("id") or "")

    def _resolve(self, snapshots: list[dict[str, Any]], identifier: str) -> dict[str, Any]:
        target = identifier.strip().casefold()
        if not target:
            raise ValueError("machine_id must not be empty")
        matches = [
            item
            for item in snapshots
            if target
            in {
                item["id"].casefold(),
                str(item["machine"].get("id") or "").casefold(),
                str(item["machine"].get("number") or "").casefold(),
                str(item["machine"].get("name") or "").casefold(),
            }
        ]
        if not matches:
            raise MachineNotFoundError(f"No machine matched {identifier!r} in the configured account")
        if len(matches) > 1:
            raise AmbiguousMachineError(
                f"{identifier!r} matches multiple machines; use a machine UUID"
            )
        return matches[0]

    @staticmethod
    def _statistics(snapshot: dict[str, Any], recent_days: int = 90) -> dict[str, Any]:
        incidents = snapshot["incidents"]
        cutoff = datetime.now(timezone.utc) - timedelta(days=recent_days)
        recent = [
            incident
            for incident in incidents
            if (occurred := _incident_date(incident)) is not None and occurred >= cutoff
        ]
        active = [incident for incident in incidents if _active(incident)]
        return {
            "machine_id": snapshot["id"],
            "machine": snapshot["machine"],
            "incident_count": len(incidents),
            "recorded_incident_count": snapshot["incident_count"],
            "active_incident_count": len(active),
            "closed_incident_count": len(incidents) - len(active),
            "recent_incident_count": len(recent),
            "recent_days": recent_days,
            "snapshot_complete": snapshot["snapshot_complete"],
            "synced_at": snapshot["synced_at"],
        }

    @staticmethod
    def _health(snapshot: dict[str, Any]) -> dict[str, Any]:
        stats = IncidentService._statistics(snapshot)
        active_penalty = min(stats["active_incident_count"], 3) * 20
        recent_penalty = min(stats["recent_incident_count"], 5) * 5
        score = max(0, 100 - active_penalty - recent_penalty)
        return {
            **stats,
            "health_score": score,
            "risk_level": "high" if score < 50 else "medium" if score < 80 else "low",
            "scoring": {
                "baseline": 100,
                "active_incident_penalty_each": 20,
                "active_incident_penalty_cap": 60,
                "recent_incident_penalty_each": 5,
                "recent_incident_penalty_cap": 25,
                "recent_days": 90,
            },
        }

    async def get_machines(
        self, search: str | None = None, limit: int = 100, offset: int = 0
    ) -> dict[str, Any]:
        snapshots = await self._snapshots()
        query = search.strip().casefold() if search else None
        results = []
        for snapshot in snapshots:
            machine = snapshot["machine"]
            values = (
                snapshot["id"],
                str(machine.get("name") or ""),
                str(machine.get("number") or ""),
            )
            if query and not any(query in value.casefold() for value in values):
                continue
            active_count = sum(1 for incident in snapshot["incidents"] if _active(incident))
            results.append(
                {
                    "id": snapshot["id"],
                    "name": machine.get("name"),
                    "number": machine.get("number"),
                    "incident_count": len(snapshot["incidents"]),
                    "active_incident_count": active_count,
                    "synced_at": snapshot["synced_at"],
                    "snapshot_complete": snapshot["snapshot_complete"],
                }
            )
        total = len(results)
        page = results[offset : offset + limit]
        return {
            "count": len(page),
            "total": total,
            "offset": offset,
            "limit": limit,
            "has_more": offset + len(page) < total,
            "machines": page,
        }

    async def get_machine_details(self, machine_id: str) -> dict[str, Any]:
        snapshot = self._resolve(await self._snapshots(), machine_id)
        return {
            "id": snapshot["id"],
            "machine": snapshot["machine"],
            "incident_count": len(snapshot["incidents"]),
            "snapshot_complete": snapshot["snapshot_complete"],
            "synced_at": snapshot["synced_at"],
        }

    async def get_machine_statistics(self) -> dict[str, Any]:
        snapshots = await self._snapshots()
        statistics = [self._statistics(snapshot) for snapshot in snapshots]
        ranked = sorted(
            statistics,
            key=lambda row: (
                -row["incident_count"],
                -row["active_incident_count"],
                row["machine_id"],
            ),
        )
        return {"count": len(ranked), "machines": ranked}

    async def get_machine_incident_history(
        self, machine_id: str, limit: int = 100, state: str | None = None
    ) -> dict[str, Any]:
        snapshot = self._resolve(await self._snapshots(), machine_id)
        normalized_state = state.strip() if state else ""
        state_filter = normalized_state.casefold() or None
        incidents = sorted(
            [
                incident
                for incident in snapshot["incidents"]
                if state_filter is None
                or str(incident.get("state") or "").casefold() == state_filter
            ],
            key=lambda incident: _incident_date(incident) or datetime.min.replace(tzinfo=timezone.utc),
            reverse=True,
        )
        return {
            "machine_id": snapshot["id"],
            "count": min(len(incidents), limit),
            "total": len(incidents),
            "state_filter": normalized_state or None,
            "incidents": incidents[:limit],
            "synced_at": snapshot["synced_at"],
            "snapshot_complete": snapshot["snapshot_complete"],
        }

    async def get_machine_maintenance_history(
        self, machine_id: str, limit: int = 100
    ) -> dict[str, Any]:
        snapshot = self._resolve(await self._snapshots(), machine_id)
        tasks = []
        for incident in snapshot["incidents"]:
            for task in incident.get("repairTasks") or []:
                if isinstance(task, dict):
                    tasks.append(
                        {
                            **task,
                            "incident_id": incident.get("id"),
                            "incident_number": incident.get("logNumber", incident.get("number")),
                            "incident_summary": incident.get("summary"),
                            "state": incident.get("state"),
                        }
                    )
        tasks.sort(key=lambda task: _date(task.get("createdAt")) or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
        return {
            "machine_id": snapshot["id"],
            "count": min(len(tasks), limit),
            "total": len(tasks),
            "maintenance": tasks[:limit],
            "synced_at": snapshot["synced_at"],
            "snapshot_complete": snapshot["snapshot_complete"],
        }

    async def compare_machines(self, machine_ids: list[str]) -> dict[str, Any]:
        if len(machine_ids) < 2:
            raise ValueError("Provide at least two machine identifiers")
        if len(machine_ids) > 20:
            raise ValueError("Compare at most 20 machines at once")
        snapshots = await self._snapshots()
        selected = [self._resolve(snapshots, item) for item in machine_ids]
        if len({item["id"] for item in selected}) != len(selected):
            raise ValueError("Machine identifiers must be unique")
        comparison = [self._health(item) for item in selected]
        comparison.sort(
            key=lambda row: (
                row["health_score"],
                -row["active_incident_count"],
                -row["recent_incident_count"],
            )
        )
        return {"machines": comparison, "least_healthy_machine_id": comparison[0]["machine_id"]}

    async def get_machine_health_score(self, machine_id: str) -> dict[str, Any]:
        snapshot = self._resolve(await self._snapshots(), machine_id)
        return self._health(snapshot)

    async def get_machine_risk_ranking(self, limit: int = 20) -> dict[str, Any]:
        snapshots = await self._snapshots()
        ranking = [self._health(snapshot) for snapshot in snapshots]
        ranking.sort(
            key=lambda row: (
                row["health_score"],
                -row["active_incident_count"],
                -row["recent_incident_count"],
                row["machine_id"],
            )
        )
        return {
            "count": min(len(ranking), limit),
            "total": len(ranking),
            "machines": ranking[:limit],
        }
