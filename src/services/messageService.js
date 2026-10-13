import { requireSupabase } from './supabase'

export const messageService = {
  async list(pickupId) {
    const { data, error } = await requireSupabase()
      .from('pickup_messages')
      .select('id, pickup_id, sender_id, body, created_at, sender:profiles!pickup_messages_sender_id_fkey(full_name, role)')
      .eq('pickup_id', pickupId)
      .order('created_at', { ascending: true })
    if (error) throw error
    return data
  },

  async send(pickupId, body) {
    const trimmedBody = body.trim()
    if (!trimmedBody) throw new Error('Write a message before sending.')
    const { data: authData, error: authError } = await requireSupabase().auth.getUser()
    if (authError) throw authError
    if (!authData.user) throw new Error('Sign in to message about this pickup.')

    const { data, error } = await requireSupabase()
      .from('pickup_messages')
      .insert({
        pickup_id: pickupId,
        sender_id: authData.user.id,
        body: trimmedBody,
      })
      .select('id, pickup_id, sender_id, body, created_at, sender:profiles!pickup_messages_sender_id_fkey(full_name, role)')
      .single()
    if (error) throw error
    return data
  },

  subscribe(pickupId, callback) {
    const client = requireSupabase()
    const channel = client
      .channel(`pickup-messages-${pickupId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'pickup_messages',
        filter: `pickup_id=eq.${pickupId}`,
      }, callback)
      .subscribe()
    return () => client.removeChannel(channel)
  },
}
