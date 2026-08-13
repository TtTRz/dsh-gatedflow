import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateSubflow } from '../src/validate.js'

const examplesDir = join(import.meta.dirname, '..', '..', '..', 'examples', 'subflows')

describe('examples/subflows', () => {
  it('every shipped example passes structural validation', () => {
    const files = readdirSync(examplesDir).filter((name) => name.endsWith('.json'))
    expect(files.length).toBeGreaterThanOrEqual(6)
    for (const file of files) {
      const data: unknown = JSON.parse(readFileSync(join(examplesDir, file), 'utf8'))
      const problems = validateSubflow(data)
      expect(problems, file).toEqual([])
    }
  })
})
