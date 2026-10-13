import { requireSupabase } from './supabase'

async function getProfile(userId) {
  const client = requireSupabase()
  const { data, error } = await client.from('profiles').select('*').eq('id', userId).single()
  if (error) throw error
  return data
}

export const authService = {
  async getSessionUser(session) {
    if (!session?.user) return null
    const profile = await getProfile(session.user.id)
    return {
      id: session.user.id,
      email: session.user.email,
      role: profile.role,
      name: profile.full_name || session.user.email,
      profile,
    }
  },

  async signIn(email, password) {
    const client = requireSupabase()
    const { data, error } = await client.auth.signInWithPassword({ email, password })
    if (error) throw error
    return this.getSessionUser(data.session)
  },

  async signUp({ email, password, fullName, role, phone, businessName }) {
    const client = requireSupabase()
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: {
        data: {
          full_name: fullName,
          role,
          phone,
          business_name: businessName || null,
        },
      },
    })
    if (error) throw error
    if (!data.session) {
      return { needsEmailConfirmation: true }
    }
    return {
      needsEmailConfirmation: false,
      user: await this.getSessionUser(data.session),
    }
  },

  async signOut() {
    const { error } = await requireSupabase().auth.signOut()
    if (error) throw error
  },

  async sendPasswordReset(email) {
    const { error } = await requireSupabase().auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/login`,
    })
    if (error) throw error
  },

  async updatePassword(password) {
    const { error } = await requireSupabase().auth.updateUser({ password })
    if (error) throw error
  },

  onAuthStateChange(callback) {
    const client = requireSupabase()
    return client.auth.onAuthStateChange((event, session) => {
      callback(event, session)
    })
  },

  async getCurrentSession() {
    const { data, error } = await requireSupabase().auth.getSession()
    if (error) throw error
    return data.session
  },
}
