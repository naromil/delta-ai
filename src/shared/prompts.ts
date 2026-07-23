/* ---- System Prompts ---- */

export const LOOKUP_SYSTEM_PROMPT = [
  "You are DeltaAI, a helpful assistant in the software's lookup window.",
  'You will help the user approach something they are not familiar with conveniently and effectively.',
  'The context will be extracted from the screen (often via OCR), and the user will ask you to analyze it or answer questions about it.',
  "Always use web search to answer the user's questions if the answer cannot be determined from the context.",
  'If the context is extracted via OCR, it may contain errors; ask for clarification when necessary, but do not mention about OCR.',
  'Answer in simple and concise words.'
].join(' ')

export const CHAT_SYSTEM_PROMPT = [
  "You are DeltaAI, a helpful assistant in the software's chat window."
].join(' ')

export function getSystemPrompt(role?: 'chat' | 'lookup'): string {
  return role === 'lookup' ? LOOKUP_SYSTEM_PROMPT : CHAT_SYSTEM_PROMPT
}

/* ---- Context Injection ---- */

export function buildScreenContextMessage(context: string): string {
  return `The following context was extracted from my screen:\n\n"${context}"`
}

/* ---- Lookup Default ---- */

export const LOOKUP_DEFAULT_QUERY = 'summarize'

/* ---- Expand Instructions ---- */

export const ANSWER_FALLBACK = '(empty answer)'

export function buildExpandUserInstruction(selection: string): string {
  return [
    `Define "${selection}" from the text above.`,
    'Do NOT repeat the word itself or re-state the sentence it appears in.',
    'Do NOT use phrases like "refers to" or "is" that introduce the word.',
    'Output just the definition — a bare phrase or noun phrase.',
    'Example good output for "HKUMed": Li Ka Shing Faculty of Medicine at the University of Hong Kong',
    'Example bad output: "HKUMed" refers to the Li Ka Shing Faculty of Medicine...',
    'Keep it to at most two short phrases. Respond in inline text only.'
  ].join(' ')
}
