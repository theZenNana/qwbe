# ActiveGraph: cercetare pentru integrarea QWB-26

Verificat: 2026-08-11. Surse folosite: numai proiectul oficial, documentația oficială și metadatele PyPI. Concluzia recomandată este o integrare mică, in-process, fără LLM, cu `activegraph==1.10.0`, comportamente trecute explicit în `Runtime`, SQLite per spațiu de execuție și un singur writer.

## Verdict

ActiveGraph se potrivește ca motor event-sourced pentru stare, relații și trasabilitate. Nu este workflow engine, HTTP service sau sandbox de securitate. QWBE trebuie să rămână proprietarul API-ului, autentificării, autorizării, izolării între utilizatori și ciclului de viață al proceselor. ActiveGraph poate rămâne un modul intern pentru proiecția stării și execuția deterministă a comportamentelor.

Recomandare inițială:

- pin exact `activegraph==1.10.0`, nu interval liber; PyPI încă clasifică proiectul `Development Status :: 3 - Alpha`, deși proiectul își numește linia curentă stabilă;
- folosește numai instalarea core, fără extras LLM, Postgres, FalkorDB sau observability până există nevoie măsurată;
- construiește `Runtime(Graph(), behaviors=[...], tools=[], persist_to=...)`; nu te baza pe registre globale;
- un fișier SQLite și un `run_id` per unitate de izolare; toate mutațiile printr-un singur writer;
- expune din API-ul QWBE DTO-uri proprii, nu obiectele ActiveGraph, ca versiunea bibliotecii să nu devină contract public.

## Dependență, versiune și licență

