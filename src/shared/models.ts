export type ProviderType =
  'google-ai-studio' | 'openai-compatible' | 'openai' | 'ollama' | 'openrouter'

export type AuthShape = 'apiKey' | 'none' | 'host'

export type PrivacyTier = 'local' | 'cloud-zdr' | 'cloud'

export type RoleId = 'chat' | 'lookup' | 'kb-maintenance'

export interface ProviderTypeDef {
  label: string
  authShape: AuthShape
  defaultBaseUrl?: string
  capabilities: {
    webSearch: boolean
  }
  implemented: boolean
  knownModels?: string[]
}

export interface RoleDef {
  label: string
  description: string
  locked: boolean
  offersWebSearch: boolean
}

export interface Connection {
  id: string
  label: string
  providerType: ProviderType
  apiKey?: string
  baseUrl?: string
  host?: string
}

export interface RoleAssignment {
  connectionId: string | null
  model: string
  webSearchEnabled: boolean
}

export interface ModelConfig {
  schemaVersion: number
  connections: Record<string, Connection>
  roles: Record<RoleId, RoleAssignment>
}

export const MODEL_CONFIG_VERSION = 2

export const providerRegistry: Record<ProviderType, ProviderTypeDef> = {
  'google-ai-studio': {
    label: 'Google AI Studio',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    capabilities: { webSearch: true },
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
    capabilities: { webSearch: true },
    implemented: true
  },
  openai: {
    label: 'OpenAI',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://api.openai.com/v1',
    capabilities: { webSearch: true },
    implemented: true,
    knownModels: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-5-nano', 'gpt-4o', 'gpt-5.6-luna']
  },
  ollama: {
    label: 'Ollama',
    authShape: 'host',
    capabilities: { webSearch: false },
    implemented: true,
    knownModels: ['qwen3:4b', 'gemma4:e4b', 'gpt-oss:20b', 'llama3.2:1b', 'llama3.2:3b']
  },
  openrouter: {
    label: 'OpenRouter',
    authShape: 'apiKey',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    capabilities: { webSearch: true },
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
    locked: false,
    offersWebSearch: true
  },
  lookup: {
    label: 'Lookup',
    description: 'Model used for on-screen OCR lookups and expansions',
    locked: false,
    offersWebSearch: true
  },
  'kb-maintenance': {
    label: 'Knowledge Base Maintenance',
    description: 'Model used to process and maintain the local knowledge base',
    locked: false,
    offersWebSearch: false
  }
}

export const DEFAULT_ROLES: Record<RoleId, RoleAssignment> = {
  chat: { connectionId: null, model: '', webSearchEnabled: false },
  lookup: { connectionId: null, model: '', webSearchEnabled: false },
  'kb-maintenance': { connectionId: null, model: '', webSearchEnabled: false }
}

export function createDefaultModelConfig(): ModelConfig {
  return {
    schemaVersion: MODEL_CONFIG_VERSION,
    connections: {},
    roles: { ...DEFAULT_ROLES }
  }
}

export function generateConnectionId(): string {
  return `conn_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
}
