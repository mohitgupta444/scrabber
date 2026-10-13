import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { authService } from '../services/authService'
import { isSupabaseConfigured } from '../services/supabase'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(isSupabaseConfigured)
  const [authError, setAuthError] = useState('')
  const [recoveryPending, setRecoveryPending] = useState(false)

  useEffect(() => {
    if (!isSupabaseConfigured) return undefined

    let active = true
    let subscription

    const hydrateSession = async () => {
      try {
        const session = await authService.getCurrentSession()
        const currentUser = await authService.getSessionUser(session)
        if (active) setUser(currentUser)
      } catch (error) {
        if (active) setAuthError(error.message)
      } finally {
        if (active) setLoading(false)
      }
    }

    hydrateSession()
    const { data } = authService.onAuthStateChange(async (event, session) => {
      if (!active) return
      setRecoveryPending(event === 'PASSWORD_RECOVERY')
      if (!session) {
        setUser(null)
        return
      }
      try {
        const currentUser = await authService.getSessionUser(session)
        if (active) setUser(currentUser)
      } catch (error) {
        if (active) setAuthError(error.message)
      }
    })
    subscription = data.subscription

    return () => {
      active = false
      subscription?.unsubscribe()
    }
  }, [])

  const login = async (email, password) => {
    setAuthError('')
    const result = await authService.signIn(email, password)
    setUser(result)
    return result
  }

  const signUp = async (details) => {
    setAuthError('')
    return authService.signUp(details)
  }

  const refreshProfile = async () => {
    const session = await authService.getCurrentSession()
    const currentUser = await authService.getSessionUser(session)
    setUser(currentUser)
    return currentUser
  }

  const resetPassword = (email) => authService.sendPasswordReset(email)
  const updatePassword = async (password) => {
    await authService.updatePassword(password)
    setRecoveryPending(false)
  }

  const logout = async () => {
    await authService.signOut()
    setUser(null)
  }

  const value = useMemo(() => ({
    user,
    loading,
    authError,
    login,
    signUp,
    logout,
    refreshProfile,
    resetPassword,
    recoveryPending,
    updatePassword,
    configured: isSupabaseConfigured,
  }), [user, loading, authError, recoveryPending])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used inside AuthProvider')
  }
  return context
}
