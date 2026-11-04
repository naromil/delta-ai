/**
 * Layered graph drawing, in the Sugiyama style: edges run forward through layers, an edge
 * spanning several layers holds a lane through each, the order inside a layer is chosen for
 * few crossings, and neighbours then settle as close to in line as their sizes allow.
 *
 * It knows nothing of canvases and is axis-free: `main` is the way edges flow and `cross` the
 * way a layer spreads. The result depends only on the graph and the starting order, so laying
 * out an already laid-out graph leaves it where it is. Everything is pure.
 */
export interface LayoutNode {
  mainLength: number
  crossLength: number
  /** Where the node's centre is now, which decides its starting place in its layer. */
  crossAt: number
}

/** `from` and `to` index the nodes. A heavier edge is kept forward and drawn straighter. */
export interface LayoutEdge {
  from: number
  to: number
  weight: number
}

export interface LayoutGaps {
  /** Between layers. */
  layer: number
  /** Between neighbours in a layer. */
  sibling: number
}

export interface LayoutPosition {
  main: number
  cross: number
}

interface Vertex {
  layer: number
  crossLength: number
  crossAt: number
}

const ORDER_SWEEPS = 8
const SETTLE_SWEEPS = 32
/** Centres land on this grid, so a settled line of cards stands exactly in line. */
const CROSS_GRID = 8

function successorMap(count: number, edges: LayoutEdge[]): number[][] {
  const successors: number[][] = Array.from({ length: count }, () => [])
  for (const edge of edges) successors[edge.from].push(edge.to)
  return successors
}

function reaches(successors: number[][], from: number, to: number): boolean {
  const seen = new Set<number>()
  const pending = [from]
  while (pending.length > 0) {
    const at = pending.pop() as number
    if (at === to) return true
    if (seen.has(at)) continue
    seen.add(at)
    pending.push(...successors[at])
  }
  return false
}

/**
 * The edges with cycles broken and repeats summed. Heaviest go first, so an edge closing a
 * loop is the lightest in it, and it turns around rather than disappearing.
 */
function forwardEdges(count: number, edges: LayoutEdge[]): LayoutEdge[] {
  const successors: number[][] = Array.from({ length: count }, () => [])
  const merged = new Map<string, LayoutEdge>()
  for (const edge of [...edges].sort((a, b) => b.weight - a.weight)) {
    if (edge.from === edge.to) continue
    const backward = reaches(successors, edge.to, edge.from)
    const from = backward ? edge.to : edge.from
    const to = backward ? edge.from : edge.to
    const key = `${from}:${to}`
    const existing = merged.get(key)
    if (existing) {
      existing.weight += edge.weight
    } else {
      merged.set(key, { from, to, weight: edge.weight })
      successors[from].push(to)
    }
  }
  return [...merged.values()]
}

/**
 * Each node one layer past its deepest predecessor. A node nothing leads to then moves up
 * against what it leads to, so it stands beside the parent of the card it feeds.
 */
function assignLayers(count: number, edges: LayoutEdge[]): number[] {
  const successors = successorMap(count, edges)
  const incoming = new Array<number>(count).fill(0)
  for (const edge of edges) incoming[edge.to]++
  const remaining = [...incoming]
  const layers = new Array<number>(count).fill(0)
  const order: number[] = []
  const ready = remaining.flatMap((n, node) => (n === 0 ? [node] : []))
  while (ready.length > 0) {
    const node = ready.shift() as number
    order.push(node)
    for (const next of successors[node]) {
      layers[next] = Math.max(layers[next], layers[node] + 1)
      if (--remaining[next] === 0) ready.push(next)
    }
  }
  for (const node of order) {
    if (incoming[node] === 0 && successors[node].length > 0) {
      layers[node] = Math.min(...successors[node].map((next) => layers[next])) - 1
    }
  }
  return layers
}

/** Edges cut into single-layer segments, with a zero-width lane wherever one passes a layer. */
function withLanes(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  layers: number[]
): { vertices: Vertex[]; segments: LayoutEdge[] } {
  const vertices: Vertex[] = nodes.map((node, i) => ({
    layer: layers[i],
    crossLength: node.crossLength,
    crossAt: node.crossAt
  }))
  const segments: LayoutEdge[] = []
  for (const { from, to, weight } of edges) {
    const span = layers[to] - layers[from]
    let previous = from
    for (let step = 1; step < span; step++) {
      const crossAt =
        nodes[from].crossAt + ((nodes[to].crossAt - nodes[from].crossAt) * step) / span
      vertices.push({ layer: layers[from] + step, crossLength: 0, crossAt })
      segments.push({ from: previous, to: vertices.length - 1, weight })
      previous = vertices.length - 1
    }
    segments.push({ from: previous, to, weight })
  }
  return { vertices, segments }
}

function rankOf(rows: number[][], count: number): number[] {
  const rank = new Array<number>(count).fill(0)
  for (const row of rows) row.forEach((vertex, i) => (rank[vertex] = i))
  return rank
}

function countCrossings(rows: number[][], segments: LayoutEdge[], count: number): number {
  const rank = rankOf(rows, count)
  const row = new Array<number>(count).fill(0)
  rows.forEach((vertices, r) => vertices.forEach((vertex) => (row[vertex] = r)))
  let crossings = 0
  for (const [i, a] of segments.entries()) {
    for (const b of segments.slice(i + 1)) {
      if (row[a.from] !== row[b.from]) continue
      if ((rank[a.from] - rank[b.from]) * (rank[a.to] - rank[b.to]) < 0) crossings++
    }
  }
  return crossings
}

