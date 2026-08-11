// The bus payload contracts of the Booktags package -- local to the package, NOT the kernel.
//
// An event name is a string by design ("the listener does not import the publisher"), but a
// string is not a contract. A payload that is cast trusts the publisher with no verification.
// So the payloads that cross this package's cube boundaries get a Schema here, in the package
// that owns the event, decoded at the subscriber's edge.

import { Schema } from "effect"

/** Payload of `booktags/settings.changed`: one setting, by key and string value. */
export const BooktagsSettingChanged = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
}).annotations({ identifier: "BooktagsSettingChanged" })

export const decodeBooktagsSettingChanged = Schema.decodeUnknownSync(BooktagsSettingChanged)
