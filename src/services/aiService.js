import { requireSupabase } from './supabase'

async function invoke(action, payload) {
  const { data, error } = await requireSupabase().functions.invoke('scrap-ai', {
    body: { action, ...payload },
  })
  if (error) {
    let detail = ''
    if (error.context instanceof Response) {
      const responseBody = await error.context.clone().json().catch(() => null)
      detail = responseBody?.error || responseBody?.message || ''
    }
    throw new Error(detail || error.message || 'AI request failed.')
  }
  if (data?.error) throw new Error(data.error)
  return data
}

export const aiService = {
  async chatWithAI(messages) {
    const data = await invoke('chat', { messages })
    return data.reply
  },
  async analyzeScrapImage(image, mimeType) {
    const data = await invoke('analyze-image', { image, mimeType })
    return data.analysis
  },
}
