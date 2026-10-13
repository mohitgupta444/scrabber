import { requireSupabase } from './supabase'
import { estimateScrapValue } from '../utils/pricing'

export const priceService = {
  async list() {
    const { data, error } = await requireSupabase()
      .from('scrap_prices')
      .select('category, price_per_kg, currency, updated_at')
      .order('category')
    if (error) throw error
    return data
  },

  async estimate(category, quantity, unit) {
    const { data, error } = await requireSupabase()
      .from('scrap_prices')
      .select('price_per_kg')
      .eq('category', category)
      .single()
    if (error) throw error
    return estimateScrapValue(data.price_per_kg, quantity, unit)
  },
}
