import { Schema } from "effect"
import {
  AgentContext as AgentContextContract,
  AgentGoalResult as AgentGoalResultContract,
  AgentHealth as AgentHealthContract,
  AgentTrace as AgentTraceContract,
} from "qwbe-core/agent"
import {
  CommandInfo,
  CommandResult,
  CubeInfo as CubeInfoContract,
  InstallFromResult as InstallFromResultContract,
  InstallResult as InstallResultContract,
  LinksFor as LinksForContract,
  Me as MeContract,
  Ok,
  PackageInfo as PackageInfoContract,
  PageOf,
  type PageResponse,
  RemoveResult as RemoveResultContract,
  RestartResult as RestartResultContract,
  SessionToken,
  Summary as SummaryContract,
} from "qwbe-core/http"

const UnknownRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown })

export const CubeInfoSchema = CubeInfoContract
export type CubeInfo = typeof CubeInfoContract.Type

export const SummarySchema = SummaryContract
export type Summary = typeof SummaryContract.Type

export const PagedSchema = PageOf
export type Paged<A> = PageResponse<A>

export const SessionTokenSchema = SessionToken
export const OkSchema = Ok

export const PackageInfoSchema = PackageInfoContract
export type PackageInfo = typeof PackageInfoContract.Type

export const InstallResultSchema = InstallResultContract
export type InstallResult = typeof InstallResultContract.Type

export const InstallFromResultSchema = InstallFromResultContract
export type InstallFromResult = typeof InstallFromResultContract.Type

export const RemoveResultSchema = RemoveResultContract
export type RemoveResult = typeof RemoveResultContract.Type

export const RestartResultSchema = RestartResultContract
export type RestartResult = typeof RestartResultContract.Type

export const MeSchema = MeContract
export type Me = typeof MeContract.Type

export const OpenApiDocumentSchema = Schema.Struct({
  paths: Schema.optional(Schema.Record({ key: Schema.String, value: UnknownRecord })),
})

export const UnknownRowSchema = UnknownRecord

export const LinksForSchema = LinksForContract
export type LinksFor = typeof LinksForContract.Type

export const CommandSchema = CommandInfo
export type Command = typeof CommandInfo.Type

export const CommandResultSchema = CommandResult

export const AgentHealthSchema = AgentHealthContract
export type AgentHealth = typeof AgentHealthContract.Type
export const AgentContextSchema = AgentContextContract
export type AgentContext = typeof AgentContextContract.Type
export const AgentGoalResultSchema = AgentGoalResultContract
export type AgentGoalResult = typeof AgentGoalResultContract.Type
export const AgentTraceSchema = AgentTraceContract
export type AgentTrace = typeof AgentTraceContract.Type
