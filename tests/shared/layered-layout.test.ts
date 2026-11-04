import { describe, expect, it } from 'vitest'
import type { LayoutEdge, LayoutNode, LayoutPosition } from '../../src/shared/layered-layout'
import { layeredLayout } from '../../src/shared/layered-layout'

const GAPS = { layer: 50, sibling: 20 }
const node = (crossAt = 0, crossLength = 100, mainLength = 100): LayoutNode => ({
  mainLength,
  crossLength,
  crossAt
})
const edge = (from: number, to: number, weight = 1): LayoutEdge => ({ from, to, weight })
const center = (position: LayoutPosition, item: LayoutNode): number =>
  position.cross + item.crossLength / 2

describe('layeredLayout', () => {
  it('draws a chain straight, whatever its widths', () => {
    const nodes = [node(0, 100), node(300, 240), node(-90, 160)]
    const at = layeredLayout(nodes, [edge(0, 1), edge(1, 2)], GAPS)
    expect(at.map((p) => p.main)).toEqual([0, 150, 300])
    expect(center(at[1], nodes[1])).toBe(center(at[0], nodes[0]))
    expect(center(at[2], nodes[2])).toBe(center(at[0], nodes[0]))
  })

  it('centres a parent over its children and keeps their order', () => {
    const nodes = [node(), node(900), node(100)]
    const at = layeredLayout(nodes, [edge(0, 1), edge(0, 2)], GAPS)
    expect(at[2].cross).toBeLessThan(at[1].cross)
    const middle = (center(at[1], nodes[1]) + center(at[2], nodes[2])) / 2
    expect(Math.abs(center(at[0], nodes[0]) - middle)).toBeLessThanOrEqual(8)
  })

  it('makes the next layer start after the longest node of this one', () => {
    const nodes = [node(0, 100, 400), node(200, 100, 100), node(0), node(200)]
    const at = layeredLayout(nodes, [edge(0, 2), edge(1, 3)], GAPS)
    expect(at[2].main).toBe(450)
    expect(at[3].main).toBe(450)
  })

  it('undoes crossings that the starting order would draw', () => {
    const nodes = [node(0), node(200), node(0), node(200)]
    const at = layeredLayout(nodes, [edge(0, 3), edge(1, 2)], GAPS)
    const topOrder = at[0].cross - at[1].cross
    const bottomOrder = at[3].cross - at[2].cross
    expect(topOrder * bottomOrder).toBeGreaterThan(0)
  })

  it('moves a node aside for an edge passing through its layer', () => {
    const nodes = [node(), node(), node()]
    const at = layeredLayout(nodes, [edge(0, 1), edge(1, 2), edge(0, 2)], GAPS)
    expect(at[2].main).toBe(300)
    expect(center(at[0], nodes[0])).toBe(center(at[2], nodes[2]))
    expect(center(at[1], nodes[1])).not.toBe(center(at[0], nodes[0]))
  })

  it('stands a root against what it leads to, not at the very top', () => {
    const nodes = [node(), node(), node(), node(300)]
    const at = layeredLayout(nodes, [edge(0, 1), edge(1, 2), edge(3, 2)], GAPS)
    expect(at[3].main).toBe(at[1].main)
  })

  it('turns the lightest edge of a cycle around rather than looping', () => {
    const nodes = [node(), node(), node()]
    const at = layeredLayout(nodes, [edge(0, 1, 8), edge(1, 2, 8), edge(2, 0, 1)], GAPS)
    expect(at[0].main).toBeLessThan(at[1].main)
    expect(at[1].main).toBeLessThan(at[2].main)
  })

  it('handles nothing, one node, a self edge and a repeated edge', () => {
    expect(layeredLayout([], [], GAPS)).toEqual([])
    expect(layeredLayout([node(500)], [edge(0, 0)], GAPS)).toEqual([{ main: 0, cross: 0 }])
    const twice = layeredLayout([node(), node()], [edge(0, 1), edge(0, 1)], GAPS)
    expect(twice[1].main).toBe(150)
  })
})
