import { z } from 'zod'
import { DEFAULT_ROLES, MODEL_CONFIG_VERSION, providerRegistry, roleRegistry } from './registries'
import type { Connection, ModelConfig, ProviderType, RoleAssignment, RoleId } from './registries'

/* ---- Shape on disk ---- */

const connectionFileSchema = z.object({
  id: z.string().min(1),
  label: z.string().default(''),
  // Validated against the registry in normalize step so one bad entry does not
  // discard the whole file.
  providerType: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  host: z.string().optional()
})

const roleAssignmentFileSchema = z.object({
  connectionId: z.string().min(1).nullable().default(null),
  model: z.string().default(''),
  webSearchEnabled: z.boolean().default(false)
})

const modelConfigFileSchema = z.object({
  schemaVersion: z.number().int(),
  connections: z.record(z.string(), connectionFileSchema).default({}),
  roles: z.record(z.string(), roleAssignmentFileSchema).default({})
})

type ParsedModelConfig = z.output<typeof modelConfigFileSchema>

export interface MigrationResult {
  config: ModelConfig
  /** Input was unusable; `config` is a fresh default and nothing was salvaged. */
  ok: boolean
  /** Persisted shape differs from what was read (migration or repair). */
  changed: boolean
  notes: string[]
}

/* ---- Helpers ---- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isProviderType(value: string): value is ProviderType {
  return Object.prototype.hasOwnProperty.call(providerRegistry, value)
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/* ---- v1 -> v2 ----
 * v1 stored a single active provider (`{ currentProvider, providers: {...} }`);
 * v2 stores connections plus per-role assignments. Both chat and lookup used the
 * active provider in v1, so they inherit its model and web-search flag.
 */

function migrateV1ToV2(raw: Record<string, unknown>, notes: string[]): Record<string, unknown> {
  const config: ModelConfig = {
    schemaVersion: 2,
    connections: {},
    roles: {
      chat: { ...DEFAULT_ROLES.chat },
      lookup: { ...DEFAULT_ROLES.lookup },
      'kb-maintenance': { ...DEFAULT_ROLES['kb-maintenance'] }
    }
  }
  const providers = asRecord(raw.providers) ?? {}
  const currentProvider = readString(raw.currentProvider)
  let activeId: string | null = null
  const legacyById: Record<string, Record<string, unknown>> = {}

  for (const [providerType, legacyValue] of Object.entries(providers)) {
    if (!isProviderType(providerType)) continue
    const legacy = asRecord(legacyValue)
    if (!legacy) continue

    const def = providerRegistry[providerType]
    const id = `v1_${providerType}`
    const connection: Connection = { id, label: def.label, providerType }
    const apiKey = readString(legacy.apiKey)
    if (apiKey) connection.apiKey = apiKey
    const baseUrl = readString(legacy.baseUrl) ?? def.defaultBaseUrl
    if (baseUrl) connection.baseUrl = baseUrl
    if (providerType === 'ollama')
      connection.host = readString(legacy.host) ?? 'http://localhost:11434'

    config.connections[id] = connection
    legacyById[id] = legacy
    if (providerType === currentProvider) activeId = id
  }

  if (!activeId) {
    // v1 could only reach the active provider, so fall back to the sole entry.
    const ids = Object.keys(config.connections)
    if (ids.length === 1) {
      activeId = ids[0]
      notes.push(`v1 config had no matching active provider; assigned "${activeId}"`)
    }
  }

  if (activeId) {
    const legacy = legacyById[activeId] ?? {}
    const assignment: RoleAssignment = {
      connectionId: activeId,
      model: readString(legacy.model) ?? '',
      webSearchEnabled: legacy.webSearchEnabled === true
    }
    config.roles.chat = { ...assignment }
    config.roles.lookup = { ...assignment }
  }

  notes.push('migrated v1 provider config to schema v2')
  return config as unknown as Record<string, unknown>
}

type MigrationStep = (raw: Record<string, unknown>, notes: string[]) => Record<string, unknown>

const MIGRATIONS: Record<number, MigrationStep> = {
  1: migrateV1ToV2
}

