// The staging group: the endpoints, declared once here so the handlers cannot drift from them.
// Shapes live in contract.ts.

import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "@effect/platform"
import { Schema } from "effect"
import { Authorization } from "../../kernel/auth-contract.ts"
import { BadRequest, Forbidden, NotFound } from "../../kernel/errors.ts"
import {
  ChunkPayload,
  ChunkResult,
  Profile,
  Removed,
  SensitivePayload,
  SensitiveResult,
  SetCreate,
  SetFinished,
  StagingSet,
} from "./contract.ts"

export const stagingGroup = HttpApiGroup.make("staging")
  .add(
    HttpApiEndpoint.post("createSet")`/staging/sets`.setPayload(SetCreate).addSuccess(StagingSet).addError(Forbidden),
  )
  .add(HttpApiEndpoint.get("listSets")`/staging/sets`.addSuccess(Schema.Array(StagingSet)).addError(Forbidden))
  .add(
    HttpApiEndpoint.get("getSet")`/staging/sets/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(StagingSet)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.post("chunk")`/staging/sets/${HttpApiSchema.param("id", Schema.String)}/chunks`
      .setPayload(ChunkPayload)
      .addSuccess(ChunkResult)
      .addError(NotFound)
      .addError(BadRequest)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.post("finish")`/staging/sets/${HttpApiSchema.param("id", Schema.String)}/finish`
      .addSuccess(SetFinished)
      .addError(NotFound)
      .addError(BadRequest)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.post("sensitive")`/staging/sets/${HttpApiSchema.param("id", Schema.String)}/sensitive`
      .setPayload(SensitivePayload)
      .addSuccess(SensitiveResult)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.get("profile")`/staging/sets/${HttpApiSchema.param("id", Schema.String)}/profile`
      .addSuccess(Profile)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .add(
    HttpApiEndpoint.del("deleteSet")`/staging/sets/${HttpApiSchema.param("id", Schema.String)}`
      .addSuccess(Removed)
      .addError(NotFound)
      .addError(Forbidden),
  )
  .middleware(Authorization)
