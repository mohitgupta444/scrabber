import { requireSupabase } from './supabase'

let checkoutScript
function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve()
  if (!checkoutScript) {
    checkoutScript = new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = 'https://checkout.razorpay.com/v1/checkout.js'
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('Could not load Razorpay Checkout.'))
      document.body.appendChild(script)
    })
  }
  return checkoutScript
}

export const paymentService = {
  async payPickup(pickup) {
    await loadRazorpay()
    const client = requireSupabase()
    const { data: order, error: orderError } = await client.functions.invoke('create-wallet-payment-order', {
      body: { pickupId: pickup.id },
    })
    if (orderError) throw orderError

    return new Promise((resolve, reject) => {
      const checkout = new window.Razorpay({
        key: order.keyId,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        name: 'ScrapConnect',
        description: `Scrap pickup payment · ${pickup.category}`,
        handler: async (response) => {
          try {
            const { data, error } = await client.functions.invoke('verify-wallet-payment', { body: response })
            if (error) throw error
            if (!data?.success) throw new Error(data?.error || 'Payment verification failed.')
            resolve(data)
          } catch (error) {
            reject(error)
          }
        },
        modal: { ondismiss: () => reject(new Error('Payment was not completed.')) },
        theme: { color: '#059669' },
      })
      checkout.on('payment.failed', (event) => reject(new Error(event.error?.description || 'Payment failed.')))
      checkout.open()
    })
  },

  async getMyTransactions() {
    const { data, error } = await requireSupabase().from('wallet_transactions')
      .select('id, pickup_id, amount_paise, platform_fee_paise, status, created_at, paid_at, pickup:pickup_requests(category, completed_at)')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data
  },

  async getDealerPaymentStatuses(pickupIds) {
    if (!pickupIds.length) return {}
    const { data, error } = await requireSupabase().from('wallet_transactions')
      .select('pickup_id, status').in('pickup_id', pickupIds)
    if (error) throw error
    return Object.fromEntries(data.map((item) => [item.pickup_id, item.status]))
  },
}