function applyMigrations(
  raw: Record<string, unknown>,
  fromVersion: number,
  notes: string[]
): Record<string, unknown> {
  let current = raw
  for (let version = fromVersion; version < MODEL_CONFIG_VERSION; version++) {
    const step = MIGRATIONS[version]
    if (!step) break
    current = step(current, notes)
  }
  return current
}

/* ---- Normalization ---- */

function normalizeConnections(
  parsed: ParsedModelConfig,
  notes: string[]
): Record<string, Connection> {
  const connections: Record<string, Connection> = {}

  for (const [key, entry] of Object.entries(parsed.connections)) {
    if (!isProviderType(entry.providerType)) {
      notes.push(`dropped connection "${key}" with unknown provider type "${entry.providerType}"`)
      continue
    }

    const def = providerRegistry[entry.providerType]
    const connection: Connection = {
      id: entry.id || key,
      label: entry.label || def.label,
      providerType: entry.providerType
    }
    if (!entry.label) notes.push(`connection "${key}" had no label; using "${def.label}"`)
    if (entry.apiKey) connection.apiKey = entry.apiKey
    if (entry.baseUrl) connection.baseUrl = entry.baseUrl
    if (entry.host) connection.host = entry.host

    connections[connection.id] = connection
  }

  return connections
}

function normalizeRoles(
  parsed: ParsedModelConfig,
  connections: Record<string, Connection>,
  notes: string[]
): Record<RoleId, RoleAssignment> {
  const roles = {} as Record<RoleId, RoleAssignment>

  for (const roleId of Object.keys(roleRegistry) as RoleId[]) {
    const entry = parsed.roles[roleId]
    if (!entry) {
      notes.push(`role "${roleId}" was missing; reset to unconfigured`)
      roles[roleId] = { ...DEFAULT_ROLES[roleId] }
      continue
    }

    let connectionId = entry.connectionId
    if (connectionId && !connections[connectionId]) {
      notes.push(`role "${roleId}" referenced missing connection "${connectionId}"; unassigned`)
      connectionId = null
    }

    roles[roleId] = connectionId
      ? {
          connectionId,
          model: entry.model,
          webSearchEnabled: entry.webSearchEnabled
        }
      : { connectionId: null, model: '', webSearchEnabled: false }
  }

  return roles
}

function normalizeModelConfig(parsed: ParsedModelConfig, notes: string[]): ModelConfig {
  const connections = normalizeConnections(parsed, notes)
  const roles = normalizeRoles(parsed, connections, notes)
  return { schemaVersion: MODEL_CONFIG_VERSION, connections, roles }
}

function defaultConfigResult(note: string): MigrationResult {
  return {
    config: {
      schemaVersion: MODEL_CONFIG_VERSION,
      connections: {},
      roles: {
        chat: { ...DEFAULT_ROLES.chat },
        lookup: { ...DEFAULT_ROLES.lookup },
        'kb-maintenance': { ...DEFAULT_ROLES['kb-maintenance'] }
      }
    },
    ok: false,
    changed: false,
    notes: [note]
  }
}

/**
 * Reads whatever is on disk (v1, current, or hand-edited), migrates it forward,
 * validates it, and repairs dangling references. Never throws.
 */
export function migrateModelConfig(raw: unknown): MigrationResult {
  const root = asRecord(raw)
  if (!root) {
    return defaultConfigResult('model config was not a JSON object; using defaults')
  }

  const notes: string[] = []
  const version = typeof root.schemaVersion === 'number' ? root.schemaVersion : 1
  if (version > MODEL_CONFIG_VERSION) {
    notes.push(`config schema v${version} is newer than supported v${MODEL_CONFIG_VERSION}`)
  }

  const migrated = applyMigrations(root, version, notes)
  const parsed = modelConfigFileSchema.safeParse(migrated)
  if (!parsed.success) {
    const detail = parsed.error.issues[0]
    const where = detail?.path.join('.') || 'root'
    return defaultConfigResult(`model config failed validation at ${where}; using defaults`)
  }

  const config = normalizeModelConfig(parsed.data, notes)
  return { config, ok: true, changed: notes.length > 0, notes }
}
