# ActiveGraph plugin pilot

QWB-26 experiment. The Qwbe cube owns HTTP, authentication and authorization. A short-lived
Python subprocess owns ActiveGraph state and writes only to its cube-specific data directory.
Goals use the configured LiteLLM OpenAI-compatible endpoint; no model credential reaches the browser.

Create the isolated environment without changing system Python:

```sh
python3 -m venv ../../../.qwb-activegraph-venv
../../../.qwb-activegraph-venv/bin/python -m pip install -r requirements.lock
```

Set `QWBE_ACTIVEGRAPH_PYTHON` to that environment's Python when it is not located at the repository root in `.qwb-activegraph-venv/bin/python`.
Set `QWBE_LITELLM_BASE_URL`, `QWBE_LITELLM_API_KEY`, and optionally `QWBE_AGENT_MODEL` (default
`sub/k3`) before `npm start`. ActiveGraph is Apache-2.0; its upstream license and NOTICE remain authoritative.
