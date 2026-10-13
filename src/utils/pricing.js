const UNIT_FACTORS = {
  kg: 1,
  pieces: 0.4,
  approx: 0.9,
}

export function estimateScrapValue(rate, quantity, unit) {
  const factor = UNIT_FACTORS[unit]
  if (!factor) throw new Error(`Unsupported scrap quantity unit: ${unit}`)
  const amount = Number(rate) * Number(quantity) * factor
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Price and quantity must be valid non-negative numbers.')
  return Math.round((amount + Number.EPSILON) * 100) / 100
}
