import type { CategorizedKeyword, KeywordCategory } from '../../shared/models'
import { MAX_KEYWORDS_PER_CATEGORY } from '../../shared/models'

export function parseKeywords(raw: string): CategorizedKeyword[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = line.match(/^(.+?)\s*\[(topic|knowledge_area|learning_preference)\]$/)
      if (!match) return null
      return { keyword: match[1].trim(), category: match[2] as KeywordCategory, count: 1 }
    })
    .filter((kw): kw is CategorizedKeyword => kw !== null)
}

export function mergeKeywords(
  existing: CategorizedKeyword[],
  incoming: CategorizedKeyword[]
): CategorizedKeyword[] {
  const map = new Map<string, CategorizedKeyword>()
  for (const kw of existing) {
    const key = `${kw.category}:${kw.keyword.toLowerCase()}`
    map.set(key, { ...kw })
  }
  for (const kw of incoming) {
    const key = `${kw.category}:${kw.keyword.toLowerCase()}`
    const prev = map.get(key)
    if (prev) {
      prev.count += 1
    } else {
      map.set(key, { ...kw })
    }
  }
  return Array.from(map.values())
}

export function trimByCategory(keywords: CategorizedKeyword[]): CategorizedKeyword[] {
  const categories: KeywordCategory[] = ['topic', 'knowledge_area', 'learning_preference']
  const result: CategorizedKeyword[] = []
  for (const cat of categories) {
    const group = keywords
      .filter((kw) => kw.category === cat)
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_KEYWORDS_PER_CATEGORY)
    result.push(...group)
  }
  return result
}
