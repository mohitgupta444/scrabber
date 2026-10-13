import { requireSupabase } from './supabase'

export const profileService = {
  async update(fields) {
    const client = requireSupabase()
    const { data: authData, error: authError } = await client.auth.getUser()
    if (authError) throw authError
    if (!authData.user) throw new Error('Sign in to update your profile.')
    const { data, error } = await client
      .from('profiles')
      .update(fields)
      .eq('id', authData.user.id)
      .select('*')
      .single()
    if (error) throw error
    return data
  },
}
