import { Schema } from "effect"

export class PermissionNotFound extends Schema.TaggedError<PermissionNotFound>()("PermissionNotFound", {
  message: Schema.String,
}) {}

export class PermissionInvalid extends Schema.TaggedError<PermissionInvalid>()("PermissionInvalid", {
  message: Schema.String,
}) {}

export class PermissionConflict extends Schema.TaggedError<PermissionConflict>()("PermissionConflict", {
  message: Schema.String,
}) {}

export class PermissionForbidden extends Schema.TaggedError<PermissionForbidden>()("PermissionForbidden", {
  message: Schema.String,
}) {}

export type PermissionServiceError = PermissionNotFound | PermissionInvalid | PermissionConflict | PermissionForbidden