/** One pass of the barycentre heuristic: each row sorted by where its neighbours stand. */
function sweepOrder(
  rows: number[][],
  segments: LayoutEdge[],
  count: number,
  downward: boolean
): number[][] {
  const next = rows.map((row) => [...row])
  const indices = rows.map((_, i) => i)
  for (const i of downward ? indices.slice(1) : indices.slice(0, -1).reverse()) {
    const rank = rankOf(next, count)
    const keys = new Map<number, number>()
    for (const vertex of next[i]) {
      const near = segments.flatMap((segment) => {
        if (downward && segment.to === vertex) return [{ at: segment.from, w: segment.weight }]
        if (!downward && segment.from === vertex) return [{ at: segment.to, w: segment.weight }]
        return []
      })
      const total = near.reduce((sum, item) => sum + item.w, 0)
      keys.set(
        vertex,
        total === 0 ? rank[vertex] : near.reduce((sum, n) => sum + rank[n.at] * n.w, 0) / total
      )
    }
    next[i].sort((a, b) => (keys.get(a) as number) - (keys.get(b) as number))
  }
  return next
}

/** Rows from the current places, kept unless a sweep crosses strictly fewer edges. */
function orderRows(vertices: Vertex[], segments: LayoutEdge[]): number[][] {
  const rows: number[][] = []
  vertices.forEach((vertex, i) => (rows[vertex.layer] ??= []).push(i))
  for (const row of rows) row.sort((a, b) => vertices[a].crossAt - vertices[b].crossAt)

  let best = rows
  let bestCrossings = countCrossings(rows, segments, vertices.length)
  let current = rows
  for (let sweep = 0; sweep < ORDER_SWEEPS && bestCrossings > 0; sweep++) {
    current = sweepOrder(current, segments, vertices.length, sweep % 2 === 0)
    const crossings = countCrossings(current, segments, vertices.length)
    if (crossings < bestCrossings) {
      best = current
      bestCrossings = crossings
    }
  }
  return best
}

/**
 * The closest positions to `wanted`, by least squares, that keep each item at least its
 * `offsets` distance from the first. Pooling adjacent violators solves this exactly.
 */
function closestInOrder(wanted: number[], offsets: number[]): number[] {
  const pools: Array<{ sum: number; size: number }> = []
  wanted.forEach((value, i) => {
    let pool = { sum: value - offsets[i], size: 1 }
    while (pools.length > 0) {
      const last = pools[pools.length - 1]
      if (last.sum / last.size < pool.sum / pool.size) break
      pool = { sum: pool.sum + last.sum, size: pool.size + last.size }
      pools.pop()
    }
    pools.push(pool)
  })
  const flat = pools.flatMap((pool) => new Array<number>(pool.size).fill(pool.sum / pool.size))
  return flat.map((value, i) => value + offsets[i])
}

/** Centres that pull every vertex toward its neighbours while a row keeps its order and gaps. */
function settleCenters(
  rows: number[][],
  vertices: Vertex[],
  segments: LayoutEdge[],
  gap: number
): number[] {
  const near: Array<Array<{ at: number; weight: number }>> = vertices.map(() => [])
  for (const { from, to, weight } of segments) {
    near[from].push({ at: to, weight })
    near[to].push({ at: from, weight })
  }
  const offsets = rows.map((row) => {
    let at = 0
    return row.map((vertex, i) => {
      if (i > 0) {
        at += (vertices[row[i - 1]].crossLength + vertices[vertex].crossLength) / 2 + gap
      }
      return at
    })
  })
  const centers = new Array<number>(vertices.length).fill(0)
  rows.forEach((row, r) => {
    const middle = offsets[r][row.length - 1] / 2
    row.forEach((vertex, i) => (centers[vertex] = offsets[r][i] - middle))
  })
  const settleRow = (r: number): void => {
    const wanted = rows[r].map((vertex) => {
      const total = near[vertex].reduce((sum, item) => sum + item.weight, 0)
      if (total === 0) return centers[vertex]
      return near[vertex].reduce((sum, n) => sum + centers[n.at] * n.weight, 0) / total
    })
    closestInOrder(wanted, offsets[r]).forEach((at, i) => (centers[rows[r][i]] = at))
  }
  for (let sweep = 0; sweep < SETTLE_SWEEPS; sweep++) {
    for (let r = 0; r < rows.length; r++) settleRow(sweep % 2 === 0 ? r : rows.length - 1 - r)
  }
  return centers
}

/** Top-left corners for `nodes`, with the smallest of each coordinate at zero. */
export function layeredLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  gaps: LayoutGaps
): LayoutPosition[] {
  if (nodes.length === 0) return []
  const forward = forwardEdges(nodes.length, edges)
  const layers = assignLayers(nodes.length, forward)
  const { vertices, segments } = withLanes(nodes, forward, layers)
  const rows = orderRows(vertices, segments)
  const centers = settleCenters(rows, vertices, segments, gaps.sibling)

  const layerStart: number[] = []
  let main = 0
  rows.forEach((row, r) => {
    layerStart[r] = main
    const lengths = row.filter((v) => v < nodes.length).map((v) => nodes[v].mainLength)
    main += Math.max(0, ...lengths) + gaps.layer
  })
  const corners = nodes.map((node, i) => {
    const center = Math.round(centers[i] / CROSS_GRID) * CROSS_GRID
    return { main: layerStart[layers[i]], cross: Math.round(center - node.crossLength / 2) }
  })
  const least = Math.min(...corners.map((corner) => corner.cross))
  return corners.map((corner) => ({ main: corner.main, cross: corner.cross - least }))
}
