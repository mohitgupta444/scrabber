import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...cors, 'Content-Type': 'application/json' },
  })
  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const keyId = Deno.env.get('RAZORPAY_KEY_ID')!
    const keySecret = Deno.env.get('RAZORPAY_KEY_SECRET')!
    if (!url || !serviceKey || !keyId || !keySecret) throw new Error('Payment service is not configured.')

    const authorization = req.headers.get('Authorization')
    if (!authorization) return json({ error: 'Sign in to continue.' }, 401)
    const db = createClient(url, serviceKey)
    const token = authorization.replace(/^Bearer\s+/i, '')
    const { data: auth, error: authError } = await db.auth.getUser(token)
    if (authError || !auth.user) return json({ error: 'Sign in to continue.' }, 401)

    const { pickupId } = await req.json()
    if (!pickupId) return json({ error: 'Pickup ID is required.' }, 400)
    const { data: pickup, error: pickupError } = await db.from('pickup_requests')
      .select('id, customer_id, dealer_id, final_amount, status')
      .eq('id', pickupId).maybeSingle()
    if (pickupError) throw pickupError
    if (!pickup || pickup.dealer_id !== auth.user.id || pickup.status !== 'completed') {
      return json({ error: 'Only the assigned dealer can pay for a completed pickup.' }, 403)
    }
    const amountPaise = Math.round(Number(pickup.final_amount) * 100)
    if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) return json({ error: 'Pickup amount is invalid.' }, 400)

    const { data: recipient, error: recipientError } = await db.from('payment_recipients')
      .select('razorpay_account_id').eq('user_id', pickup.customer_id).maybeSingle()
    if (recipientError) throw recipientError
    if (!recipient?.razorpay_account_id) return json({ error: 'Customer bank account is not onboarded for settlement yet.' }, 409)

    const { data: existing, error: existingError } = await db.from('wallet_transactions')
      .select('id, status, razorpay_order_id').eq('pickup_id', pickupId).maybeSingle()
    if (existingError) throw existingError
    if (existing?.status === 'paid') return json({ error: 'This pickup has already been paid.' }, 409)
    if (existing?.razorpay_order_id) return json({ keyId, orderId: existing.razorpay_order_id, amount: amountPaise, currency: 'INR' })

    const feePaise = Math.min(amountPaise - 1, Math.round(amountPaise * 0.05))
    const orderResponse = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${btoa(`${keyId}:${keySecret}`)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: amountPaise,
        currency: 'INR',
        receipt: `pickup_${pickupId.slice(0, 32)}`,
        transfers: [{
          account: recipient.razorpay_account_id,
          amount: amountPaise - feePaise,
          currency: 'INR',
          notes: { pickup_id: pickupId, customer_id: pickup.customer_id },
        }],
        notes: { pickup_id: pickupId },
      }),
    })
    const order = await orderResponse.json()
    if (!orderResponse.ok) return json({ error: order.error?.description || 'Could not create payment order.' }, 502)

    const transaction = {
      pickup_id: pickup.id,
      payer_id: auth.user.id,
      payee_id: pickup.customer_id,
      amount_paise: amountPaise,
      platform_fee_paise: feePaise,
      status: 'pending',
      razorpay_order_id: order.id,
    }
    const write = existing
      ? await db.from('wallet_transactions').update(transaction).eq('id', existing.id)
      : await db.from('wallet_transactions').insert(transaction)
    if (write.error) throw write.error
    return json({ keyId, orderId: order.id, amount: amountPaise, currency: 'INR' })
  } catch (error) {
    console.error('create-wallet-payment-order', error)
    return json({ error: error instanceof Error ? error.message : 'Payment setup failed.' }, 500)
  }
})
