// Shared errors, declared in the contract so they appear in the emitted OpenAPI.
// A cube imports them from here, never from another cube.

import { HttpApiSchema } from "@effect/platform"
import { Schema } from "effect"

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 401 }),
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { message: Schema.String, needed: Schema.String },
  HttpApiSchema.annotations({ status: 403 }),
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  "NotFound",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 404 }),
) {}

export class BadRequest extends Schema.TaggedError<BadRequest>()(
  "BadRequest",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 400 }),
) {}

export class Conflict extends Schema.TaggedError<Conflict>()(
  "Conflict",
  { message: Schema.String },
  HttpApiSchema.annotations({ status: 409 }),
) {}
