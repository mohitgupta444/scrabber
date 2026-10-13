import { requireSupabase } from './supabase'

export const pickupService = {
  async createPickup(payload) {
    const client = requireSupabase()
    const { data: authData, error: authError } = await client.auth.getUser()
    if (authError) throw authError
    if (!authData.user) throw new Error('Sign in before requesting a pickup.')

    if ((payload.photos || []).length > 3) throw new Error('A pickup can include up to 3 photos.')
    for (const file of payload.photos || []) {
      if (!file.type.startsWith('image/')) throw new Error('Pickup photos must be image files.')
      if (file.size > 8 * 1024 * 1024) throw new Error('Each pickup photo must be 8 MB or smaller.')
    }

    const photoPaths = []
    for (const file of payload.photos || []) {
      const path = `${authData.user.id}/${crypto.randomUUID()}-${file.name.replace(/[^\w.-]/g, '_')}`
      const { error: uploadError } = await client.storage.from('pickup-photos').upload(path, file, {
        contentType: file.type,
        upsert: false,
      })
      if (uploadError) {
        if (photoPaths.length) {
          const { error: cleanupError } = await client.storage.from('pickup-photos').remove(photoPaths)
          if (cleanupError) {
            throw new Error(`${uploadError.message}. Earlier uploaded photos could not be cleaned up: ${cleanupError.message}`)
          }
        }
        throw uploadError
      }
      photoPaths.push(path)
    }

    const { data, error } = await client
      .from('pickup_requests')
      .insert({
        customer_id: authData.user.id,
        category: payload.category,
        quantity: Number(payload.quantity),
        unit: payload.unit,
        address: payload.address,
        house_flat: payload.houseFlat || null,
        landmark: payload.landmark || null,
        contact_phone: payload.contactPhone || null,
        pickup_time: payload.timeSlot,
        estimated_value: Number(payload.estimatedValue),
        latitude: payload.latitude,
        longitude: payload.longitude,
        photo_urls: photoPaths,
      })
      .select('*')
      .single()
    if (error) {
      if (photoPaths.length) {
        const { error: cleanupError } = await client.storage.from('pickup-photos').remove(photoPaths)
        if (cleanupError) {
          throw new Error(`${error.message}. Uploaded photos could not be cleaned up: ${cleanupError.message}`)
        }
      }
      throw error
    }
    return data
  },

  async getPickupStatus(id) {
    const { data, error } = await requireSupabase()
      .from('pickup_requests')
      .select('*, dealer:profiles!pickup_requests_dealer_id_fkey(id, full_name, business_name, phone, latitude, longitude, rating, verified)')
      .eq('id', id)
      .single()
    if (error) throw error
    return data
  },

  async getMyPickups() {
    const { data, error } = await requireSupabase()
      .from('pickup_requests')
      .select('*, dealer:profiles!pickup_requests_dealer_id_fkey(id, full_name, business_name)')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data
  },

  async getNearbyDealers(latitude, longitude) {
    const { data, error } = await requireSupabase().rpc('get_nearby_dealers', {
      search_latitude: latitude,
      search_longitude: longitude,
    })
    if (error) throw error
    return data.map(({ distance_km, ...dealer }) => ({
        ...dealer,
        name: dealer.business_name || dealer.full_name,
        categories: dealer.scrap_categories || [],
        pickups: dealer.completed_pickups,
        distance: Number(distance_km),
        eta: `${Math.max(5, Math.round(Number(distance_km) * 1000 / 350))} min`,
      }))
  },

  async getDealer(dealerId) {
    const { data, error } = await requireSupabase().rpc('get_public_dealer', {
      target_dealer_id: dealerId,
    })
    if (error) throw error
    if (!data?.length) throw new Error('Verified dealer not found.')
    return data[0]
  },

  async getDealerRequests() {
    const client = requireSupabase()
    const { data: authData, error: authError } = await client.auth.getUser()
    if (authError) throw authError
    if (!authData.user) throw new Error('Sign in as a dealer to view requests.')
    const { data: openRequests, error: openError } = await client
      .rpc('get_open_pickup_requests')
    if (openError) throw openError
    const { data: assignedRequests, error } = await client
      .from('pickup_requests')
      .select('*, customer:profiles!pickup_requests_customer_id_fkey(id, full_name, phone)')
      .eq('dealer_id', authData.user.id)
      .in('status', ['accepted', 'on_the_way', 'arrived', 'weighing', 'awaiting_confirmation', 'completed'])
      .order('created_at', { ascending: false })
    if (error) throw error
    return [
      ...openRequests.map((request) => ({
        ...request,
        status: 'requested',
        address: request.approximate_area,
        value: request.estimated_value,
        customer: null,
      })),
      ...assignedRequests.map((request) => ({
        ...request,
        value: request.estimated_value,
        customer: request.customer?.full_name,
      })),
    ]
  },

  async rejectRequest(requestId) {
    const { error } = await requireSupabase().rpc('reject_pickup_request', {
      request_id: requestId,
    })
    if (error) throw error
  },

  async acceptRequest(requestId) {
    const { data, error } = await requireSupabase().rpc('accept_pickup_request', {
      request_id: requestId,
    })
    if (error) throw error
    return data
  },

  async updateStatus(requestId, status, actualWeight = null, finalAmount = null) {
    const { data, error } = await requireSupabase().rpc('advance_pickup_status', {
      request_id: requestId,
      next_status: status,
      measured_weight: actualWeight === null ? null : Number(actualWeight),
      agreed_amount: finalAmount === null ? null : Number(finalAmount),
    })
    if (error) throw error
    return data
  },

  async confirmCompletion(requestId) {
    const { data, error } = await requireSupabase().rpc('confirm_pickup_completion', {
      request_id: requestId,
    })
    if (error) throw error
    return data
  },

  async cancelRequest(requestId) {
    const { data, error } = await requireSupabase().rpc('cancel_pickup_request', {
      request_id: requestId,
    })
    if (error) throw error
    return data
  },

  async deleteTerminalPickupPhotos(requestId, photoPaths) {
    if (!photoPaths?.length) return
    const client = requireSupabase()
    const { error } = await client.storage.from('pickup-photos').remove(photoPaths)
    if (error) throw error
    const { error: clearError } = await client.rpc('clear_terminal_pickup_photo_refs', {
      request_id: requestId,
    })
    if (clearError) throw clearError
  },

  subscribeToPickup(requestId, callback) {
    const client = requireSupabase()
    const channel = client
      .channel(`pickup-${requestId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'pickup_requests',
        filter: `id=eq.${requestId}`,
      }, callback)
      .subscribe()
    return () => client.removeChannel(channel)
  },

  subscribeToDealer(dealerId, callback) {
    const client = requireSupabase()
    const channel = client
      .channel(`dealer-location-${dealerId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'profiles',
        filter: `id=eq.${dealerId}`,
      }, callback)
      .subscribe()
    return () => client.removeChannel(channel)
  },
}