La data verificării, [PyPI publică `activegraph 1.10.0`](https://pypi.org/project/activegraph/) și cere Python `>=3.11`. Instalarea core are două dependențe obligatorii: `click>=8,<9` și `pydantic>=2`; fișierul oficial [`pyproject.toml`](https://github.com/yoheinakajima/activegraph/blob/main/pyproject.toml) confirmă aceleași limite. SQLite este în biblioteca standard și nu cere extra. Providerii LLM, Postgres, FalkorDB, Prometheus și OpenTelemetry sunt extras opționale, conform [secțiunii oficiale de instalare](https://github.com/yoheinakajima/activegraph#install).

Licența este Apache-2.0. Distribuirea trebuie să păstreze obligațiile din [`LICENSE`](https://github.com/yoheinakajima/activegraph/blob/main/LICENSE) și atribuirea din [`NOTICE`](https://github.com/yoheinakajima/activegraph/blob/main/NOTICE). Nu rezultă o obligație copyleft pentru codul QWBE.

Pin recomandat:

```text
activegraph==1.10.0
```

Pin-ul exact este o măsură de control al schimbării, nu o afirmație că 1.10.0 are suport LTS. Upgrade-ul trebuie testat explicit pe replay, serializare și traseele API folosite.

## Suprafața Python minimă, fără LLM

Documentația declară publice simbolurile exportate prin `activegraph.__all__`; restul trebuie tratat ca detaliu de implementare ([convenția API oficială](https://docs.activegraph.ai/reference/api/)). Pentru QWB-26 sunt suficiente:

- `Graph` pentru obiecte, relații și evenimente;
- `Runtime` pentru dispatch până la idle sau limită de buget;
- `behavior` ori instanțe `Behavior` pentru logică Python deterministă;
- `RuntimeStatus` pentru stare operațională;
- opțional `FrozenClock` sau `TickingClock` în teste.

Flux minim:

```python
from activegraph import Graph, Runtime, behavior


@behavior(name="open_item", on=["goal.created"])
def open_item(event, graph, ctx):
    graph.add_object("work_item", {"title": event.payload["goal"], "status": "open"})


runtime = Runtime(
    Graph(),
    behaviors=[open_item],
    tools=[],
    budget={"max_events": 100, "max_behavior_calls": 50},
    persist_to="sqlite:////absolute/path/to/run.db",
)
runtime.run_goal("Exemplu", actor="qwbe")
snapshot = runtime.status(recent=20)
```

`llm_provider` este opțional în constructor. Comportamentele Python normale nu invocă LLM; `@llm_behavior` este suprafața separată pentru LLM. Runtime-ul procesează evenimentele în ordine până când coada este goală, conform [API-ului `Runtime`](https://docs.activegraph.ai/reference/api/runtime/) și [contractului comportamentelor](https://docs.activegraph.ai/concepts/behaviors/).

Mutațiile publice relevante sunt `add_object`, `patch_object`, `remove_object`, `add_relation`, `remove_relation` și `emit`; citirile includ `objects`, `relations`, `neighborhood` și `match_chain` ([API `Graph`](https://docs.activegraph.ai/reference/api/graph/)). Orice mutație acceptată produce un eveniment; graful este proiecția logului append-only, nu o sursă de adevăr separată ([modelul Graph](https://docs.activegraph.ai/concepts/graph/)).

### Determinism

Determinismul depinde de comportamentele aplicației. ActiveGraph oferă seed runtime și ceasuri controlabile, dar nu poate face determinist cod care citește timpul real, random global, rețeaua sau alte stări externe. Pentru teste:

- comportamente pure, fără I/O extern;
- `seed` fix;
- `FrozenClock` sau `TickingClock` în `Graph`;
- limite de buget explicite;
- `Runtime.load(..., replay_strict=True)` ca detector de divergență.

Limită importantă: documentația `Runtime.load` spune că strict replay compară fluxul de ID-uri și tipuri de eveniment; limita istorică documentată pentru payload-only drift trebuie verificată la fiecare upgrade ([API `Runtime.load`](https://docs.activegraph.ai/reference/api/runtime/#activegraph.Runtime.load)). Nu folosi replay strict ca substitut pentru teste funcționale asupra payload-urilor.

## Persistență și reluare

`EventStore` păstrează logul append-only per `run_id`; proiecția Graph se reconstruiește din log. `InMemoryEventStore` nu supraviețuiește procesului. SQLite este varianta minimă pentru un singur host; Postgres este recomandat de proiect când mai multe procese sau mașini trebuie să acceseze același run ([ghidul de producție](https://docs.activegraph.ai/guides/operating-in-production/#persistence-sqlite-vs-postgres), [API Store](https://docs.activegraph.ai/reference/api/store/)).

Suprafață recomandată:

```python
runtime = Runtime(graph, behaviors=behaviors, tools=[], persist_to=sqlite_url)
run_id = runtime.run_id
runtime.save_state()

resumed = Runtime.load(
    sqlite_url,
    run_id=run_id,
    behaviors=behaviors,
    tools=[],
)
resumed.run_until_idle()
```

Folosește URL-uri explicite: `sqlite:///relative.db` sau `sqlite:////absolute/path.db`. Căile fără schemă sunt refuzate în suprafețele care cer URL. `persist_to` și `store` sunt alternative mutual exclusive. `save_state()` face flush pentru store-ul atașat; migrarea către alt store este operație separată, nu redirect în `save_state` ([configurarea runtime](https://docs.activegraph.ai/reference/errors/invalid-runtime-configuration/)).

Pentru QWBE, un proces nu trebuie să deschidă același run pentru scriere concurentă. Model recomandat: un owner/writer per run, request-uri transformate în comenzi către owner, citiri servite din snapshot-uri sau între quanta.

## Status, erori și trace

`runtime.status(recent=N)` întoarce un snapshot immutable cu `run_id`, stare grosieră, adâncimea cozii, numărul de evenimente procesate, bugetul, frame-ul, comportamentele înregistrate și coada de evenimente recente. QWBE trebuie să serializeze explicit acest obiect; `status_to_dict` nu este exportat de pachetul 1.10.0. Status-ul este o citire ieftină, fără traversare completă a grafului ([API Runtime](https://docs.activegraph.ai/reference/api/runtime/#activegraph.Runtime.status)).

Eșecurile din comportamente devin evenimente `behavior.failed`, nu excepții aruncate către apelant. `runtime.errors` este proiecția structurată a acestor evenimente. Excepțiile pot apărea la construcție și la entry points, deci adaptorul QWBE trebuie să trateze separat:

- eroare imediată a comenzii;
- run finalizat cu unul sau mai multe `behavior.failed`;
- buget epuizat prin `runtime.budget_exhausted`;
- coadă ajunsă la `runtime.idle`.

Pentru trace programatic, citește evenimentele/store-ul sau folosește export JSONL. `print_trace()` scrie pentru operator la stdout și nu este potrivit ca API. CLI-ul (`inspect`, `replay`, `fork`, `diff`, `export-trace`) apelează biblioteca Python și este util pentru diagnostic, nu pentru integrarea request path ([operator surface](https://docs.activegraph.ai/guides/operating-in-production/#the-operator-surface)).

`EventSink` poate trimite evenimente live către un adaptor izolat prin coadă bounded. Evenimentele istorice din load/replay nu sunt retrimise, iar overflow-ul poate produce drop-uri; statusul sink-ului și metricile trebuie monitorizate ([observability API](https://docs.activegraph.ai/reference/api/observability/)). Persistența logului rămâne canalul fiabil.

## Views și policies

Un `View` este o citire read-only, calculată din nou la fiecare invocare de behavior. Pattern-ul decide dacă behavior-ul pornește; view-ul limitează ce vede corpul prin `ctx.view`. Scrierile se fac prin `graph` ori `ctx.propose_object`, nu prin view ([conceptul Views](https://docs.activegraph.ai/concepts/views/)). View-ul nu este ACL, snapshot persistent sau frontieră de securitate.

`Policy` nu este sandbox general. În versiunea verificată, câmpurile `can_*` sunt în principal declarații de audit; gate-ul activ este approval routing. Doar `ctx.propose_object(...)` și patch-urile declarate gated intră în fluxul de aprobare. Apelurile directe `graph.add_object`, `graph.patch_object` și `graph.emit` aplică imediat și pot ocoli aprobarea ([conceptul Policies](https://docs.activegraph.ai/concepts/policies/), [API Packs/PackPolicy](https://docs.activegraph.ai/reference/api/packs/)).

Consecință: autorizarea QWBE trebuie verificată înainte de intrarea în Runtime. Behavior-urile neîncrezătoare nu trebuie executate in-process sub presupunerea că `Policy` le limitează.

## Integrarea în proces și API

ActiveGraph nu livrează server HTTP, WebSocket/SSE, UI sau runtime distribuit. Integrarea corectă este un adaptor QWBE in-process:

1. endpoint-ul validează identitatea, permisiunea și payload-ul;
2. un service QWBE rezolvă `run_id` și store-ul izolat;
3. comanda intră la singurul writer;
4. writer-ul mută graful ori rulează `run_goal`/`run_until_idle`;
5. API-ul returnează DTO QWBE construit prin serializare explicită, obiecte selectate și ID-uri de eveniment;
6. clientul cere istoric din store; sink-ul rămâne doar optimizare live.

Pentru request-uri care nu trebuie să blocheze până se golește o coadă mare, `run_quantum(max_queue_events=..., max_seconds=...)` permite intercalarea cooperativă a comenzilor și citirilor. Limitele sunt verificate între evenimentele cozii; o invocare de behavior rămâne atomică și poate depăși durata quantum-ului ([API `run_quantum`](https://docs.activegraph.ai/reference/api/runtime/#activegraph.Runtime.run_quantum)).

## Izolare și riscuri

- Decoratorii top-level `@behavior` și `@tool` folosesc registre globale la nivel de modul. `Runtime` fără liste explicite citește aceste registre; importurile și testele pot contamina alte run-uri. Pasează mereu `behaviors=[...]` și `tools=[]`/`tools=[...]`. `clear_registry()` și `clear_tool_registry()` sunt doar ajutoare de test ([API Behaviors](https://docs.activegraph.ai/reference/api/behaviors/), [API Tools](https://docs.activegraph.ai/reference/api/tools/)).
- Pack-urile folosesc registre runtime locale, dar `disable_pack` nu șterge starea și nu descarcă obiectele Python importate. Restartul procesului este necesar pentru evacuarea codului din memorie ([`disable_pack`](https://docs.activegraph.ai/reference/api/runtime/#activegraph.Runtime.disable_pack)).
- Runtime/Graph nu trebuie presupuse thread-safe pentru mutații. `run_quantum` este documentat pentru host cu un singur graph-writer; serializează toate comenzile per run.
- Behavior-urile rulează cod Python in-process și au suprafață de mutare a grafului. Nu încărca behavior-uri provenite de la utilizatori în procesul API.
- `ToolContext.timeout_seconds` este advisory; runtime-ul nu preempt-ează forțat tool-ul. `external_io_mode` ajută la declararea I/O înregistrat, dar nu este control OS de rețea ([API Tools](https://docs.activegraph.ai/reference/api/tools/)).
- `EventSink` izolează latența adaptorului, nu garantează livrare; coada bounded poate elimina evenimente conform politicii de overflow.
- `Budget.max_seconds` oprește dispatch-ul între unități de lucru; nu întrerupe un behavior blocat. Timeout-urile ferme cer izolare de proces administrată de QWBE.
- SQLite este potrivit pentru single-machine/single-writer. Accesul multi-proces cere Postgres ori un owner de proces care serializează comenzile.
- Logul poate conține date sensibile din payload-uri și trace. Aplică aceleași reguli de tenant isolation, retenție, backup și redactare ca pentru datele aplicației.

## Criterii de acceptare pentru un spike

Înainte de integrarea completă:

- test byte-stable pentru două run-uri cu același seed și clock;
- restart real: scriere SQLite, proces nou, `Runtime.load`, continuare;
- test că behavior failure apare în `runtime.errors` și în log;
- test de budget exhaustion și coadă rămasă;
- test de contaminare între două runtime-uri cu liste explicite;
- test că endpoint-ul nu expune obiecte interne ActiveGraph;
- test de autorizare înainte de orice mutație;
- test că un behavior blocat este terminat de limita externă de proces, nu de `max_seconds`.

Aceste teste decid dacă biblioteca rămâne in-process sau trebuie mutată într-un worker separat. Nu este necesar niciun provider LLM pentru acest spike.
