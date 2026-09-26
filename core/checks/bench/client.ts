import * as FetchHttpClient from "@effect/platform/FetchHttpClient"
import type * as HttpClient from "@effect/platform/HttpClient"
import * as Effect from "effect/Effect"
import { type Session, sessionAs } from "../_layers/session.ts"

/** Runs one HTTP effect of a bench to a promise, on the fetch client. */
export const runHttp = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  Effect.runPromise(Effect.provide(effect, FetchHttpClient.layer))

/** The admin on the shared bench server. */
export const benchAdmin = (base: string) => runHttp(sessionAs(base, "admin"))

// A refused request is not a fast answer: anything but 200 fails the bench.
export const okBody = (reply: ReturnType<Session["get"]>, what: string) =>
  reply.pipe(
    Effect.filterOrDie(
      (answer) => answer.status === 200,
      (answer) => new Error(`${what} answered ${answer.status}`),
    ),
    Effect.map((answer) => answer.body),
  )
