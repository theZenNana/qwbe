export type Catalogue = ReadonlyArray<{
  readonly name: string
  readonly parent?: string | undefined
  readonly entity?: string | undefined
  readonly screen: boolean
  readonly agent: boolean
  readonly entityPermissions: boolean
  readonly enabled: boolean
  readonly required: boolean
  readonly system: boolean
  readonly plugin: string | null
  readonly prefix?: string | undefined
  readonly publishes: ReadonlyArray<string>
  readonly sortable: ReadonlyArray<string>
  readonly links: ReadonlyArray<{ readonly to: string; readonly field: string; readonly label: string }>
}>

type CatalogueDefinition = Readonly<{
  name: string
  plugin: string | null
  manifest: Readonly<{
    parent?: string
    entity?: string
    screen?: boolean
    agent?: boolean
    usesEntityPermissions?: boolean
    required?: boolean
    publishes?: ReadonlyArray<string>
    sortable?: ReadonlyArray<string>
  }>
  firstPath?: string
}>

export const buildCatalogue = (
  definitions: ReadonlyArray<CatalogueDefinition>,
  enabled: (name: string) => boolean,
  prefix: (path: string) => string | undefined,
  links: ReadonlyArray<{ from: string; to: string; field: string; label: string }>,
): Catalogue =>
  definitions.map(({ name, plugin, manifest, firstPath }) => ({
    name,
    parent: manifest.parent,
    entity: manifest.entity,
    screen: manifest.screen === true,
    agent: manifest.agent === true,
    entityPermissions: manifest.usesEntityPermissions === true,
    enabled: enabled(name),
    required: manifest.required === true,
    system: plugin === null,
    plugin,
    prefix: firstPath ? prefix(firstPath) : undefined,
    publishes: manifest.publishes ?? [],
    sortable: manifest.sortable ?? [],
    links: links.filter((link) => link.from === name).map(({ to, field, label }) => ({ to, field, label })),
  }))
