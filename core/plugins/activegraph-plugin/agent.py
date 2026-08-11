"""Narrow JSON subprocess boundary between Qwbe and ActiveGraph."""

from __future__ import annotations

import json
import os
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

import activegraph
from activegraph import Graph, Runtime, behavior
from pydantic import BaseModel, ConfigDict


class GoalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    goal: str
    cube: str


def cube_scope() -> str:
    return os.environ.get("QWBE_AGENT_CUBE", "")


def database_path() -> Path:
    root = Path(os.environ.get("QWBE_AGENT_DATA", "data/agentlab-activegraph"))
    root.mkdir(parents=True, exist_ok=True)
    return root / f"{cube_scope()}.sqlite"


@behavior(name="capture_cube_goal", on=["goal.created"])
def capture_cube_goal(event: Any, graph: Graph, _context: Any) -> None:
    graph.add_object(
        "cube_goal",
        {"text": event.payload["goal"], "cube": cube_scope()},
    )


def sqlite_url() -> str:
    return f"sqlite:///{database_path()}"


def run_id_path() -> Path:
    return database_path().with_suffix(".run-id")


def latest_runtime() -> Runtime | None:
    if not run_id_path().exists():
        return None
    run_id = run_id_path().read_text(encoding="utf8").strip()
    return Runtime.load(sqlite_url(), run_id=run_id, behaviors=[capture_cube_goal], tools=[])


def health() -> dict[str, object]:
    return {
        "cube": cube_scope(),
        "state": "ready",
        "activegraph": activegraph.__version__,
        "llm": False,
    }


def context() -> dict[str, object]:
    cube = cube_scope()
    return {
        "cube": cube,
        "allowed": [
            f"/{cube}/health",
            f"/{cube}/context",
            f"/{cube}/goals",
            f"/{cube}/trace",
        ],
        "crossCube": False,
    }


def run_goal(raw: object) -> dict[str, object]:
    request = GoalRequest.model_validate(raw)
    if request.cube != cube_scope():
        raise PermissionError(f'cube scope denied: requested "{request.cube}", allowed "{cube_scope()}"')

    runtime = Runtime(
        Graph(),
        behaviors=[capture_cube_goal],
        tools=[],
        budget={"max_events": 20, "max_behavior_calls": 10},
        seed=26,
        persist_to=sqlite_url(),
    )
    runtime.run_goal(request.goal, actor="qwbe")
    runtime.save_state()
    run_id_path().write_text(runtime.run_id, encoding="utf8")
    captured = runtime.graph.objects(type="cube_goal")[-1]
    return {
        "cube": cube_scope(),
        "state": str(runtime.status().state),
        "goal": request.goal,
        "object": {
            "type": captured.type,
            "cube": captured.data["cube"],
            "text": captured.data["text"],
        },
        "llm": False,
    }


def trace() -> dict[str, object]:
    runtime = latest_runtime()
    if runtime is None:
        return {"cube": cube_scope(), "runId": None, "state": "empty", "events": []}
    status = asdict(runtime.status(recent=20))
    return {
        "cube": cube_scope(),
        "runId": status["run_id"],
        "state": str(status["state"]),
        "events": [
            {"id": event["id"], "type": event["type"], "actor": event["actor"]}
            for event in status["recent_events"]
        ],
    }


def main() -> None:
    command = sys.argv[1] if len(sys.argv) == 2 else ""
    payload: object = json.load(sys.stdin) if command == "goal" else {}
    handlers = {"health": health, "context": context, "trace": trace}
    result = run_goal(payload) if command == "goal" else handlers[command]()
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2) from error
