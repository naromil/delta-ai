/**
 * Pure interaction model for the settings model picker.
 *
 * The list can hold hundreds of models, so filtering, ranking, keyboard
 * highlighting and committing live here; the React component only renders
 * this state and forwards events.
 */

export interface PickerModel {
  id: string
  hint?: string
}

export interface PickerState {
  query: string
  open: boolean
  highlight: number
}

export type PickerEvent =
  | { type: 'open' }
  | { type: 'query'; value: string }
  | { type: 'move'; delta: number }
  | { type: 'close' }

/** Maximum number of rows the picker shows at once. */
export const PICKER_LIMIT = 50

/** Lowercase and collapse every run of non-alphanumeric characters into one space. */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function initialPickerState(): PickerState {
  return { query: '', open: false, highlight: 0 }
}

/**
 * Models whose normalised id contains the normalised query. Prefix matches
 * come first; each group keeps the original list order. An empty query
 * returns the list untouched.
 */
export function filterPickerModels(
  models: PickerModel[],
  query: string,
  limit: number = PICKER_LIMIT
): PickerModel[] {
  const normalizedQuery = normalize(query)
  if (!normalizedQuery) return models

  const prefixed: PickerModel[] = []
  const contained: PickerModel[] = []
  for (const model of models) {
    const id = normalize(model.id)
    if (id.startsWith(normalizedQuery)) {
      prefixed.push(model)
    } else if (id.includes(normalizedQuery)) {
      contained.push(model)
    }
  }
  return [...prefixed, ...contained].slice(0, limit)
}

export function reducePickerState(
  state: PickerState,
  event: PickerEvent,
  count: number
): PickerState {
  switch (event.type) {
    case 'open':
      return { query: '', open: true, highlight: 0 }
    case 'query':
      return { query: event.value, open: true, highlight: 0 }
    case 'move': {
      const max = Math.max(count - 1, 0)
      const highlight = Math.min(Math.max(state.highlight + event.delta, 0), max)
      return { ...state, highlight }
    }
    case 'close':
      return { query: '', open: false, highlight: 0 }
  }
}

/**
 * The id Enter should commit: the highlighted visible row, else the trimmed
 * query typed by the user (a custom model id), else nothing.
 */
export function commitPickerValue(state: PickerState, visible: PickerModel[]): string | null {
  if (visible.length > 0) {
    const index = Math.min(Math.max(state.highlight, 0), visible.length - 1)
    return visible[index].id
  }
  const query = state.query.trim()
  return query.length > 0 ? query : null
}
