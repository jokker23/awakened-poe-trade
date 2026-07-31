import { distance } from 'fastest-levenshtein'
import { MERCENARY_SKILLS } from '@/assets/data'

export interface MatchedMercenarySkill {
  id: string
  name: string
}

function normalize (text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// OCR mistakes are typically a character or two per line. Allowing more than
// that starts snapping genuinely different skills onto each other, which is
// worse than dropping the line: a wrong id silently searches the wrong item.
function maxDistanceFor (name: string) {
  return Math.max(1, Math.floor(name.length * 0.2))
}

/**
 * Resolves lines of recognised text against the known mercenary skills.
 * Lines that are not close to any skill (item name, level, flavour text,
 * OCR noise) resolve to nothing and are dropped.
 */
export function matchMercenarySkills (lines: string[]): MatchedMercenarySkill[] {
  const skills = MERCENARY_SKILLS.filter(entry => entry.kind === 'skill')
  const out: MatchedMercenarySkill[] = []

  for (const line of lines) {
    const text = normalize(line)
    if (!text) continue

    let best: { entry: typeof skills[number], dist: number } | undefined
    for (const entry of skills) {
      const dist = distance(text, normalize(entry.name))
      if (dist === 0) {
        best = { entry, dist }
        break
      }
      if (dist <= maxDistanceFor(entry.name) && (!best || dist < best.dist)) {
        best = { entry, dist }
      }
    }

    if (best && !out.some(found => found.id === best!.entry.id)) {
      out.push({ id: best.entry.id, name: best.entry.name })
    }
  }

  return out
}
