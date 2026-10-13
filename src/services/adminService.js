import { requireSupabase } from './supabase'

export const adminService = {
  async getDashboardStats() {
    const { data, error } = await requireSupabase().rpc('admin_dashboard_stats')
    if (error) throw error
    return data
  },

  async getDashboardAnalytics() {
    const { data, error } = await requireSupabase().rpc('admin_dashboard_analytics')
    if (error) throw error
    return data
  },

  async getProfiles() {
    const { data, error } = await requireSupabase()
      .from('profiles')
      .select('id, full_name, role, phone, business_name, address, verified, verification_status, created_at')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data
  },

  async getUnverifiedDealers() {
    const { data, error } = await requireSupabase()
      .from('profiles')
      .select('id, full_name, phone, business_name, address, verified, verification_status, created_at')
      .eq('role', 'dealer')
      .neq('verification_status', 'approved')
      .order('created_at', { ascending: true })
    if (error) throw error
    return data
  },

  async setDealerVerification(dealerId, status) {
    const { data, error } = await requireSupabase()
      .from('profiles')
      .update({
        verified: status === 'approved',
        verification_status: status,
      })
      .eq('id', dealerId)
      .eq('role', 'dealer')
      .select('id, verification_status, verified')
      .single()
    if (error) throw error
    return data
  },
}
