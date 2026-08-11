# ActiveGraph plugin pilot

QWB-26 experiment. The Qwbe cube owns HTTP, authentication and authorization. A short-lived
Python subprocess owns one deterministic ActiveGraph command and writes only to its cube-specific
data directory. No LLM provider or external network is used.

Create the isolated environment without changing system Python:

```sh
python3 -m venv ../../../.qwb-activegraph-venv
../../../.qwb-activegraph-venv/bin/python -m pip install -r requirements.lock
```

Set `QWBE_ACTIVEGRAPH_PYTHON` to that environment's Python when it is not located at the repository root in `.qwb-activegraph-venv/bin/python`.
inside this plugin. ActiveGraph is Apache-2.0; its upstream license and NOTICE remain authoritative.
