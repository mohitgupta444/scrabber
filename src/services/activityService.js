import { requireSupabase } from './supabase'

export const activityService = {
  async getMyPickups() {
    const { data, error } = await requireSupabase()
      .from('pickup_requests')
      .select('*, dealer:profiles!pickup_requests_dealer_id_fkey(id, full_name, business_name)')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data
  },

  async getNotifications() {
    const { data, error } = await requireSupabase()
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data
  },

  async markNotificationRead(notificationId) {
    const { error } = await requireSupabase()
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('id', notificationId)
    if (error) throw error
  },

  subscribeToNotifications(userId, callback) {
    if (!userId) return () => {}
    const client = requireSupabase()
    const channel = client
      .channel(`user-notifications-${userId}-${crypto.randomUUID()}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `user_id=eq.${userId}`,
      }, callback)
      .subscribe()
    return () => client.removeChannel(channel)
  },
}
