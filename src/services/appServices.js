import { requireSupabase } from './supabase'

export const locationService = {
  getCurrentLocation() {
    if (!navigator.geolocation) {
      return Promise.reject(new Error('Location services are not supported by this browser.'))
    }
    return new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => resolve({
          label: `${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)}`,
          lat: coords.latitude,
          lng: coords.longitude,
        }),
        (error) => reject(new Error(error.message || 'Could not get your current location.')),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
      )
    })
  },
}

export const dealerService = {
  async getDealerSummary() {
    const { data, error } = await requireSupabase().rpc('dealer_dashboard_stats')
    if (error) throw error
    return {
      totalEarnings: Number(data.totalEarnings),
      completedPickups: Number(data.completedPickups),
      averageTransaction: Number(data.averageTransaction),
    }
  },
  async updateLocation(latitude, longitude) {
    const client = requireSupabase()
    const { data: userData, error: userError } = await client.auth.getUser()
    if (userError) throw userError
    if (!userData.user) throw new Error('Sign in as a dealer before sharing location.')
    const { error } = await client
      .from('profiles')
      .update({ latitude, longitude })
      .eq('id', userData.user.id)
    if (error) throw error
  },
}
