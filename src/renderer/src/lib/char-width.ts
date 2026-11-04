import { BODY_CHAR_WIDTH } from '../../../shared/canvas'

/** Ordinary English with spaces, so the average matches what an answer's lines hold. */
const SAMPLE =
  'When a conversation grows past the limit, the oldest messages are usually dropped first, ' +
  'which is why a long chat can appear to forget what was said at the beginning of it.'

let measured: number | null = null

/** The average character width of 14px body text in the font this platform really uses. */
export function bodyCharWidth(): number {
  if (measured !== null) return measured
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return BODY_CHAR_WIDTH
  context.font = `14px ${getComputedStyle(document.body).fontFamily}`
  measured = context.measureText(SAMPLE).width / SAMPLE.length
  return measured
}
