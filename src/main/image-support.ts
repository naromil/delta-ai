import { IMAGE_OMITTED_NOTE } from '../shared/prompts'
import type { RoleId } from '../shared/models'
import { resolveRole } from './config'
import type { ProviderMessage } from './provider'
import { getCachedModel } from './services/model-catalog'

/** `unknown` covers Ollama, custom endpoints and anything missing from the catalog. */
export type ImageSupport = 'yes' | 'no' | 'unknown'

/** Never throws: not knowing a model's abilities must not be why a request fails. */
export function modelImageSupport(role: RoleId): ImageSupport {
  try {
    const resolved = resolveRole(role)
    if (!resolved) return 'unknown'
    const model = getCachedModel(resolved.connection.providerType, resolved.model)
    if (!model || model.inputModalities.length === 0) return 'unknown'
    return model.inputModalities.includes('image') ? 'yes' : 'no'
  } catch {
    return 'unknown'
  }
}

export const IMAGES_UNSUPPORTED_ERROR =
  "The selected model can't read images. Choose a vision model in Settings → Models, or remove the image."

/**
 * Fits a request to a model that cannot read images. Images in the message being
 * sent are refused, because answering without them would mislead. Images earlier in
 * the history become a note, so a model switch does not strand the conversation.
 * Returns `null` for the refusal.
 */
export function fitImagesToSupport(
  messages: ProviderMessage[],
  support: ImageSupport
): ProviderMessage[] | null {
  if (support !== 'no' || !messages.some((message) => message.images?.length)) return messages
  if (messages[messages.length - 1].images?.length) return null
  return messages.map((message) => {
    if (!message.images?.length) return message
    const note = IMAGE_OMITTED_NOTE
    return {
      role: message.role,
      content: message.content === '' ? note : `${message.content}\n\n${note}`
    }
  })
}
