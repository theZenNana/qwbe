"""Narrow JSON subprocess boundary between Qwbe and ActiveGraph."""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import asdict
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import activegraph
from activegraph import Event, Graph, Runtime, behavior
from pydantic import BaseModel, ConfigDict


class GoalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    goal: str
    cube: str


class GoalEventPayload(BaseModel):
    goal: str


class ChatDelta(BaseModel):
    content: str | None = None


class ChatChoice(BaseModel):
    delta: ChatDelta


class ChatUsage(BaseModel):
    prompt_tokens: int
    completion_tokens: int


class ChatChunk(BaseModel):
    choices: list[ChatChoice]
    usage: ChatUsage | None = None


def cube_scope() -> str:
    return os.environ.get("QWBE_AGENT_CUBE", "")


def database_path() -> Path:
    root = Path(os.environ.get("QWBE_AGENT_DATA", "data/agentlab-activegraph"))
    root.mkdir(parents=True, exist_ok=True)
    return root / f"{cube_scope()}.sqlite"


@behavior(name="capture_cube_goal", on=["goal.created"])
def capture_cube_goal(event: Event, graph: Graph, _context: object) -> None:
    payload = GoalEventPayload.model_validate(event.payload)
    graph.add_object(
        "cube_goal",
        {"text": payload.goal, "cube": cube_scope()},
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
        # The generic contract's opaque self-description, shown by the shell as-is.
        "runtime": f"activegraph {activegraph.__version__}",
        "activegraph": activegraph.__version__,
        "llm": bool(os.environ.get("QWBE_LITELLM_BASE_URL") and os.environ.get("QWBE_LITELLM_API_KEY")),
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


def ask_model(goal: str) -> tuple[str, str, ChatUsage]:
    base_url = os.environ.get("QWBE_LITELLM_BASE_URL", "").rstrip("/")
    api_key = os.environ.get("QWBE_LITELLM_API_KEY", "")
    model = os.environ.get("QWBE_AGENT_MODEL", "sub/k3")
    if not base_url or not api_key:
        raise RuntimeError("LiteLLM is not configured")
    system = (
        "You are the isolated agent for Qwbe cube agentlab. "
        "You know only this cube and its API: GET /agentlab/health, GET /agentlab/context, "
        "POST /agentlab/goals, GET /agentlab/trace. "
        "You have no filesystem, shell, network, or cross-cube tools. "
        "Answer questions about this cube. Say when requested information is outside scope."
    )
    body = json.dumps(
        {
            "model": model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": goal},
            ],
            "max_tokens": 800,
            "temperature": 0.2,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
    ).encode("utf8")
    request = Request(
        f"{base_url}/chat/completions",
        data=body,
        headers={"authorization": f"Bearer {api_key}", "content-type": "application/json"},
        method="POST",
    )
    for attempt in range(3):
        try:
            with urlopen(request, timeout=75) as response:
                stream = response.read().decode("utf8")
            break
        except HTTPError as error:
            if error.code >= 500 and attempt < 2:
                time.sleep(attempt + 1)
                continue
            raise RuntimeError(f"LiteLLM refused the request with HTTP {error.code}") from error
        except URLError as error:
            raise RuntimeError(f"LiteLLM is unavailable: {error.reason}") from error
    content: list[str] = []
    usage: ChatUsage | None = None
    for line in stream.splitlines():
        if not line.startswith("data: ") or line == "data: [DONE]":
            continue
        chunk = ChatChunk.model_validate_json(line.removeprefix("data: "))
        if chunk.usage is not None:
            usage = chunk.usage
        for choice in chunk.choices:
            if choice.delta.content:
                content.append(choice.delta.content)
    answer = "".join(content).strip()
    if not answer:
        raise RuntimeError("LiteLLM returned no answer")
    return answer, model, usage or ChatUsage(prompt_tokens=0, completion_tokens=0)


def run_goal(raw: object) -> dict[str, object]:
    request = GoalRequest.model_validate(raw)
    if request.cube != cube_scope():
        raise PermissionError(f'cube scope denied: requested "{request.cube}", allowed "{cube_scope()}"')

    answer, model, usage = ask_model(request.goal)
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
        "answer": answer,
        "model": model,
        "usage": {
            "promptTokens": usage.prompt_tokens,
            "completionTokens": usage.completion_tokens,
        },
        "object": {
            "type": captured.type,
            "cube": captured.data["cube"],
            "text": captured.data["text"],
        },
        "llm": True,
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
        print(json.dumps({"error": str(error)}, separators=(",", ":")))
