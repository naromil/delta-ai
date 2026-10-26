export type ProviderType =
  'google-ai-studio' | 'openai-compatible' | 'openai' | 'ollama' | 'openrouter'

export type AuthShape = 'apiKey' | 'none' | 'host'

export type PrivacyTier = 'local' | 'cloud-zdr' | 'cloud'

export type RoleId = 'chat' | 'lookup' | 'kb-maintenance'

export type LookupContextMode = 'none' | 'clipboard' | 'fullscreen-ocr'

/** One message in the provider-agnostic request shape used by every backend. */
export interface ProviderMessage {
  role: string
  content: string
}

export interface ProviderTypeDef {
  label: string
  authShape: AuthShape
  defaultBaseUrl?: string
  implemented: boolean
  knownModels?: string[]
}

export interface RoleDef {
  label: string
  description: string
  locked: boolean
}

export interface Connection {
  id: string
  label: string
  providerType: ProviderType
  /** Only present in main, or in the renderer while the user types a new key. */
  apiKey?: string
  /** Renderer-only: a key is stored for this connection (see `redactModelConfig`). */
  hasApiKey?: boolean
  baseUrl?: string
  host?: string
}

export interface RoleAssignment {
  connectionId: string | null
  model: string
}

export interface ModelConfig {
  schemaVersion: number
  connections: Record<string, Connection>
  roles: Record<RoleId, RoleAssignment>
}

/**
 * v3 dropped the per-role web-search flag: search is only reachable through
 * provider-specific tools, so a common flag could not be honoured uniformly.
 */
export const MODEL_CONFIG_VERSION = 3

export const providerRegistry: Record<ProviderType, ProviderTypeDef> = {
  'google-ai-studio': {
    label: 'Google AI Studio',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    implemented: true,
    knownModels: [
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite',
      'gemma-4-31b-it'
    ]
  },
  'openai-compatible': {
    label: 'OpenAI Compatible',
    authShape: 'apiKey',
    implemented: true
  },
  openai: {
    label: 'OpenAI',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://api.openai.com/v1',
    implemented: true,
    knownModels: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5-nano', 'gpt-4o', 'gpt-5.6-luna']
  },
  ollama: {
    label: 'Ollama',
    authShape: 'host',
    implemented: true,
    knownModels: ['qwen3:4b', 'gemma4:e4b', 'gpt-oss:20b', 'llama3.2:1b', 'llama3.2:3b']
  },
  openrouter: {
    label: 'OpenRouter',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    implemented: true,
    knownModels: [
      'google/gemini-3.5-flash',
      'google/gemini-3.1-flash-lite',
      'openai/gpt-oss-120b',
      'openai/gpt-4o-mini',
      'openai/gpt-5-nano'
    ]
  }
}

export const roleRegistry: Record<RoleId, RoleDef> = {
  chat: {
    label: 'Chat',
    description: 'Model used for the main chat conversation window',
    locked: false
  },
  lookup: {
    label: 'Lookup',
    description: 'Model used for on-screen OCR lookups and expansions',
    locked: false
  },
  'kb-maintenance': {
    label: 'Knowledge Base Maintenance',
    description: 'Model used to process and maintain the local knowledge base',
    locked: false
  }
}

export const DEFAULT_ROLES: Record<RoleId, RoleAssignment> = {
  chat: { connectionId: null, model: '' },
  lookup: { connectionId: null, model: '' },
  'kb-maintenance': { connectionId: null, model: '' }
}

export function createDefaultModelConfig(): ModelConfig {
  return {
    schemaVersion: MODEL_CONFIG_VERSION,
    connections: {},
    roles: {
      chat: { ...DEFAULT_ROLES.chat },
      lookup: { ...DEFAULT_ROLES.lookup },
      'kb-maintenance': { ...DEFAULT_ROLES['kb-maintenance'] }
    }
  }
}

export function generateConnectionId(): string {
  return `conn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}

export type KeywordCategory = 'topic' | 'knowledge_area' | 'learning_preference'

export const MAX_KEYWORDS_PER_CATEGORY = 20

export interface CategorizedKeyword {
  keyword: string
  category: KeywordCategory
  count: number
}
