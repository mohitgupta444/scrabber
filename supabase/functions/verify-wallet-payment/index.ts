import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
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

    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = await req.json()
    if (!orderId || !paymentId || !signature) return json({ error: 'Payment verification details are incomplete.' }, 400)
    const { data: transaction, error: transactionError } = await db.from('wallet_transactions')
      .select('id, payer_id, amount_paise, status').eq('razorpay_order_id', orderId).maybeSingle()
    if (transactionError) throw transactionError
    if (!transaction || transaction.payer_id !== auth.user.id) return json({ error: 'Payment order not found.' }, 404)
    if (transaction.status === 'paid') return json({ success: true })

    const expected = await hmacHex(keySecret, `${orderId}|${paymentId}`)
    const left = new TextEncoder().encode(expected)
    const right = new TextEncoder().encode(signature)
    let mismatch = left.length ^ right.length
    for (let i = 0; i < Math.max(left.length, right.length); i++) mismatch |= (left[i] ?? 0) ^ (right[i] ?? 0)
    if (mismatch !== 0) return json({ error: 'Payment signature is invalid.' }, 400)

    const paymentResponse = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { 'Authorization': `Basic ${btoa(`${keyId}:${keySecret}`)}` },
    })
    const payment = await paymentResponse.json()
    if (!paymentResponse.ok || payment.order_id !== orderId || payment.status !== 'captured' || payment.amount !== transaction.amount_paise) {
      return json({ error: 'Payment is not captured or does not match this order.' }, 409)
    }
    const { error: settleError } = await db.rpc('mark_wallet_payment_paid', {
      transaction_order_id: orderId,
      transaction_payment_id: paymentId,
    })
    if (settleError) throw settleError
    return json({ success: true })
  } catch (error) {
    console.error('verify-wallet-payment', error)
    return json({ error: error instanceof Error ? error.message : 'Payment verification failed.' }, 500)
  }
})
