# The Qwbe public API

One page for an external frontend: authenticate, discover what exists, read and write rows,
page and sort and search, and build every screen from the per-cube field metadata instead of
hand-written shapes. Every example below is a real request and response from a running server
(`node core/src/main.ts`, QWB-41); nothing here is invented.

## Authentication

Every route except `POST /auth/login` requires a bearer token. Send it as
`Authorization: Bearer <token>`; without it the server answers 401:

```json
{"message":"invalid or expired token","_tag":"Unauthorized"}
```

Request:

```
POST /auth/login
{"username":"admin","password":"..."}
```

Response 200:

```json
{
  "token": "<token-from-the-login-response>",
  "expiresAt": "2026-09-06T11:28:29.282Z"
}
```

## The catalog

`GET /settings/cubes` lists every mounted cube -- its entity, its URL prefix, whether it is
enabled, which plugin brought it, and the links (relations) declared for it by spaces.
Permission: `settings:read`. The frontend draws the sidebar and the tabs from this response.

## Rows: list, get, create

Each entity cube serves its own prefix (`/notes`, `/contracts`, `crm/contacts` ...) with the
same three shapes. Reading requires the cube's `read` permission (`notes:read`,
`crm/contacts:read`, ...); writing requires its `write` permission.

`GET /notes?offset=0&limit=2&sortBy=createdAt&descending=true` (a page, never the whole table):

```json
{
  "rows": [
    {
      "id": "note-ae4788bf",
      "type": "Note",
      "createdAt": "2026-08-30T11:31:07.522Z",
      "deleted": false,
      "title": "Hello",
      "body": "from docs",
      "authorId": "acc-9eaf605a"
    }
  ],
  "total": 1,
  "offset": 0,
  "limit": 2,
  "sortedBy": "createdAt"
}
```

`sortBy` accepts only the cube's declared sortable fields (published in the catalog and in the
metadata below); anything else is ignored and the default order is used. `GET /notes/{id}`
returns one row, 404 when it does not exist. `POST /notes` creates one:

```
POST /notes
{"title":"Hello","body":"from docs"}
```

Response 200: the full row, as above. A field the schema gives a default to (see `required` in
the metadata) may be omitted. Search goes through the links surface: a relation field on one
cube is searched from the cube that holds it (`GET /links/...`).

## Per-cube field metadata

`GET /catalog/{cube}/metadata` returns the field list of one cube, DERIVED from its Effect
schema and manifest -- there is no second, hand-written copy to drift. Permission: the cube's
own `read` permission -- a caller may read the shape of a cube exactly as far as it may read
the cube itself. A caller without the permission gets 403 and learns nothing about the shape;
an unknown or disabled cube gets 404.

The cube name is a path segment; a child cube (`crm/contracts`) must be percent-encoded:

```
GET /catalog/crm%2Fcontracts/metadata
```

Response 200 (real, abridged to two fields):

```json
{
  "cube": "crm/contracts",
  "entity": "Contract",
  "version": null,
  "schemaHash": "82a4c5c158a3b2b8857baa10623555a917b378e9fceffce6d183ab2fe5587539",
  "fields": [
    {
      "name": "id",
      "label": "Id",
      "type": "string",
      "required": false,
      "editable": false,
      "sortable": false,
      "searchable": false,
      "nullable": false,
      "enum": null,
      "relation": null
    }
  ]
}
```

Field by field:

- `type` -- `string`, `integer`, `number`, `boolean`, `array` or `unknown`, from the schema.
- `label` -- a human label. Declared in the cube's manifest (`fields: { name: { label } }`)
  where the schema cannot name one; otherwise derived from the field name.
- `required` -- must be sent on create. Read from the create payload: a field with a schema
  default is editable but not required.
- `editable` -- the caller may set it on create. The meta columns (`id`, `type`, `createdAt`,
  `deleted`) never are.
- `sortable` -- from the manifest's `sortable` list (default: the meta columns).
- `searchable` -- from the manifest's `searchable` list; default: text fields, when the cube
  implements search.
- `nullable` and `enum` -- from the schema itself (`NullOr`, literal unions).
- `relation` -- present when the field points at another cube. The target is resolved either
  from the cube's own manifest (`relations: { partyId: { target } }`) or from a space link --
  the third-party declaration in `core/src/spaces/`. `summary` names the mechanism that
  resolves a row summary for the target: `summaryById` when the target cube implements it,
  otherwise null. Nothing is invented for the metadata; the existing mechanism is published.

The `partyId` field of `crm/contracts`, real response:

```json
{
  "name": "partyId",
  "label": "Party Id",
  "type": "string",
  "required": false,
  "editable": true,
  "sortable": false,
  "searchable": true,
  "nullable": true,
  "enum": null,
  "relation": {
    "target": "crm/contacts",
    "entity": "Contact",
    "summary": "summaryById"
  }
}
```

A form for a contract renders `partyId` as a nullable picker over contacts; the display row
comes from the contacts cube's `summaryById` -- id, title and the key/value pairs that cube
chose to publish.

## Versioning and the drift gate

A cube MAY declare `version` in its manifest; the value is published in the metadata and a
client caches metadata keyed by it. Declaring a version opts the cube into the drift gate:
the kernel records the fingerprint (`schemaHash`) of the derived metadata, and a schema that
changes under an UNCHANGED version keeps the server from starting at boot with
`SchemaDriftError` -- bump `version` in the cube's manifest to ship the change. A cube that
declares no version has `version: null` and cannot break this gate.

## The machine-readable contract

`GET /openapi.json` serves the OpenAPI 3.1 document generated from the same Effect schemas.
The conformance probe (`npm run probe:contract`) checks the running server against it.
