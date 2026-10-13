import test from 'node:test'
import assert from 'node:assert/strict'
import { estimateScrapValue } from '../src/utils/pricing.js'

test('estimates kg scrap and rounds to paise', () => {
  assert.equal(estimateScrapValue(12, 1.25, 'kg'), 15)
  assert.equal(estimateScrapValue(1, 1.005, 'kg'), 1.01)
})

test('applies the database quantity factors for pieces and approximate weight', () => {
  assert.equal(estimateScrapValue(10, 3, 'pieces'), 12)
  assert.equal(estimateScrapValue(10, 2, 'approx'), 18)
})

test('rejects unsupported units and invalid amounts', () => {
  assert.throws(() => estimateScrapValue(10, 1, 'box'), /Unsupported/)
  assert.throws(() => estimateScrapValue(-1, 1, 'kg'), /non-negative/)
})
