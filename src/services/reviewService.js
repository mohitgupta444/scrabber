import { requireSupabase } from './supabase'

export const reviewService = {
  async getMyReviews() {
    const client = requireSupabase()
    const { data: authData, error: authError } = await client.auth.getUser()
    if (authError) throw authError
    if (!authData.user) throw new Error('Sign in to view your reviews.')
    const { data, error } = await client
      .from('pickup_reviews')
      .select('id, pickup_id, dealer_id, rating, review, created_at')
      .eq('reviewer_id', authData.user.id)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data
  },

  async getRecentReviews() {
    const { data, error } = await requireSupabase().rpc('get_recent_reviews')
    if (error) throw error
    return data.map((item) => ({ ...item, dealer: { business_name: item.business_name } }))
  },

  async create({ pickupId, dealerId, rating, review }) {
    const { data: authData, error: authError } = await requireSupabase().auth.getUser()
    if (authError) throw authError
    if (!authData.user) throw new Error('Sign in to submit a review.')
    const { data, error } = await requireSupabase()
      .from('pickup_reviews')
      .insert({
        pickup_id: pickupId,
        reviewer_id: authData.user.id,
        dealer_id: dealerId,
        rating,
        review: review.trim(),
      })
      .select('*')
      .single()
    if (error) throw error
    return data
  },
}
