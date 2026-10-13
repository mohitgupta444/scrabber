import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

async function hmacHex(secret: string, message: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })
  try {
    const webhookSecret = Deno.env.get('RAZORPAY_WEBHOOK_SECRET')
    const url = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!webhookSecret || !url || !serviceKey) throw new Error('Webhook is not configured.')
    const rawBody = await req.text()
    const provided = req.headers.get('x-razorpay-signature') || ''
    const expected = await hmacHex(webhookSecret, rawBody)
    const left = new TextEncoder().encode(expected)
    const right = new TextEncoder().encode(provided)
    let mismatch = left.length ^ right.length
    for (let i = 0; i < Math.max(left.length, right.length); i++) mismatch |= (left[i] ?? 0) ^ (right[i] ?? 0)
    if (mismatch !== 0) return new Response('Invalid signature', { status: 401 })

    const event = JSON.parse(rawBody)
    if (event.event === 'payment.captured') {
      const payment = event.payload?.payment?.entity
      if (payment?.order_id && payment?.id && payment?.status === 'captured') {
        const db = createClient(url, serviceKey)
        const { data: transaction, error: readError } = await db.from('wallet_transactions')
          .select('amount_paise').eq('razorpay_order_id', payment.order_id).maybeSingle()
        if (readError) throw readError
        if (transaction && Number(transaction.amount_paise) === Number(payment.amount)) {
          const { error } = await db.rpc('mark_wallet_payment_paid', {
            transaction_order_id: payment.order_id,
            transaction_payment_id: payment.id,
          })
          if (error) throw error
        }
      }
    }
    return new Response('ok', { status: 200 })
  } catch (error) {
    console.error('razorpay-webhook', error)
    return new Response('Webhook processing failed', { status: 500 })
  }
})
