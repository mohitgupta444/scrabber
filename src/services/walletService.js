import { requireSupabase } from './supabase'

const requestId = () => crypto.randomUUID()

export const walletService = {
  async listTransactions() {
    const { data, error } = await requireSupabase().from('wallet_transactions')
      .select('id, pickup_id, payer_id, payee_id, amount_paise, platform_fee_paise, status, transaction_type, note, created_at, paid_at, pickup:pickup_requests(category)')
      .order('created_at', { ascending: false })
    if (error) throw error
    return data
  },

  async getPickupPayment(pickupId) {
    const { data, error } = await requireSupabase().from('wallet_transactions')
      .select('id, status, transaction_type, amount_paise, paid_at')
      .eq('pickup_id', pickupId)
      .maybeSingle()
    if (error) throw error
    return data
  },

  async transferToEmail(email, amount, note) {
    const amountPaise = Math.round(Number(amount) * 100)
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new Error('Enter a valid amount greater than ₹0.')
    const { data, error } = await requireSupabase().rpc('transfer_wallet_to_email', {
      recipient_email: email.trim(),
      transfer_amount_paise: amountPaise,
      transfer_note: note.trim() || null,
      transfer_idempotency_key: requestId(),
    })
    if (error) throw error
    return data
  },

  async payCompletedPickupFromWallet(pickupId) {
    const { data, error } = await requireSupabase().rpc('pay_completed_pickup_from_wallet', {
      request_id: pickupId,
    })
    if (error) throw error
    return data
  },

  async adminCreditToEmail(email, amount, note) {
    const amountPaise = Math.round(Number(amount) * 100)
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw new Error('Enter a valid amount greater than ₹0.')
    const { data, error } = await requireSupabase().rpc('admin_credit_wallet_to_email', {
      recipient_email: email.trim(),
      credit_amount_paise: amountPaise,
      credit_note: note.trim(),
      credit_idempotency_key: requestId(),
    })
    if (error) throw error
    return data
  },
}
