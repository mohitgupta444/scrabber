import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  Bell,
  Bot,
  Check,
  ChevronRight,
  CircleCheckBig,
  Clock3,
  CreditCard,
  FileText,
  Gauge,
  ImagePlus,
  LayoutDashboard,
  LogOut,
  MapPinned,
  Menu,
  MessageSquare,
  Package,
  Phone,
  Plus,
  RefreshCw,
  Recycle,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Star,
  TrendingUp,
  Truck,
  User,
  Wallet,
  X,
} from 'lucide-react'
import { CircleMarker, MapContainer, Popup, TileLayer, useMap, useMapEvents } from 'react-leaflet'
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { scrapCategories } from './data/catalogData'
import { messageService } from './services/messageService'
import { pickupService } from './services/pickupService'
import { dealerService, locationService } from './services/appServices'
import { activityService } from './services/activityService'
import { adminService } from './services/adminService'
import { profileService } from './services/profileService'
import { priceService } from './services/priceService'
import { reviewService } from './services/reviewService'
import { paymentService } from './services/paymentService'
import { walletService } from './services/walletService'
import { estimateScrapValue } from './utils/pricing'
import { aiService } from './services/aiService'

const formatCurrency = (value) => `₹${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </AuthProvider>
  )
}

function AppShell() {
  const [toast, setToast] = useState(null)

  const showToast = (message) => {
    setToast(message)
    window.clearTimeout(showToast.timeout)
    showToast.timeout = window.setTimeout(() => setToast(null), 2600)
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage showToast={showToast} />} />

        <Route path="/user/*" element={<ProtectedRoute allowedRole="user"><UserLayout showToast={showToast} /></ProtectedRoute>} />
        <Route path="/dealer/*" element={<ProtectedRoute allowedRole="dealer"><DealerLayout /></ProtectedRoute>} />
        <Route path="/admin/*" element={<ProtectedRoute allowedRole="admin"><AdminLayout /></ProtectedRoute>} />

        <Route path="*" element={<NotFoundPage />} />
      </Routes>

      <AiChatBot />

      {toast && (
        <div className="fixed right-4 top-4 z-50 rounded-2xl border border-emerald-200 bg-white px-4 py-3 shadow-soft">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
              <Check className="h-4 w-4" />
            </div>
            <span className="text-sm font-medium text-slate-700">{toast}</span>
          </div>
        </div>
      )}
    </div>
  )
}

function ChatMarkdown({ content }) {
  const renderInline = (text) => text.split(/(\*\*.+?\*\*|\*.+?\*|`[^`]+`)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>
    if (part.startsWith('*') && part.endsWith('*')) return <em key={index}>{part.slice(1, -1)}</em>
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index} className="rounded bg-slate-200 px-1 py-0.5 text-xs">{part.slice(1, -1)}</code>
    return part
  })
  return <div className="space-y-1.5">{String(content).split(/\r?\n/).map((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) return <div key={index} className="h-1" />
    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/)
    if (heading) return <p key={index} className="font-bold">{renderInline(heading[2])}</p>
    const list = trimmed.match(/^([-*]|\d+\.)\s+(.+)$/)
    if (list) {
      const indent = Math.min(Math.floor((line.length - line.trimStart().length) / 2), 4)
      return <p key={index} className="flex gap-1.5" style={{ marginLeft: indent * 10 }}><span>{/^\d+\./.test(list[1]) ? list[1] : '\u2022'}</span><span>{renderInline(list[2])}</span></p>
    }
    return <p key={index}>{renderInline(trimmed)}</p>
  })}</div>
}

function AiChatBot() {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)
  const [conversations, setConversations] = useState([])
  const [activeChatId, setActiveChatId] = useState(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [analysis, setAnalysis] = useState(null)
  const [analysisImage, setAnalysisImage] = useState('')
  const [historyOwner, setHistoryOwner] = useState(null)
  const activeChat = conversations.find((chat) => chat.id === activeChatId)
  const messages = activeChat?.messages || []

  useEffect(() => () => {
    if (analysisImage) URL.revokeObjectURL(analysisImage)
  }, [analysisImage])

  useEffect(() => {
    if (!user?.id) {
      setConversations([])
      setActiveChatId(null)
      setHistoryOwner(null)
      return
    }
    const historyKey = `scrapconnect-ai-chats:${user.id}`
    try {
      let saved = JSON.parse(localStorage.getItem(historyKey) || 'null')
      if (!Array.isArray(saved) || saved.length === 0) {
        const oldMessages = JSON.parse(localStorage.getItem(`scrapconnect-ai-chat:${user.id}`) || '[]')
        if (Array.isArray(oldMessages) && oldMessages.length) {
          const firstQuestion = oldMessages.find((message) => message.role === 'user')?.content || 'Previous chat'
          saved = [{ id: crypto.randomUUID(), title: firstQuestion.slice(0, 48), updatedAt: new Date().toISOString(), messages: oldMessages }]
          localStorage.removeItem(`scrapconnect-ai-chat:${user.id}`)
        }
      }
      const loaded = Array.isArray(saved) ? saved.filter((chat) => chat && chat.id && Array.isArray(chat.messages)).slice(0, 20) : []
      setConversations(loaded)
      setActiveChatId(loaded[0]?.id || null)
    } catch {
      setConversations([])
      setActiveChatId(null)
    }
    setHistoryOwner(user.id)
  }, [user?.id])

  useEffect(() => {
    if (!user?.id || historyOwner !== user.id) return
    try {
      let remainingMessages = 500
      const saved = conversations.slice(0, 20).map((chat) => {
        const keptMessages = remainingMessages > 0 ? chat.messages.slice(-remainingMessages) : []
        remainingMessages = Math.max(0, remainingMessages - keptMessages.length)
        return { ...chat, messages: keptMessages }
      })
      localStorage.setItem(`scrapconnect-ai-chats:${user.id}`, JSON.stringify(saved))
    } catch {
      setError('Chat history could not be saved in this browser.')
    }
  }, [user?.id, historyOwner, conversations])

  const startNewChat = () => {
    const id = crypto.randomUUID()
    const chat = { id, title: 'New chat', updatedAt: new Date().toISOString(), messages: [] }
    setConversations((current) => [chat, ...current].slice(0, 20))
    setActiveChatId(id)
    setHistoryOpen(false)
    setAnalysis(null)
    setAnalysisImage('')
    setError('')
  }

  const openChat = (chat) => {
    setActiveChatId(chat.id)
    setHistoryOpen(false)
    setAnalysis(null)
    setAnalysisImage('')
    setError('')
  }

  const sendMessage = async (event) => {
    event?.preventDefault()
    const content = draft.trim()
    if (!content || busy || !user) return
    const chatId = activeChatId || crypto.randomUUID()
    const next = [...messages, { role: 'user', content }]
    const currentChat = conversations.find((chat) => chat.id === chatId)
    const firstQuestion = next.find((message) => message.role === 'user')?.content || content
    const title = currentChat?.title && currentChat.title !== 'New chat' ? currentChat.title : firstQuestion.slice(0, 48)
    setActiveChatId(chatId)
    setConversations((current) => [{ id: chatId, title, updatedAt: new Date().toISOString(), messages: next }, ...current.filter((chat) => chat.id !== chatId)].slice(0, 20))
    setDraft('')
    setBusy(true)
    setError('')
    try {
      const reply = await aiService.chatWithAI(next.slice(-20))
      setConversations((current) => current.map((chat) => chat.id === chatId
        ? { ...chat, updatedAt: new Date().toISOString(), messages: [...chat.messages, { role: 'assistant', content: reply }] }
        : chat))
    } catch (requestError) {
      setError(requestError.message || 'Could not reach the AI assistant.')
    } finally {
      setBusy(false)
    }
  }

  const analyzeImage = async (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!user) { setError('Sign in to analyze scrap photos.'); return }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError('Choose a JPG, PNG, or WebP image up to 5 MB.')
      return
    }
    setBusy(true)
    setError('')
    setAnalysis(null)
    setAnalysisImage(URL.createObjectURL(file))
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error('Could not read this image.'))
        reader.readAsDataURL(file)
      })
      const result = await aiService.analyzeScrapImage(dataUrl.split(',')[1], file.type)
      setAnalysis(result)
    } catch (requestError) {
      setError(requestError.message || 'Could not analyze this image.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed bottom-5 right-5 z-40 flex flex-col items-end gap-3">
      {open && <section className="flex h-[min(76vh,620px)] w-[min(92vw,390px)] flex-col overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-2xl" aria-label="ScrapConnect AI assistant">
        <header className="flex items-center justify-between bg-emerald-700 px-4 py-3 text-white">
          <div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/15"><Bot className="h-5 w-5" /></span><div><p className="font-bold">Scrap assistant</p><p className="text-xs text-emerald-100">Orders, scrap & selling help</p></div></div>
          <div className="flex items-center gap-1">
            <button type="button" onClick={startNewChat} aria-label="New chat" title="New chat" className="rounded-full p-2 hover:bg-white/15"><Plus className="h-4 w-4" /></button>
            <button type="button" onClick={() => setHistoryOpen((value) => !value)} aria-label="Chat history" aria-expanded={historyOpen} title="Chat history" className="rounded-full p-2 hover:bg-white/15"><Clock3 className="h-4 w-4" /></button>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close assistant" className="rounded-full p-2 hover:bg-white/15"><X className="h-4 w-4" /></button>
          </div>
        </header>
        {user && historyOpen && <div className="max-h-44 shrink-0 space-y-1 overflow-y-auto border-b border-slate-200 bg-white p-2">
          <p className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Recent chats</p>
          {conversations.length === 0 && <p className="px-2 py-3 text-sm text-slate-500">No previous chats yet.</p>}
          {conversations.map((chat) => <button key={chat.id} type="button" onClick={() => openChat(chat)} className={`w-full truncate rounded-xl px-3 py-2 text-left text-sm ${chat.id === activeChatId ? 'bg-emerald-50 font-semibold text-emerald-800' : 'text-slate-700 hover:bg-slate-50'}`}>{chat.title || 'New chat'}</button>)}
        </div>}
        {!user ? <div className="flex flex-1 flex-col items-center justify-center p-6 text-center"><Sparkles className="h-9 w-9 text-emerald-600" /><p className="mt-3 font-semibold text-slate-900">Sign in to chat</p><p className="mt-1 text-sm text-slate-500">Your assistant can answer pickup questions and analyze scrap photos after you sign in.</p><Link to="/login" onClick={() => setOpen(false)} className="mt-4 rounded-full bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white">Login / Sign up</Link></div> : <>
          <div className="flex-1 space-y-3 overflow-y-auto p-4">
            {messages.length === 0 && <div className="rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-900"><p className="font-semibold">Namaste{user.name ? ', ' + user.name.split(' ')[0] : ''}! Kaise madad karun?</p><p className="mt-1">Pickup status, order amount, scrap rates, ya selling tips ke baare mein poochhein. Photo upload karke scrap estimate bhi lein.</p></div>}
            {messages.map((message, index) => <div key={index} className={`max-w-[88%] rounded-2xl px-3 py-2.5 text-sm ${message.role === 'user' ? 'ml-auto whitespace-pre-wrap bg-emerald-600 text-white' : 'bg-slate-100 text-slate-800'}`}>{message.role === 'assistant' ? <ChatMarkdown content={message.content} /> : message.content}</div>)}
            {busy && <div className="text-xs text-slate-500">Checking your question...</div>}
            {analysisImage && <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-slate-800"><img src={analysisImage} alt="Uploaded scrap for analysis" className="mb-3 max-h-48 w-full rounded-xl bg-white object-contain" />{analysis ? <><div className="font-bold text-emerald-800">{analysis.scrapType}{analysis.subTypes?.length ? ' - ' + analysis.subTypes.join(', ') : ''}</div><div className="mt-1">Approx. weight: {analysis.weightRange.min} to {analysis.weightRange.max} kg</div><div>Estimated value: {formatCurrency(analysis.estimatedValue.min)} to {formatCurrency(analysis.estimatedValue.max)}</div><div className="mt-1 text-xs text-slate-600">Rate: {formatCurrency(analysis.pricePerKg)}/kg - Confidence: {analysis.confidence}%</div>{analysis.description && <p className="mt-2 text-xs">{analysis.description}</p>}<p className="mt-2 text-xs text-slate-600">Photo estimates are approximate; final amount depends on physical weighing and dealer rate.</p></> : <p className="text-xs text-slate-600">{busy ? 'Analyzing this photo...' : 'Photo uploaded.'}</p>}</div>}
          </div>
          {error && <p role="alert" className="px-4 pb-2 text-xs text-red-700">{error}</p>}
          <div className="border-t border-slate-100 p-3">
            <form onSubmit={sendMessage} className="flex items-center gap-2">
              <label className={`flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-slate-100 text-slate-600 hover:bg-emerald-50 hover:text-emerald-700 ${busy ? 'pointer-events-none opacity-50' : ''}`} title="Analyze a scrap photo"><ImagePlus className="h-4 w-4" /><input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={busy} onChange={analyzeImage} /></label>
              <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Ask about your pickup..." maxLength={2000} className="min-w-0 flex-1 rounded-full border border-slate-200 px-4 py-2.5 text-sm outline-none focus:border-emerald-500" />
              <button type="submit" disabled={!draft.trim() || busy} aria-label="Send message" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white disabled:opacity-50"><Send className="h-4 w-4" /></button>
            </form>
            <p className="mt-2 text-center text-[10px] text-slate-400">AI estimates may be inaccurate. Confirm price and weight at pickup.</p>
          </div>
        </>}
      </section>}
      <button type="button" onClick={() => setOpen((value) => !value)} aria-label={open ? 'Close AI assistant' : 'Open AI assistant'} className="flex h-14 items-center gap-2 rounded-full bg-emerald-700 px-5 font-semibold text-white shadow-lg hover:bg-emerald-600"><Bot className="h-5 w-5" /><span>AI Help</span></button>
    </div>
  )
}
function ProtectedRoute({ children, allowedRole }) {
  const { user, loading, configured } = useAuth()

  if (loading) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-slate-600">Checking your secure session…</div>
  }

  if (!configured) {
    return <Navigate to="/login" replace />
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  if (allowedRole && user.role !== allowedRole) {
    const redirect = user.role === 'user' ? '/user/dashboard' : user.role === 'dealer' ? '/dealer/dashboard' : '/admin/dashboard'
    return <Navigate to={redirect} replace />
  }

  return children
}

function LandingPage() {
  const [priceRows, setPriceRows] = useState([])
  useEffect(() => {
    let active = true
    priceService.list()
      .then((rows) => { if (active) setPriceRows(rows) })
      .catch(() => {
        if (active) setPriceRows([])
      })
    return () => { active = false }
  }, [])
  const rateFor = (category) => priceRows.find((row) => row.category === category)?.price_per_kg

  return (
    <div className="bg-slate-50 text-slate-800">
      <header className="border-b border-slate-200 bg-white/90 backdrop-blur-sm sticky top-0 z-20">
        <nav className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 md:px-6">
          <Link to="/" className="flex items-center gap-3 font-bold text-slate-900">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600 text-white shadow-lg shadow-emerald-500/30"><Recycle className="h-5 w-5" /></div>
            <div>
              <div className="text-lg">ScrapConnect</div>
            </div>
          </Link>
          <div className="hidden items-center gap-8 md:flex">
            <a href="#how-it-works" className="text-sm text-slate-600 hover:text-emerald-700">How it works</a>
            <a href="#pricing" className="text-sm text-slate-600 hover:text-emerald-700">Pricing</a>
            <a href="#impact" className="text-sm text-slate-600 hover:text-emerald-700">Impact</a>
            <a href="#faq" className="text-sm text-slate-600 hover:text-emerald-700">FAQ</a>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/login" className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:border-emerald-200 hover:text-emerald-700">Login</Link>
            <Link to="/login" className="rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-emerald-500/25 hover:bg-emerald-500">Sell Scrap</Link>
          </div>
        </nav>
      </header>

      <main>
        <section className="mx-auto grid max-w-7xl gap-10 px-4 py-16 md:px-6 lg:grid-cols-[1.15fr_0.85fr] lg:items-center lg:py-24">
          <div>
            <div className="mb-6 inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-emerald-700">Your Scrap. Your Local Kabadi. One Simple Connection.</div>
            <h1 className="max-w-xl text-4xl font-black tracking-tight text-slate-900 md:text-6xl">Turn Your Scrap Into Value.</h1>
            <p className="mt-6 max-w-xl text-lg text-slate-600">Book doorstep scrap pickup in minutes, get nearest verified kabadiwalas, and turn household waste into fair value without hassle.</p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Link to="/login" className="rounded-full bg-emerald-600 px-6 py-3 font-semibold text-white shadow-lg shadow-emerald-500/25 hover:bg-emerald-500">Sell Scrap</Link>
              <Link to="/login" className="rounded-full border border-slate-200 bg-white px-6 py-3 font-semibold text-slate-700 hover:border-slate-300">Find a Kabadiwala</Link>
            </div>
            <div className="mt-10 flex flex-wrap gap-8 text-sm text-slate-600">
              <div><span className="block text-lg font-bold text-slate-900">Verified</span> local dealer profiles</div>
              <div><span className="block text-lg font-bold text-slate-900">Live</span> pickup status</div>
              <div><span className="block text-lg font-bold text-slate-900">Clear</span> estimated prices</div>
            </div>
          </div>

          <div className="rounded-[2rem] border border-slate-200 bg-white p-4 shadow-soft">
            <div className="rounded-[1.5rem] bg-gradient-to-br from-emerald-500 via-emerald-600 to-green-700 p-5 text-white">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-emerald-100">Marketplace flow</p>
                  <h3 className="mt-2 text-2xl font-bold">Doorstep scrap pickup</h3>
                </div>
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10"><Truck className="h-6 w-6" /></div>
              </div>
              <div className="mt-8 grid gap-4 rounded-2xl bg-white/10 p-4 backdrop-blur-sm">
                <div className="flex items-center justify-between"><span className="text-sm text-emerald-100">Pickup type</span><span className="font-semibold">Household scrap</span></div>
                <div className="flex items-center justify-between"><span className="text-sm text-emerald-100">Dealer assignment</span><span className="font-semibold">Verified local dealers</span></div>
                <div className="flex items-center justify-between"><span className="text-sm text-emerald-100">Updates</span><span className="font-semibold">Live status & messages</span></div>
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl bg-slate-100 p-4"><div className="text-xs text-slate-500">Request</div><div className="mt-2 font-bold text-slate-800">Choose scrap</div></div>
              <div className="rounded-2xl bg-slate-100 p-4"><div className="text-xs text-slate-500">Pickup</div><div className="mt-2 font-bold text-slate-800">Choose a time</div></div>
              <div className="rounded-2xl bg-slate-100 p-4"><div className="text-xs text-slate-500">Payment</div><div className="mt-2 font-bold text-slate-800">Agree after weighing</div></div>
            </div>
          </div>
        </section>

        <section id="how-it-works" className="mx-auto max-w-7xl px-4 py-8 md:px-6 md:py-16">
          <SectionHeader eyebrow="How it works" title="Simple, safe and transparent scrap pickup" description="From request to payment, every step is streamlined for both customers and dealers." />
          <div className="mt-10 grid gap-6 md:grid-cols-4">
            {[1,2,3,4].map((step) => (
              <div key={step} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-lg font-bold text-emerald-700">0{step}</div>
                <h3 className="text-lg font-bold text-slate-900">{['Select scrap', 'Book pickup', 'Track live', 'Get paid'][step - 1]}</h3>
                <p className="mt-3 text-sm text-slate-600">{step === 1 && 'Choose category, quantity and photos for quick booking.'}{step === 2 && 'Schedule or request ASAP pickup from your neighbourhood.'}{step === 3 && 'See real-time status while your kabadiwala is on the way.'}{step === 4 && 'Final weighing updates the payout instantly and securely.'}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="bg-gradient-to-b from-emerald-50 to-white py-12 md:py-16">
          <div className="mx-auto max-w-7xl px-4 md:px-6">
            <SectionHeader eyebrow="Scrap categories" title="From paper to metal, we handle it all" description="Choose from the most common household and commercial scrap types." />
            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {scrapCategories.slice(0, 8).map((category) => (
                <div key={category.id} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft">
                  <div className="mb-3 text-3xl">{category.icon}</div>
                  <div className="flex items-center justify-between gap-4">
                    <h3 className="font-semibold text-slate-800">{category.name}</h3>
                    <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">{rateFor(category.name) ? `₹${rateFor(category.name)}/kg` : 'Check current price'}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="pricing" className="mx-auto max-w-7xl px-4 py-12 md:px-6 md:py-16">
          <SectionHeader eyebrow="How much can you earn?" title="Estimated price. Final price confirmed after weighing." description="Use a transparent estimate before you request a pickup." />
          <div className="mt-8 rounded-3xl border border-slate-200 bg-white p-6 shadow-soft md:p-8">
            <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
              {priceRows.slice(0, 6).map(({ category, price_per_kg }) => (
                <div key={category} className="rounded-2xl bg-slate-50 p-4">
                  <div className="flex items-center justify-between"><span className="font-semibold text-slate-700">{category}</span><span className="text-emerald-700">₹{price_per_kg}/kg</span></div>
                </div>
              ))}
              {priceRows.length === 0 && <p className="text-sm text-slate-500">Current prices are unavailable until the backend is configured.</p>}
            </div>
          </div>
        </section>

        <section className="bg-slate-900 py-12 text-white md:py-16">
          <div className="mx-auto max-w-7xl px-4 md:px-6">
            <SectionHeader eyebrow="Why ScrapConnect" title="Built for trust, convenience and local impact" description="We empower homeowners and dealers with a cleaner, more transparent scrap marketplace." invert />
            <div className="mt-8 grid gap-6 md:grid-cols-3">
              {['Verified local kabadiwalas', 'Live tracking & updates', 'Safer, cleaner neighborhoods'].map((item, index) => (
                <div key={item} className="rounded-3xl border border-slate-700 bg-slate-800 p-6">
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/20 text-emerald-300"><ShieldCheck className="h-6 w-6" /></div>
                  <h3 className="text-lg font-bold">{item}</h3>
                  <p className="mt-2 text-sm text-slate-300">{index === 0 && 'Transparent dealer verification and participation from trusted local professionals.'}{index === 1 && 'See each pickup stage from request accepted to final payment confirmation.'}{index === 2 && 'Reduce landfill waste while creating local jobs and eco impact.'}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="impact" className="mx-auto max-w-7xl px-4 py-12 md:px-6 md:py-16">
          <SectionHeader eyebrow="Environmental impact" title="Track your contribution with every completed pickup" description="Completed pickups record the actual weight of material recovered, so your personal recycling totals reflect real transactions." />
          <div className="mt-8 grid gap-6 md:grid-cols-3">
            {[
              ['Actual weight', 'captured at the pickup'],
              ['Pickup history', 'available in your account'],
              ['Local recycling', 'matched with verified dealers'],
            ].map(([value, label]) => (
              <div key={value} className="rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-soft">
                <div className="text-3xl font-black text-emerald-700">{value}</div>
                <div className="mt-2 text-sm text-slate-600">{label}</div>
              </div>
            ))}
          </div>
        </section>

        <section className="bg-white py-12 md:py-16">
          <div className="mx-auto max-w-7xl px-4 md:px-6">
            <SectionHeader eyebrow="What to expect" title="A clear transaction from request to handoff" description="Status and messages are tied to the pickup so both sides can coordinate with the same information." />
            <div className="mt-8 grid gap-6 md:grid-cols-3">
              {[
                ['Know who is coming', 'See the verified dealer assigned to your pickup, with map location and contact information.'],
                ['Coordinate in one place', 'Message the assigned dealer in a private pickup conversation.'],
                ['Confirm actuals', 'Review actual weight and final amount after the dealer completes weighing.'],
              ].map(([title, body]) => (
                <div key={title} className="rounded-3xl border border-slate-200 bg-slate-50 p-6">
                  <h3 className="font-semibold text-slate-900">{title}</h3>
                  <p className="mt-3 text-sm text-slate-600">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="faq" className="mx-auto max-w-5xl px-4 py-12 md:px-6 md:py-16">
          <SectionHeader eyebrow="FAQ" title="Questions people ask before booking" description="Everything you need to know about selling household scrap." />
          <div className="mt-8 space-y-4">
            {[
              ['Do I need to sort the scrap?', 'No — our dealer can help assess and sort with you during pickup.'],
              ['How is pricing determined?', 'Pricing uses category, weight and condition. Final value is confirmed after actual weighing.'],
              ['Can I schedule a pickup for tomorrow?', 'Yes, you can choose ASAP, today, tomorrow, or a custom time slot.'],
            ].map(([question, answer]) => (
              <div key={question} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between gap-3 font-semibold text-slate-900"><span>{question}</span><ChevronRight className="h-5 w-5 text-slate-400" /></div>
                <p className="mt-2 text-sm text-slate-600">{answer}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 md:grid-cols-4 md:px-6">
          <div>
            <div className="flex items-center gap-3 font-bold text-slate-900"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600 text-white"><Recycle className="h-5 w-5" /></div>ScrapConnect</div>
            <p className="mt-4 text-sm text-slate-600">Your local scrap marketplace for smarter recycling and trusted pickups.</p>
          </div>
          <div>
            <h4 className="font-semibold text-slate-900">Company</h4>
            <ul className="mt-4 space-y-2 text-sm text-slate-600"><li>About</li><li>Careers</li><li>Press</li></ul>
          </div>
          <div>
            <h4 className="font-semibold text-slate-900">Support</h4>
            <ul className="mt-4 space-y-2 text-sm text-slate-600"><li>Help center</li><li>Contact</li><li>Privacy</li></ul>
          </div>
          <div>
            <h4 className="font-semibold text-slate-900">Follow</h4>
            <ul className="mt-4 space-y-2 text-sm text-slate-600"><li>Instagram</li><li>LinkedIn</li><li>Facebook</li></ul>
          </div>
        </div>
      </footer>
    </div>
  )
}

function LoginPage({ showToast }) {
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('')
  const [businessName, setBusinessName] = useState('')
  const [role, setRole] = useState('user')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const { user: authenticatedUser, login, signUp, resetPassword, recoveryPending, updatePassword, configured } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (recoveryPending) setMode('reset')
  }, [recoveryPending])

  const handleSubmit = async (event) => {
    event.preventDefault()
    setError('')
    setNotice('')
    setLoading(true)

    try {
      if (mode === 'reset') {
        await updatePassword(password)
        setNotice('Your password has been updated.')
        const target = authenticatedUser?.role === 'dealer' ? '/dealer/dashboard' : authenticatedUser?.role === 'admin' ? '/admin/dashboard' : '/user/dashboard'
        navigate(target)
      } else if (mode === 'signup') {
        const result = await signUp({ email, password, fullName, phone, businessName, role })
        if (result.needsEmailConfirmation) {
          setNotice('Account created. Confirm your email using the link we sent, then sign in.')
          return
        }
        const user = result.user
        showToast(`Account ready, ${user.name.split(' ')[0]}`)
        navigate(user.role === 'dealer' ? '/dealer/dashboard' : '/user/dashboard')
      } else {
        const user = await login(email, password)
        showToast(`Welcome back, ${user.name.split(' ')[0]}`)
        const target = user.role === 'user' ? '/user/dashboard' : user.role === 'dealer' ? '/dealer/dashboard' : '/admin/dashboard'
        navigate(target)
      }
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-emerald-50 via-white to-slate-100 px-4 py-12">
      <div className="w-full max-w-5xl overflow-hidden rounded-[2rem] border border-slate-200 bg-white shadow-soft">
        <div className="grid md:grid-cols-2">
          <div className="bg-gradient-to-br from-emerald-600 via-emerald-700 to-green-800 p-8 text-white">
            <div className="flex items-center gap-3 font-bold"><div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10"><Recycle className="h-6 w-6" /></div>ScrapConnect</div>
            <h2 className="mt-8 text-3xl font-black">{mode === 'login' ? 'Welcome back' : mode === 'reset' ? 'Choose a new password' : 'Create your account'}</h2>
            <p className="mt-3 text-emerald-100">Sign in securely, request a real pickup, and message your assigned local dealer.</p>
            <div className="mt-10 space-y-4">
              {['Secure email and password login', 'Real pickup requests and status updates', 'Private messages with your assigned dealer'].map((item) => (
                <div key={item} className="flex items-center gap-3 rounded-2xl bg-white/10 px-4 py-3 text-sm text-emerald-50"><CircleCheckBig className="h-5 w-5 text-emerald-200" />{item}</div>
              ))}
            </div>
          </div>
          <div className="p-8 md:p-10">
            <div className="mb-8"><p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-700">Secure account</p><h3 className="mt-2 text-2xl font-bold text-slate-900">{mode === 'login' ? 'Sign in to ScrapConnect' : mode === 'reset' ? 'Update your password' : 'Register your account'}</h3></div>

            {!configured && <p className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">Supabase is not connected yet. Add your project URL and publishable anon key to <code>.env.local</code>, then apply the SQL migration in <code>supabase/migrations</code>.</p>}
            <form onSubmit={handleSubmit} className="space-y-5">
              {mode === 'signup' && <>
                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">Full name</label>
                  <Input value={fullName} onChange={setFullName} placeholder="Your name" required />
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">Account type</label>
                  <select value={role} onChange={(event) => setRole(event.target.value)} className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
                    <option value="user">I want to sell scrap</option>
                    <option value="dealer">I am a scrap dealer</option>
                  </select>
                </div>
                {role === 'dealer' && <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">Shop / business name</label>
                  <Input value={businessName} onChange={setBusinessName} placeholder="Your shop name" required />
                </div>}
                <div>
                  <label className="mb-2 block text-sm font-medium text-slate-700">Mobile number</label>
                  <Input value={phone} onChange={setPhone} placeholder="+91 98765 43210" required />
                </div>
              </>}
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">Email</label>
                <Input fieldType="email" value={email} onChange={setEmail} placeholder="you@example.com" required />
              </div>
              <div>
                <label className="mb-2 block text-sm font-medium text-slate-700">Password</label>
                <Input fieldType="password" value={password} onChange={setPassword} placeholder="At least 8 characters" required minLength={8} />
              </div>
              {mode === 'login' && <div className="flex justify-end text-sm text-slate-500"><button type="button" className="text-emerald-700" onClick={async () => {
                if (!email) {
                  setError('Enter your email first so we know where to send the reset link.')
                  return
                }
                try {
                  await resetPassword(email)
                  setNotice('Password reset link sent. Check your email.')
                } catch (resetErr) {
                  setError(resetErr.message)
                }
              }}>Forgot password?</button></div>}
              {error && <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
              {notice && <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</p>}
              <Button full type="submit" loading={loading || !configured} className="w-full">{loading ? 'Please wait…' : mode === 'login' ? 'Sign in' : mode === 'reset' ? 'Update password' : 'Create account'}</Button>
            </form>

            {mode !== 'reset' && <p className="mt-6 text-center text-sm text-slate-600">
              {mode === 'login' ? 'New to ScrapConnect?' : 'Already have an account?'}{' '}
              <button type="button" className="font-semibold text-emerald-700" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(''); setNotice('') }}>
                {mode === 'login' ? 'Create an account' : 'Sign in'}
              </button>
            </p>}
          </div>
        </div>
      </div>
    </div>
  )
}

function UserLayout({ showToast }) {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [notificationError, setNotificationError] = useState('')

  useEffect(() => {
    if (!user?.id) return undefined
    return activityService.subscribeToNotifications(user.id, () => {
      activityService.getNotifications()
        .then((items) => setUnreadCount(items.filter((item) => !item.read_at).length))
        .catch((error) => setNotificationError(error.message))
    })
  }, [user?.id])

  useEffect(() => {
    let active = true
    activityService.getNotifications()
      .then((items) => { if (active) setUnreadCount(items.filter((item) => !item.read_at).length) })
      .catch((error) => { if (active) setNotificationError(error.message) })
    return () => { active = false }
  }, [])

  const items = [
    { label: 'Dashboard', to: '/user/dashboard', icon: LayoutDashboard },
    { label: 'Sell Scrap', to: '/user/sell', icon: Plus },
    { label: 'Nearby Dealers', to: '/user/find-dealers', icon: Search },
    { label: 'Pickup History', to: '/user/transactions', icon: MapPinned },
    { label: 'Prices', to: '/user/pricing', icon: Wallet },
    { label: 'Transactions', to: '/user/transactions', icon: FileText },
    { label: 'Wallet', to: '/user/wallet', icon: Wallet },
    { label: 'Notifications', to: '/user/notifications', icon: Bell },
    { label: 'Profile', to: '/user/profile', icon: User },
  ]

  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="fixed inset-y-0 left-0 hidden w-72 border-r border-slate-200 bg-white px-5 py-6 lg:block">
        <div className="flex items-center gap-3 pb-5">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-600 text-white">
            <Recycle className="h-5 w-5" />
          </div>
          <div>
            <div className="text-lg font-bold text-slate-900">ScrapConnect</div>
            <div className="text-xs text-slate-500">User app</div>
          </div>
        </div>
        <nav className="mt-8 space-y-2">
          {items.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `flex items-center gap-3 rounded-2xl px-3 py-3 text-sm font-medium transition ${isActive ? 'bg-emerald-50 text-emerald-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}>
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-8 rounded-3xl bg-gradient-to-br from-emerald-600 to-green-700 p-5 text-white">
          <div className="text-xs uppercase tracking-[0.2em] text-emerald-100">Eco impact</div>
          <div className="mt-3 text-3xl font-black">240 kg</div>
          <div className="mt-2 text-sm text-emerald-100">recycled this month</div>
        </div>
        <button onClick={() => { logout(); navigate('/login'); }} className="mt-8 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 hover:border-slate-300">Logout</button>
      </aside>

      <div className="lg:pl-72">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/85 backdrop-blur-sm">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 md:px-6">
            <div className="flex items-center gap-3">
              <button className="rounded-xl border border-slate-200 p-2 lg:hidden" onClick={() => setMenuOpen((prev) => !prev)}><Menu className="h-4 w-4" /></button>
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Welcome back</p>
                <h1 className="text-lg font-bold text-slate-900">{user?.name}</h1>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button className="relative rounded-full border border-slate-200 p-2 text-slate-600" onClick={() => navigate('/user/notifications')}><Bell className="h-4 w-4" />{unreadCount > 0 && <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white">{unreadCount}</span>}</button>
              <button className="rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500" onClick={() => navigate('/user/sell')}>Sell Scrap</button>
            </div>
          </div>
          {menuOpen && (
            <div className="border-t border-slate-200 bg-white px-4 py-4 lg:hidden">
              <div className="space-y-2">
                {items.map((item) => (
                  <NavLink key={item.to} to={item.to} onClick={() => setMenuOpen(false)} className={({ isActive }) => `flex items-center gap-3 rounded-2xl px-3 py-3 text-sm ${isActive ? 'bg-emerald-50 text-emerald-700' : 'text-slate-600'}`}>
                    <item.icon className="h-4 w-4" />
                    {item.label}
                  </NavLink>
                ))}
                <button onClick={() => { logout(); navigate('/login'); }} className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left text-sm font-medium text-red-700 hover:bg-red-50">
                  <LogOut className="h-4 w-4" />
                  Logout
                </button>
              </div>
            </div>
          )}
        </header>

        <main className="mx-auto max-w-7xl px-4 py-6 md:px-6">
          {notificationError && <p role="status" className="mb-4 text-xs text-slate-500">Notification count unavailable: {notificationError}</p>}
          <Routes>
            <Route path="/dashboard" element={<UserDashboardPage />} />
            <Route path="/sell" element={<SellScrapPage showToast={showToast} />} />
            <Route path="/find-dealers" element={<FindDealersPage />} />
            <Route path="/dealers/:id" element={<DealerPublicProfilePage />} />
            <Route path="/tracking/:id" element={<PickupTrackingPage />} />
            <Route path="/pricing" element={<PriceEstimatorPage />} />
            <Route path="/transactions" element={<TransactionsPage />} />
            <Route path="/wallet" element={<WalletPage />} />
            <Route path="/reviews" element={<RatingPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="*" element={<Navigate to="/user/dashboard" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}

function UserDashboardPage() {
  const [items, setItems] = useState([])
  const [walletTransactions, setWalletTransactions] = useState([])
  const [notifications, setNotifications] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const { user } = useAuth()

  useEffect(() => {
    let active = true
    Promise.allSettled([
      activityService.getMyPickups(),
      walletService.listTransactions(),
      activityService.getNotifications(),
    ]).then(([pickupResult, walletResult, notificationResult]) => {
      if (!active) return
      if (pickupResult.status === 'fulfilled') setItems(pickupResult.value)
      else setError(pickupResult.reason.message)
      if (walletResult.status === 'fulfilled') setWalletTransactions(walletResult.value)
      if (notificationResult.status === 'fulfilled') setNotifications(notificationResult.value)
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const completed = items.filter((item) => item.status === 'completed')
  const activePickup = items.find((item) => ['requested', 'accepted', 'on_the_way', 'arrived', 'weighing', 'awaiting_confirmation'].includes(item.status))
  const scrapWeight = completed.reduce((sum, item) => sum + Number(item.actual_weight || 0), 0)
  const walletCredits = walletTransactions.filter((item) => item.status === 'paid' && ['wallet_transfer', 'admin_credit', 'pickup_wallet_payment'].includes(item.transaction_type))
  const walletReceived = walletCredits.filter((item) => item.payee_id === user.id).reduce((sum, item) => sum + Number(item.amount_paise) - Number(item.platform_fee_paise), 0)
  const walletSent = walletCredits.filter((item) => item.payer_id === user.id && ['wallet_transfer', 'pickup_wallet_payment'].includes(item.transaction_type)).reduce((sum, item) => sum + Number(item.amount_paise), 0)
  const walletBalance = Math.max(0, walletReceived - walletSent) / 100

  return (
    <div className="space-y-6">
      <div className="rounded-[2rem] bg-gradient-to-br from-emerald-600 via-emerald-700 to-green-800 p-6 text-white shadow-soft">
        <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-emerald-100">Dashboard</p>
            <h2 className="mt-2 text-3xl font-black">Welcome back, {user?.name?.split(' ')[0]}</h2>
          </div>
          <button className="rounded-full bg-white px-5 py-3 font-semibold text-emerald-700" onClick={() => navigate('/user/sell')}>Quick Sell Scrap</button>
        </div>
      </div>

      {error && <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard title="Available wallet balance" value={formatCurrency(walletBalance)} subtitle="Transferable app credits" icon={Wallet} tone="emerald" />
        <StatCard title="Scrap sold" value={`${scrapWeight.toFixed(1)} kg`} subtitle="Actual weighed quantity" icon={Package} tone="sky" />
        <StatCard title="Completed pickups" value={completed.length} subtitle={`${items.length} requests total`} icon={Truck} tone="amber" />
        <StatCard title="Eco impact" value={`${(scrapWeight * 0.75).toFixed(1)} kg`} subtitle="Estimated carbon avoided" icon={Recycle} tone="violet" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft md:p-6">
          {loading && <LoadingState label="Loading pickups…" />}
          {!loading && !activePickup && <EmptyState title="No active pickup" detail="Create a request and follow its progress here." />}
          {activePickup && <>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Active pickup</p>
              <h3 className="mt-2 text-xl font-bold text-slate-900">{activePickup.id.slice(0, 8).toUpperCase()}</h3>
            </div>
            <Badge tone="emerald">{activePickup.status.replaceAll('_', ' ')}</Badge>
          </div>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            <InfoTile label="Dealer" value={activePickup.dealer?.business_name || activePickup.dealer?.full_name || 'Waiting for acceptance'} />
            <InfoTile label="Scrap" value={activePickup.category} />
            <InfoTile label="Estimated value" value={formatCurrency(activePickup.estimated_value)} />
          </div>
          <button className="mt-6 w-full rounded-2xl bg-slate-900 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800" onClick={() => navigate(`/user/tracking/${activePickup.id}`)}>Track pickup</button>
          </>}
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft md:p-6">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Local marketplace</p>
          <h3 className="mt-3 text-xl font-bold text-slate-900">Verified dealers near you</h3>
          <p className="mt-2 text-sm text-slate-600">See verified dealers on the live map using your current location.</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <button className="rounded-full border border-emerald-200 px-4 py-2 text-sm font-semibold text-emerald-700" onClick={() => navigate('/user/find-dealers')}>Explore nearby dealers</button>
            <button className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700" onClick={() => navigate('/user/wallet')}>Open wallet</button>
          </div>
          <div className="mt-6 border-t border-slate-100 pt-4">
            <div className="flex items-center justify-between"><h4 className="font-semibold text-slate-900">Recent updates</h4><Link to="/user/notifications" className="text-xs font-semibold text-emerald-700">All notifications</Link></div>
            <div className="mt-3 space-y-3">
              {notifications.slice(0, 3).map((notification) => <div key={notification.id} className="border-l-2 border-emerald-400 pl-3">
                <p className="text-sm font-medium text-slate-800">{notification.title}</p>
                <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{notification.body}</p>
              </div>)}
              {!loading && notifications.length === 0 && <p className="text-xs text-slate-500">Pickup and payment updates will show here.</p>}
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft md:p-6">
        <div className="flex items-center justify-between"><h3 className="text-xl font-bold text-slate-900">Recent transactions</h3><Link to="/user/transactions" className="text-sm font-medium text-emerald-700">View all</Link></div>
        <div className="mt-5 space-y-3">
          {items.slice(0, 3).map((transaction) => (
            <div key={transaction.id} className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
              <div>
                <p className="font-semibold text-slate-800">{transaction.category}</p>
                <p className="text-xs text-slate-500">{new Date(transaction.created_at).toLocaleDateString()}</p>
              </div>
              <div className="text-right">
                <p className="font-bold text-slate-900">{formatCurrency(transaction.final_amount ?? transaction.estimated_value)}</p>
                <p className="text-xs capitalize text-emerald-700">{transaction.status.replaceAll('_', ' ')}</p>
              </div>
            </div>
          ))}
          {!loading && items.length === 0 && <EmptyState title="No transactions yet" detail="Your pickup requests and payments will appear here." />}
        </div>
      </div>
    </div>
  )
}

function SellScrapPage({ showToast }) {
  const [step, setStep] = useState(1)
  const [category, setCategory] = useState('Paper')
  const [quantity, setQuantity] = useState('18')
  const [unit, setUnit] = useState('kg')
  const [photos, setPhotos] = useState([])
  const [address, setAddress] = useState('')
  const [houseFlat, setHouseFlat] = useState('')
  const [landmark, setLandmark] = useState('')
  const [contactPhone, setContactPhone] = useState('')
  const [coordinates, setCoordinates] = useState(null)
  const [timeSlot, setTimeSlot] = useState('ASAP')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [priceRates, setPriceRates] = useState({})
  const navigate = useNavigate()

  useEffect(() => {
    let active = true
    priceService.list()
      .then((rows) => {
        if (active) setPriceRates(Object.fromEntries(rows.map((row) => [row.category, Number(row.price_per_kg)])))
      })
      .catch((priceError) => { if (active) setError(priceError.message) })
    return () => { active = false }
  }, [])

  const estimate = useMemo(() => {
    const base = priceRates[category] || 0
    return estimateScrapValue(base, Number(quantity || 0), unit)
  }, [category, quantity, unit, priceRates])

  const handleImageUpload = (event) => {
    const files = Array.from(event.target.files || []).slice(0, 3)
    setPhotos(files)
  }

  const steps = [
    'Select scrap',
    'Quantity',
    'Photos',
    'Pickup address',
    'Pickup time',
    'Review',
  ]

  const submitRequest = async () => {
    if (!address.trim() || !coordinates) {
      setError('Add a pickup address and pin the location on the map before submitting.')
      setStep(4)
      return
    }
    if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
      setError('Enter a quantity greater than zero.')
      setStep(2)
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const request = await pickupService.createPickup({
        category,
        quantity,
        unit,
        address,
        houseFlat,
        landmark,
        contactPhone,
        timeSlot,
        estimatedValue: estimate,
        latitude: coordinates.lat,
        longitude: coordinates.lng,
        photos,
      })
      showToast('Pickup request sent to verified local dealers.')
      navigate(`/user/tracking/${request.id}`)
    } catch (submitError) {
      setError(submitError.message)
    } finally {
      setSubmitting(false)
    }
  }

  const locatePickup = async () => {
    try {
      const location = await locationService.getCurrentLocation()
      setCoordinates({ lat: location.lat, lng: location.lng })
      if (!address) setAddress(location.label)
    } catch (locationError) {
      setError(locationError.message)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 rounded-2xl bg-white p-4 shadow-soft">
        {steps.map((label, index) => (
          <div key={label} className="flex items-center gap-2 text-xs font-medium text-slate-500">
            <div className={`flex h-8 w-8 items-center justify-center rounded-full ${index + 1 === step ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'}`}>{index + 1}</div>
            <span>{label}</span>
            {index < steps.length - 1 && <ArrowRight className="h-3 w-3 text-slate-300" />}
          </div>
        ))}
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
        {step === 1 && (
          <div>
            <h3 className="text-2xl font-bold text-slate-900">Step 1: Select scrap category</h3>
            <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {scrapCategories.map((item) => (
                <button key={item.id} type="button" onClick={() => setCategory(item.name)} className={`rounded-2xl border p-4 text-left transition ${category === item.name ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200 bg-slate-50 hover:border-emerald-200'}`}>
                  <div className="text-3xl">{item.icon}</div>
                  <div className="mt-4 flex items-center justify-between"><span className="font-semibold text-slate-900">{item.name}</span><span className="text-xs text-slate-500">{priceRates[item.name] ? `₹${priceRates[item.name]}/kg` : 'Price unavailable'}</span></div>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 2 && (
          <div>
            <h3 className="text-2xl font-bold text-slate-900">Step 2: Enter estimated quantity</h3>
            <div className="mt-6 max-w-md space-y-4">
              <Input value={quantity} onChange={setQuantity} placeholder="18" />
              <select value={unit} onChange={(e) => setUnit(e.target.value)} className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 focus:border-emerald-500 focus:outline-none">
                <option value="kg">kg</option>
                <option value="pieces">pieces</option>
                <option value="approx">approximate quantity</option>
              </select>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h3 className="text-2xl font-bold text-slate-900">Step 3: Upload scrap photos</h3>
            <div className="mt-6 rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
              <input type="file" accept="image/*" multiple onChange={handleImageUpload} className="hidden" id="upload-photos" />
              <label htmlFor="upload-photos" className="inline-flex rounded-full bg-emerald-600 px-5 py-3 text-sm font-semibold text-white cursor-pointer">Choose images</label>
            </div>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              {photos.map((photo) => (
                <div key={photo.name} className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">{photo.name}</div>
              ))}
            </div>
          </div>
        )}

        {step === 4 && (
          <div>
            <h3 className="text-2xl font-bold text-slate-900">Step 4: Pickup address</h3>
            <div className="mt-6 grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
              <div className="space-y-4">
                <Input value={address} onChange={setAddress} placeholder="Address and area" required />
                <Input value={houseFlat} onChange={setHouseFlat} placeholder="House / flat" />
                <Input value={landmark} onChange={setLandmark} placeholder="Landmark" />
                <Input value={contactPhone} onChange={setContactPhone} placeholder="Contact number" fieldType="tel" required />
                <button type="button" onClick={locatePickup} className="rounded-full border border-emerald-200 px-4 py-2 text-sm font-semibold text-emerald-700">
                  Use my current location
                </button>
                <p className="text-xs text-slate-500">Allow location access or click the map to place your pickup pin.</p>
              </div>
              <MapView position={coordinates} onLocationChange={setCoordinates} />
            </div>
          </div>
        )}

        {step === 5 && (
          <div>
            <h3 className="text-2xl font-bold text-slate-900">Step 5: Preferred pickup time</h3>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {['ASAP', 'Today', 'Tomorrow', 'Schedule'].map((option) => (
                <button key={option} onClick={() => setTimeSlot(option)} className={`rounded-2xl border px-4 py-4 text-left ${timeSlot === option ? 'border-emerald-500 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
                  {option}
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 6 && (
          <div>
            <h3 className="text-2xl font-bold text-slate-900">Step 6: Review the request</h3>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <SummaryItem label="Scrap type" value={category} />
              <SummaryItem label="Estimated quantity" value={`${quantity} ${unit}`} />
              <SummaryItem label="Pickup address" value={address} />
              <SummaryItem label="Pickup time" value={timeSlot} />
            </div>
            <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-emerald-800">
              Estimated value: <span className="font-bold">{priceRates[category] ? formatCurrency(estimate) : 'Price unavailable'}</span>
            </div>
          </div>
        )}

        {error && <p role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="mt-8 flex items-center justify-between">
          <button type="button" className="rounded-full border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 disabled:cursor-not-allowed disabled:opacity-40" disabled={step === 1} onClick={() => setStep((prev) => Math.max(1, prev - 1))}>Back</button>
          {step < 6 ? (
            <button type="button" className="rounded-full bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500" onClick={() => setStep((prev) => Math.min(6, prev + 1))}>Continue</button>
          ) : (
            <button type="button" disabled={submitting} className="rounded-full bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50" onClick={submitRequest}>{submitting ? 'Sending request…' : 'Request Pickup'}</button>
          )}
        </div>
      </div>
    </div>
  )
}

function FindDealersPage() {
  const [filter, setFilter] = useState('all')
  const [nearbyDealers, setNearbyDealers] = useState([])
  const [position, setPosition] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const loadNearby = async () => {
      setLoading(true)
      setError('')
      try {
        const current = await locationService.getCurrentLocation()
        const results = await pickupService.getNearbyDealers(current.lat, current.lng)
        if (active) {
          setPosition({ lat: current.lat, lng: current.lng })
          setNearbyDealers(results)
        }
      } catch (loadError) {
        if (active) setError(loadError.message)
      } finally {
        if (active) setLoading(false)
      }
    }
    loadNearby()
    return () => { active = false }
  }, [])

  const visible = filter === 'all'
    ? nearbyDealers
    : nearbyDealers.filter((dealer) => dealer.categories.length === 0 || dealer.categories.includes(filter))

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Nearby kabadiwalas</p>
            <h2 className="mt-2 text-2xl font-bold text-slate-900">Find your best local scrap dealer</h2>
          </div>
          <div className="flex gap-2">
            {['all', 'Paper', 'Iron', 'Plastic'].map((item) => (
              <button key={item} onClick={() => setFilter(item)} className={`rounded-full px-3 py-2 text-sm font-medium ${filter === item ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'}`}>{item === 'all' ? 'All' : item}</button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-5">
          {loading && <LoadingState label="Finding verified dealers near your location…" />}
          {error && <p role="alert" className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{error} Enable location access to see nearby dealers.</p>}
          {!loading && !error && visible.length === 0 && <EmptyState title="No verified dealers found nearby" detail="Try another scrap category or check again from a different location." />}
          {visible.map((dealer) => (
            <div key={dealer.id} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-100 font-bold text-emerald-700">{dealer.name.slice(0, 2).toUpperCase()}</div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-slate-900">{dealer.name}</h3>
                      {dealer.verified && <Badge tone="emerald">Verified</Badge>}
                    </div>
                    <p className="text-sm text-slate-500">{dealer.distance.toFixed(1)} km away · {dealer.eta}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-sm font-semibold text-amber-600"><Star className="h-4 w-4 fill-current" /> {dealer.rating || 'New'}</div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-600">
                {(dealer.categories.length ? dealer.categories : ['All categories']).map((category) => <span key={category} className="rounded-full bg-slate-100 px-2 py-1">{category}</span>)}
              </div>
              <div className="mt-5 grid gap-3 sm:grid-cols-3 text-sm text-slate-600">
                <InfoTile label="Completed pickups" value={`${dealer.pickups}`} />
                <InfoTile label="Service radius" value={`${dealer.service_radius_km} km`} />
                <InfoTile label="Rating" value={`${dealer.rating || 0}/5`} />
              </div>
              <div className="mt-5 flex gap-3">
                <Link to="/user/sell" className="rounded-full bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500">Request Pickup</Link>
                <Link to={`/user/dealers/${dealer.id}`} className="rounded-full border border-slate-200 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700">View Profile</Link>
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Map view</p>
          <MapView compact position={position} dealers={nearbyDealers} />
        </div>
      </div>
    </div>
  )
}

function DealerPublicProfilePage() {
  const { id } = useParams()
  const [dealer, setDealer] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    pickupService.getDealer(id)
      .then((item) => { if (active) setDealer(item) })
      .catch((loadError) => { if (active) setError(loadError.message) })
    return () => { active = false }
  }, [id])

  if (error) return <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>
  if (!dealer) return <LoadingState label="Loading verified dealer profile…" />

  return (
    <div className="space-y-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-2xl font-bold text-slate-900">{dealer.business_name || dealer.full_name}</h2><p className="mt-1 text-sm text-slate-500">{dealer.address || 'Local scrap dealer'}</p></div>
        <Badge tone="emerald">Verified dealer</Badge>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <InfoTile label="Owner" value={dealer.full_name} />
        <InfoTile label="Rating" value={`${dealer.rating || 'New'} / 5`} />
        <InfoTile label="Completed pickups" value={dealer.completed_pickups} />
        <InfoTile label="Service radius" value={`${dealer.service_radius_km} km`} />
        <InfoTile label="Phone" value={dealer.phone || 'Not provided'} />
        <InfoTile label="Scrap categories" value={dealer.scrap_categories.join(', ') || 'All categories'} />
      </div>
      {dealer.latitude && dealer.longitude && <MapView compact position={{ lat: dealer.latitude, lng: dealer.longitude }} dealers={[{ ...dealer, name: dealer.business_name || dealer.full_name }]} />}
      <Link to="/user/sell" className="inline-flex rounded-full bg-emerald-600 px-5 py-3 text-sm font-semibold text-white">Request a pickup</Link>
    </div>
  )
}

function PickupTrackingPage() {
  const { id } = useParams()
  const { user } = useAuth()
  const [request, setRequest] = useState(null)
  const [pickupPayment, setPickupPayment] = useState(null)
  const [error, setError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [loading, setLoading] = useState(true)
  const [cancelling, setCancelling] = useState(false)
  const [cleanupWarning, setCleanupWarning] = useState('')
  const photoCleanupStarted = useRef(false)
  const statuses = [
    ['requested', 'Request sent'],
    ['accepted', 'Dealer accepted'],
    ['on_the_way', 'Pickup on the way'],
    ['arrived', 'Dealer arrived'],
    ['weighing', 'Weighing scrap'],
    ['awaiting_confirmation', 'Confirm weight and amount'],
    ['completed', 'Pickup completed'],
  ]

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const [result, payment] = await Promise.all([
          pickupService.getPickupStatus(id),
          walletService.getPickupPayment(id),
        ])
        if (active) {
          setRequest(result)
          setPickupPayment(payment)
        }
      } catch (loadError) {
        if (active) setError(loadError.message)
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    const unsubscribe = pickupService.subscribeToPickup(id, (event) => {
      if (active && event.new) setRequest((current) => ({ ...current, ...event.new }))
      load()
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [id])

  useEffect(() => {
    if (!request?.dealer_id || ['completed', 'cancelled', 'rejected'].includes(request.status)) return undefined
    return pickupService.subscribeToDealer(request.dealer_id, (event) => {
      if (event.new) setRequest((current) => ({
        ...current,
        dealer: { ...current.dealer, ...event.new },
      }))
    })
  }, [request?.dealer_id, request?.status])

  useEffect(() => {
    if (!request?.photo_urls?.length || !['completed', 'cancelled'].includes(request.status) || photoCleanupStarted.current) return
    photoCleanupStarted.current = true
    pickupService.deleteTerminalPickupPhotos(request.id, request.photo_urls)
      .then(() => setRequest((current) => ({ ...current, photo_urls: [] })))
      .catch((cleanupError) => setCleanupWarning(`Pickup is closed, but photo cleanup failed: ${cleanupError.message}`))
  }, [request?.id, request?.status, request?.photo_urls])

  if (loading) return <LoadingState label="Loading pickup details…" />
  if (error) return <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>
  if (!request) return <EmptyState title="Pickup not found" detail="This pickup may have been removed or the link is incorrect." />

  const activeIndex = statuses.findIndex(([status]) => status === request.status)
  const paymentSuccessful = pickupPayment?.status === 'paid' && ['pickup_wallet_payment', 'pickup_payment'].includes(pickupPayment?.transaction_type)
  const paymentLabel = pickupPayment?.transaction_type === 'pickup_payment'
    ? 'Payment captured · bank settlement'
    : 'Payment successful · wallet transfer'
  const dealer = request.dealer
  const dealerName = dealer?.business_name || dealer?.full_name || 'Finding a verified dealer'
  const dealerPosition = dealer?.latitude != null && dealer?.longitude != null ? { lat: dealer.latitude, lng: dealer.longitude } : null
  const communicationAvailable = !['completed', 'cancelled', 'rejected'].includes(request.status)

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Live pickup tracking</p>
            <h2 className="mt-2 text-2xl font-bold text-slate-900">Request {request.id.slice(0, 8).toUpperCase()}</h2>
          </div>
          <Badge tone={request.status === 'completed' ? 'emerald' : request.status === 'cancelled' ? 'red' : 'amber'}>{request.status.replaceAll('_', ' ')}</Badge>
        </div>

        <div className="mt-6 grid gap-5 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-6">
            <div className="grid gap-4 md:grid-cols-3">
              <InfoTile label="Dealer" value={dealerName} />
              <InfoTile label="Scrap" value={request.category} />
              <InfoTile label="Estimated value" value={formatCurrency(request.estimated_value)} />
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="mb-4 flex items-center justify-between"><h3 className="font-semibold text-slate-900">Status timeline</h3><span className="text-sm text-slate-500">Updates live</span></div>
              <div className="space-y-4">
                {statuses.map(([status, label], index) => {
                  const completed = activeIndex >= index
                  return (
                    <div key={status} className="flex items-center gap-3">
                      <div className={`flex h-7 w-7 items-center justify-center rounded-full ${completed ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-500'}`}>{completed ? <Check className="h-4 w-4" /> : index + 1}</div>
                      <span className={`text-sm ${completed ? 'font-semibold text-slate-900' : 'text-slate-500'}`}>{label}</span>
                    </div>
                  )
                })}
                <div className="flex items-center gap-3">
                  <div className={`flex h-7 w-7 items-center justify-center rounded-full ${paymentSuccessful ? 'bg-emerald-600 text-white' : request.status === 'completed' ? 'bg-amber-100 text-amber-700' : 'bg-slate-200 text-slate-500'}`}>
                    {paymentSuccessful ? <Check className="h-4 w-4" /> : request.status === 'completed' ? <Clock3 className="h-4 w-4" /> : '8'}
                  </div>
                  <span className={`text-sm ${paymentSuccessful ? 'font-semibold text-slate-900' : 'text-slate-500'}`}>
                    {paymentSuccessful ? paymentLabel : request.status === 'completed' ? 'Payment pending' : 'Payment after customer confirmation'}
                  </span>
                  {paymentSuccessful && <span className="ml-auto text-sm font-semibold text-emerald-700">{formatCurrency(Number(pickupPayment.amount_paise) / 100)}</span>}
                </div>
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200 p-4">
              <h3 className="font-semibold text-slate-900">Pickup address</h3>
              <p className="mt-2 text-sm text-slate-600">{request.address}{request.landmark ? ` · ${request.landmark}` : ''}</p>
            </div>
            {request.status === 'awaiting_confirmation' && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
                <h3 className="font-semibold text-amber-950">Confirm the agreed amount</h3>
                <p className="mt-2 text-sm text-amber-900">The dealer recorded {request.actual_weight} kg and {formatCurrency(request.final_amount)}. Confirm only after the pickup and amount have been agreed.</p>
                <p className="mt-2 text-sm text-amber-900">When you confirm, this amount moves instantly from the dealer's app wallet to yours. The dealer needs sufficient wallet balance.</p>
                <button disabled={confirming} onClick={async () => {
                  setConfirming(true)
                  setError('')
                  try {
                    const updated = await pickupService.confirmCompletion(request.id)
                    setRequest((current) => ({ ...current, ...updated }))
                    setPickupPayment(await walletService.getPickupPayment(request.id))
                  } catch (confirmError) {
                    setError(confirmError.message)
                  } finally {
                    setConfirming(false)
                  }
                }} className="mt-4 rounded-full bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{confirming ? 'Confirming…' : 'Confirm and receive payment'}</button>
              </div>
            )}
            {request.status === 'requested' && <button disabled={cancelling} onClick={async () => {
              setCancelling(true)
              setError('')
              try {
                const updated = await pickupService.cancelRequest(request.id)
                setRequest((current) => ({ ...current, ...updated }))
              } catch (cancelError) { setError(cancelError.message) }
              finally { setCancelling(false) }
            }} className="rounded-full border border-red-200 px-4 py-2 text-sm font-semibold text-red-700 disabled:opacity-50">{cancelling ? 'Cancelling…' : 'Cancel pickup request'}</button>}
          </div>

          {communicationAvailable && <div className="rounded-3xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 font-bold text-emerald-700">{dealerName.slice(0, 2).toUpperCase()}</div>
              <div>
                <div className="font-bold text-slate-900">{dealerName}</div>
                <div className="text-xs text-slate-500">{dealer?.verified ? 'Verified dealer' : request.status === 'requested' ? 'Waiting for acceptance' : ''}</div>
              </div>
            </div>
            <div className="mt-5">
              <MapView compact position={{ lat: request.latitude, lng: request.longitude }} dealers={dealerPosition ? [{ ...dealer, name: dealerName, latitude: dealer.latitude, longitude: dealer.longitude }] : []} />
            </div>
            {dealer?.phone && (
              <a href={`tel:${dealer.phone}`} className="mt-5 flex items-center justify-center gap-2 rounded-full bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white">
                <Phone className="h-4 w-4" /> Call dealer
              </a>
            )}
          </div>}
        </div>
      </div>
      {cleanupWarning && <p role="status" className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{cleanupWarning}</p>}
      {dealer && communicationAvailable && request.status !== 'requested' && (
        <PickupChat pickupId={request.id} currentUserId={user.id} />
      )}
    </div>
  )
}

function PickupChat({ pickupId, currentUserId }) {
  const [messages, setMessages] = useState([])
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const items = await messageService.list(pickupId)
        if (active) setMessages(items)
      } catch (loadError) {
        if (active) setError(loadError.message)
      }
    }
    refresh()
    const unsubscribe = messageService.subscribe(pickupId, refresh)
    return () => {
      active = false
      unsubscribe()
    }
  }, [pickupId])

  const send = async (event) => {
    event.preventDefault()
    if (!message.trim()) return
    setSending(true)
    setError('')
    try {
      await messageService.send(pickupId, message)
      setMessage('')
      setMessages(await messageService.list(pickupId))
    } catch (sendError) {
      setError(sendError.message)
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
      <div className="flex items-center gap-3">
        <MessageSquare className="h-5 w-5 text-emerald-700" />
        <div>
          <h3 className="font-bold text-slate-900">Message your dealer</h3>
          <p className="text-xs text-slate-500">Private conversation for this pickup</p>
        </div>
      </div>
      <div className="mt-5 max-h-72 space-y-3 overflow-y-auto rounded-2xl bg-slate-50 p-4">
        {messages.length === 0 && <p className="text-sm text-slate-500">No messages yet. Start the conversation.</p>}
        {messages.map((item) => (
          <div key={item.id} className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${item.sender_id === currentUserId ? 'ml-auto bg-emerald-600 text-white' : 'bg-white text-slate-800 shadow-sm'}`}>
            <div>{item.body}</div>
            <time className={`mt-1 block text-[10px] ${item.sender_id === currentUserId ? 'text-emerald-100' : 'text-slate-400'}`}>{new Date(item.created_at).toLocaleString()}</time>
          </div>
        ))}
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-red-700">{error}</p>}
      <form onSubmit={send} className="mt-4 flex gap-3">
        <Input value={message} onChange={setMessage} placeholder="Write a message…" required maxLength={2000} />
        <button disabled={sending || !message.trim()} className="shrink-0 rounded-full bg-emerald-600 px-5 py-2 text-sm font-semibold text-white disabled:opacity-50">{sending ? 'Sending…' : 'Send'}</button>
      </form>
    </section>
  )
}

function PriceEstimatorPage() {
  const [category, setCategory] = useState('Iron')
  const [quantity, setQuantity] = useState('10')
  const [unit, setUnit] = useState('kg')
  const [prices, setPrices] = useState([])
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    priceService.list()
      .then((rows) => { if (active) setPrices(rows) })
      .catch((loadError) => { if (active) setError(loadError.message) })
    return () => { active = false }
  }, [])

  const estimate = useMemo(() => {
    const rate = Number(prices.find((item) => item.category === category)?.price_per_kg || 0)
    return estimateScrapValue(rate, Number(quantity || 0), unit)
  }, [category, quantity, unit, prices])

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
        <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Price estimator</p>
        <h2 className="mt-2 text-2xl font-bold text-slate-900">Approximate scrap value</h2>
        {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
        <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_0.8fr]">
          <div className="space-y-4">
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-700 focus:border-emerald-500 focus:outline-none">
              {prices.map((item) => <option key={item.category} value={item.category}>{item.category}</option>)}
            </select>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input value={quantity} onChange={setQuantity} placeholder="Quantity" />
              <select value={unit} onChange={(e) => setUnit(e.target.value)} className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-slate-700 focus:border-emerald-500 focus:outline-none">
                <option value="kg">kg</option>
                <option value="pieces">pieces</option>
                <option value="approx">approximate</option>
              </select>
            </div>
          </div>
          <div className="rounded-3xl bg-gradient-to-br from-emerald-50 to-green-50 p-6">
            <div className="text-sm text-slate-500">Estimated value</div>
            <div className="mt-2 text-3xl font-black text-emerald-700">{prices.length ? formatCurrency(estimate) : '—'}</div>
            <p className="mt-4 text-sm text-slate-600">Estimated price. Final price is confirmed after actual weighing and inspection.</p>
          </div>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {prices.map((item) => (
          <div key={item.category} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-soft"><div className="flex items-center justify-between"><span className="font-semibold text-slate-800">{item.category}</span><span className="text-emerald-700">₹{item.price_per_kg}/kg</span></div></div>
        ))}
      </div>
    </div>
  )
}

function TransactionsPage() {
  const [filter, setFilter] = useState('All')
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    activityService.getMyPickups()
      .then((data) => { if (active) setItems(data) })
      .catch((loadError) => { if (active) setError(loadError.message) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  const filtered = filter === 'All'
    ? items
    : items.filter((item) => filter === 'Pending'
      ? ['requested', 'accepted', 'on_the_way', 'arrived', 'weighing'].includes(item.status)
      : item.status === filter.toLowerCase())

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
        <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Transactions</p>
        <h2 className="mt-2 text-2xl font-bold text-slate-900">Pickup history</h2>
        <div className="mt-5 flex flex-wrap gap-2">
          {['All', 'Completed', 'Pending', 'Cancelled'].map((item) => (
            <button key={item} onClick={() => setFilter(item)} className={`rounded-full px-3 py-2 text-sm font-medium ${filter === item ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'}`}>{item}</button>
          ))}
        </div>
      </div>

      <div className="space-y-4">
        {loading && <LoadingState label="Loading your pickup history…" />}
        {error && <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>}
        {!loading && !error && filtered.length === 0 && <EmptyState title="No pickups in this view" detail="Your pickup history will be saved here after you request a collection." />}
        {filtered.map((item) => (
          <div key={item.id} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-bold text-slate-900">{item.category}</h3>
                  <Badge tone={item.status === 'completed' ? 'emerald' : item.status === 'cancelled' ? 'red' : 'amber'}>{item.status.replaceAll('_', ' ')}</Badge>
                </div>
                <p className="mt-2 text-sm text-slate-500">{new Date(item.created_at).toLocaleDateString()} · {item.dealer?.business_name || item.dealer?.full_name || 'Not assigned'}</p>
              </div>
              <div className="text-right">
                <div className="font-black text-slate-900">{formatCurrency(item.final_amount ?? item.estimated_value)}</div>
                <div className="text-sm text-slate-500">{item.actual_weight ?? item.quantity} {item.actual_weight ? 'kg' : item.unit}</div>
                <Link to={`/user/tracking/${item.id}`} className="mt-2 inline-block text-xs font-semibold text-emerald-700">View pickup</Link>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function WalletPage() {
  const { user } = useAuth()
  const [transactions, setTransactions] = useState([])
  const [recipientEmail, setRecipientEmail] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [sending, setSending] = useState(false)

  const loadTransactions = async () => setTransactions(await walletService.listTransactions())
  useEffect(() => {
    let active = true
    walletService.listTransactions()
      .then((data) => { if (active) setTransactions(data) })
      .catch((loadError) => { if (active) setError(loadError.message) })
    return () => { active = false }
  }, [])

  const walletCredits = transactions.filter((item) => item.status === 'paid' && ['wallet_transfer', 'admin_credit', 'pickup_wallet_payment'].includes(item.transaction_type))
  const receivedPaise = walletCredits.filter((item) => item.payee_id === user.id)
    .reduce((sum, item) => sum + Number(item.amount_paise) - Number(item.platform_fee_paise), 0)
  const sentPaise = walletCredits.filter((item) => item.payer_id === user.id && ['wallet_transfer', 'pickup_wallet_payment'].includes(item.transaction_type))
    .reduce((sum, item) => sum + Number(item.amount_paise), 0)
  const balance = Math.max(0, receivedPaise - sentPaise) / 100

  const submitTransfer = async (event) => {
    event.preventDefault()
    setSending(true)
    setError('')
    setSuccess('')
    try {
      await walletService.transferToEmail(recipientEmail, amount, note)
      await loadTransactions()
      setRecipientEmail('')
      setAmount('')
      setNote('')
      setSuccess('Wallet transfer complete.')
    } catch (transferError) {
      setError(transferError.message)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard title="Available app balance" value={formatCurrency(balance)} subtitle="Transferable app credits" icon={Wallet} tone="emerald" />
        <StatCard title="Received" value={formatCurrency(receivedPaise / 100)} subtitle="App wallet credits" icon={TrendingUp} tone="sky" />
        <StatCard title="Sent" value={formatCurrency(sentPaise / 100)} subtitle="Wallet transfers" icon={ArrowRight} tone="amber" />
      </div>
      {error && <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      {success && <p role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{success}</p>}
      <form onSubmit={submitTransfer} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
        <h3 className="text-xl font-bold text-slate-900">Send to another wallet</h3>
        <p className="mt-2 text-sm text-slate-600">Send app credits using the recipient's ScrapConnect email. Transfers are immediate and cannot be cancelled. Pickup payments also use this balance.</p>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <label className="text-sm font-medium text-slate-700">Recipient email<input required type="email" value={recipientEmail} onChange={(event) => setRecipientEmail(event.target.value)} className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 font-normal" placeholder="person@example.com" /></label>
          <label className="text-sm font-medium text-slate-700">Amount (INR)<input required type="number" min="0.01" step="0.01" max="10000000" value={amount} onChange={(event) => setAmount(event.target.value)} className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 font-normal" placeholder="100.00" /></label>
          <label className="text-sm font-medium text-slate-700">Note (optional)<input maxLength="140" value={note} onChange={(event) => setNote(event.target.value)} className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 font-normal" placeholder="Transfer note" /></label>
        </div>
        <button disabled={sending || balance <= 0} className="mt-5 rounded-full bg-emerald-700 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{sending ? 'Sending…' : 'Send credits'}</button>
        {balance <= 0 && <p className="mt-3 text-xs text-slate-500">No transferable balance. Pilot app credits can be added by an admin.</p>}
      </form>
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
        <h3 className="text-xl font-bold text-slate-900">Wallet transaction history</h3>
        <p className="mt-1 text-xs text-slate-500">Razorpay pickup payouts go to the linked bank account and are not counted as app wallet balance.</p>
        <div className="mt-5 space-y-3">
          {transactions.map((item) => {
            const sentByMe = item.payer_id === user.id && item.transaction_type === 'wallet_transfer'
            const incoming = item.payee_id === user.id
            const outgoing = item.payer_id === user.id
            const amountColor = item.status !== 'paid'
              ? 'text-amber-700'
              : incoming ? 'text-emerald-700' : outgoing ? 'text-red-700' : 'text-slate-900'
            const title = item.transaction_type === 'wallet_transfer' ? (sentByMe ? 'Sent wallet transfer' : 'Received wallet transfer') : item.transaction_type === 'pickup_wallet_payment' ? (item.payer_id === user.id ? 'Pickup payment sent' : 'Pickup payment received') : item.transaction_type === 'admin_credit' ? 'Pilot app credit' : item.pickup?.category || 'Pickup bank payout'
            return <div key={item.id} className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3">
              <div><div className="font-semibold text-slate-800">{title}</div><div className="text-xs text-slate-500">{new Date(item.paid_at || item.created_at).toLocaleDateString()}</div>{item.note && <div className="mt-1 text-xs text-slate-500">{item.note}</div>}</div>
              <div className="text-right"><div className={`font-bold ${amountColor}`}>{(sentByMe || (item.transaction_type === 'pickup_wallet_payment' && item.payer_id === user.id) || (item.transaction_type === 'pickup_payment' && item.payer_id === user.id)) ? '−' : '+'}{formatCurrency((Number(item.amount_paise) - Number(item.platform_fee_paise)) / 100)}</div><div className={`text-xs ${item.status === 'paid' ? 'text-emerald-700' : 'text-amber-700'}`}>{item.transaction_type === 'pickup_payment' ? 'Razorpay Route · bank payout' : item.status === 'paid' ? 'Complete' : item.status}</div></div>
            </div>
          })}
          {!error && transactions.length === 0 && <EmptyState title="No wallet activity yet" detail="App credits and wallet transfers will appear here." />}
        </div>
      </div>
    </div>
  )
}

function RatingPage() {
  const [pickups, setPickups] = useState([])
  const [myReviews, setMyReviews] = useState([])
  const [recentReviews, setRecentReviews] = useState([])
  const [pickupId, setPickupId] = useState('')
  const [rating, setRating] = useState(0)
  const [review, setReview] = useState('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let active = true
    Promise.all([
      activityService.getMyPickups(),
      reviewService.getMyReviews(),
      reviewService.getRecentReviews(),
    ]).then(([allPickups, ownReviews, publicReviews]) => {
      if (!active) return
      setPickups(allPickups.filter((item) => item.status === 'completed'))
      setMyReviews(ownReviews)
      setRecentReviews(publicReviews)
    }).catch((loadError) => {
      if (active) setError(loadError.message)
    })
    return () => { active = false }
  }, [])

  const reviewedPickupIds = new Set(myReviews.map((item) => item.pickup_id))
  const reviewable = pickups.filter((item) => !reviewedPickupIds.has(item.id))

  const submitReview = async (event) => {
    event.preventDefault()
    const pickup = reviewable.find((item) => item.id === pickupId)
    if (!pickup || rating < 1) {
      setError('Choose a completed pickup and a star rating.')
      return
    }
    setError('')
    setSaving(true)
    try {
      await reviewService.create({ pickupId, dealerId: pickup.dealer_id, rating, review })
      setMyReviews(await reviewService.getMyReviews())
      setRecentReviews(await reviewService.getRecentReviews())
      setReview('')
      setRating(0)
      setPickupId('')
      setSaved(true)
    } catch (submitError) {
      setError(submitError.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={submitReview} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
        <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Ratings & reviews</p>
        <h2 className="mt-2 text-2xl font-bold text-slate-900">How was your pickup experience?</h2>
        {reviewable.length === 0
          ? <p className="mt-5 text-sm text-slate-600">A completed pickup is required before you can leave a review.</p>
          : <>
            <label className="mt-5 block text-sm font-medium text-slate-700">Completed pickup</label>
            <select value={pickupId} onChange={(event) => setPickupId(event.target.value)} required className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
              <option value="">Select a pickup</option>
              {reviewable.map((item) => <option key={item.id} value={item.id}>{item.category} · {new Date(item.completed_at).toLocaleDateString()}</option>)}
            </select>
            <div role="group" aria-label="Choose a rating" className="mt-5 flex gap-2">
              {Array.from({ length: 5 }).map((_, index) => (
                <button key={index} type="button" aria-label={`${index + 1} star${index ? 's' : ''}`} onClick={() => setRating(index + 1)}>
                  <Star className={`h-8 w-8 ${rating > index ? 'fill-amber-400 text-amber-400' : 'text-slate-300'}`} />
                </button>
              ))}
            </div>
            <textarea value={review} onChange={(event) => setReview(event.target.value)} maxLength={2000} className="mt-5 w-full rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700 focus:border-emerald-500 focus:outline-none" rows="4" placeholder="Optional feedback about the pickup." />
            {saved && <p className="mt-3 text-sm text-emerald-700">Thanks — your review is saved.</p>}
            <button disabled={saving} type="submit" className="mt-5 rounded-full bg-emerald-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Submitting…' : 'Submit review'}</button>
          </>}
        {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
      </form>
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
        <h3 className="text-xl font-bold text-slate-900">Recent customer reviews</h3>
        <div className="mt-5 space-y-4">
          {recentReviews.map((item) => (
            <div key={item.id} className="rounded-2xl bg-slate-50 p-4">
              <div className="flex items-center gap-1">{Array.from({ length: item.rating }).map((_, index) => <Star key={index} className="h-4 w-4 fill-amber-400 text-amber-400" />)}</div>
              {item.review && <p className="mt-3 text-sm text-slate-700">{item.review}</p>}
              <p className="mt-2 text-xs text-slate-500">{item.dealer?.business_name || 'Local scrap dealer'} · {new Date(item.created_at).toLocaleDateString()}</p>
            </div>
          ))}
          {recentReviews.length === 0 && <p className="text-sm text-slate-500">No reviews yet.</p>}
        </div>
      </div>
    </div>
  )
}

function ProfilePage() {
  const { user, refreshProfile } = useAuth()
  const profile = user.profile
  const [phone, setPhone] = useState(profile.phone || '')
  const [address, setAddress] = useState(profile.address || '')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const saveProfile = async (event) => {
    event.preventDefault()
    setSaving(true)
    setSaved(false)
    setError('')
    try {
      await profileService.update({ phone: phone.trim(), address: address.trim() })
      await refreshProfile()
      setSaved(true)
    } catch (saveError) {
      setError(saveError.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={saveProfile} className="space-y-6">
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-100 text-xl font-black text-emerald-700">AM</div>
          <div>
            <h2 className="text-2xl font-bold text-slate-900">{profile.full_name}</h2>
            <p className="text-sm text-slate-500">{user.email}</p>
          </div>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
          <h3 className="text-xl font-bold text-slate-900">Personal information</h3>
          <div className="mt-5 space-y-3 text-sm text-slate-600">
            <label className="flex items-center justify-between gap-4"><span>Phone</span><Input value={phone} onChange={setPhone} fieldType="tel" placeholder="Add a phone number" /></label>
            <div className="flex justify-between"><span>Email</span><span className="font-medium text-slate-900">{user.email}</span></div>
            <div className="flex justify-between"><span>Account type</span><span className="font-medium capitalize text-slate-900">{profile.role}</span></div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
          <h3 className="text-xl font-bold text-slate-900">Default address</h3>
          <div className="mt-5"><Input value={address} onChange={setAddress} placeholder="Street, area and city" /></div>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {saved && <p className="text-sm text-emerald-700">Profile updated.</p>}
      <button disabled={saving} type="submit" className="rounded-full bg-emerald-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save profile'}</button>
    </form>
  )
}

function NotificationsPage() {
  const { user } = useAuth()
  const [items, setItems] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const data = await activityService.getNotifications()
        if (active) setItems(data)
      } catch (loadError) {
        if (active) setError(loadError.message)
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    const unsubscribe = activityService.subscribeToNotifications(user.id, load)
    return () => { active = false; unsubscribe() }
  }, [user.id])

  const markRead = async (id) => {
    try {
      await activityService.markNotificationRead(id)
      setItems((current) => current.map((item) => item.id === id ? { ...item, read_at: new Date().toISOString() } : item))
    } catch (readError) {
      setError(readError.message)
    }
  }

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
      <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Notifications</p>
      <h2 className="mt-2 text-2xl font-bold text-slate-900">Latest updates</h2>
      {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
      <div className="mt-6 space-y-3">
        {loading && <LoadingState label="Loading notifications…" />}
        {items.map((item) => (
          <button type="button" onClick={() => !item.read_at && markRead(item.id)} key={item.id} className={`flex w-full items-start justify-between gap-3 rounded-2xl p-4 text-left ${!item.read_at ? 'bg-emerald-50 border border-emerald-100' : 'bg-slate-50 border border-slate-200'}`}>
            <div>
              <div className="font-semibold text-slate-900">{item.title}</div>
              <div className="mt-1 text-sm text-slate-600">{item.body}</div>
            </div>
            <time className="shrink-0 text-xs text-slate-500">{new Date(item.created_at).toLocaleString()}</time>
          </button>
        ))}
        {!loading && !error && items.length === 0 && <EmptyState title="No notifications yet" detail="Pickup requests, dealer progress, and wallet payments will appear here." />}
      </div>
    </div>
  )
}

function DealerLayout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const items = [
    { label: 'Dashboard', to: '/dealer/dashboard', icon: LayoutDashboard },
    { label: 'Requests', to: '/dealer/requests', icon: Bell },
    { label: 'Earnings', to: '/dealer/earnings', icon: TrendingUp },
    { label: 'Wallet', to: '/dealer/wallet', icon: Wallet },
    { label: 'Profile', to: '/dealer/profile', icon: User },
  ]

  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="fixed inset-y-0 left-0 hidden w-72 border-r border-slate-200 bg-white px-5 py-6 lg:block">
        <div className="flex items-center gap-3 pb-5">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-500 text-white">
            <Recycle className="h-5 w-5" />
          </div>
          <div>
            <div className="text-lg font-bold text-slate-900">ScrapConnect</div>
            <div className="text-xs text-slate-500">Dealer app</div>
          </div>
        </div>
        <nav className="mt-8 space-y-2">
          {items.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `flex items-center gap-3 rounded-2xl px-3 py-3 text-sm font-medium transition ${isActive ? 'bg-amber-50 text-amber-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}>
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <button onClick={() => { logout(); navigate('/login'); }} className="mt-8 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 hover:border-slate-300">Logout</button>
      </aside>

      <div className="lg:pl-72">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/85 backdrop-blur-sm">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 md:px-6">
            <div className="flex items-center gap-3">
              <button className="rounded-xl border border-slate-200 p-2 lg:hidden" aria-label="Toggle dealer navigation" aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen((open) => !open)}><Menu className="h-4 w-4" /></button>
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Dealer portal</p>
                <h1 className="text-lg font-bold text-slate-900">{user?.name}</h1>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Link to="/dealer/requests" className="rounded-full bg-amber-500 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-400">View requests</Link>
            </div>
          </div>
          {mobileMenuOpen && <nav className="grid grid-cols-2 gap-2 border-t border-slate-200 bg-white px-4 py-3 lg:hidden">
            {items.map((item) => <NavLink key={item.to} to={item.to} onClick={() => setMobileMenuOpen(false)} className={({ isActive }) => `flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium ${isActive ? 'bg-amber-50 text-amber-700' : 'text-slate-600'}`}><item.icon className="h-4 w-4" />{item.label}</NavLink>)}
            <button onClick={() => { logout(); navigate('/login'); }} className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-red-700"><LogOut className="h-4 w-4" />Logout</button>
          </nav>}
        </header>

        <main className="mx-auto max-w-7xl px-4 py-6 md:px-6">
          <Routes>
            <Route path="/dashboard" element={<DealerDashboardPage />} />
            <Route path="/requests" element={<DealerRequestsPage />} />
            <Route path="/pickup/:id" element={<DealerPickupPage />} />
            <Route path="/earnings" element={<DealerEarningsPage />} />
            <Route path="/wallet" element={<WalletPage />} />
            <Route path="/profile" element={<DealerProfilePage />} />
            <Route path="*" element={<Navigate to="/dealer/dashboard" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}

function DealerDashboardPage() {
  const { user } = useAuth()
  const [requests, setRequests] = useState([])
  const [walletTransactions, setWalletTransactions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    const load = async () => {
      const [requestResult, walletResult] = await Promise.allSettled([
        pickupService.getDealerRequests(),
        walletService.listTransactions(),
      ])
      if (!active) return
      if (requestResult.status === 'fulfilled') setRequests(requestResult.value)
      else setError(requestResult.reason.message)
      if (walletResult.status === 'fulfilled') setWalletTransactions(walletResult.value)
      else setError((current) => current || walletResult.reason.message)
      setLoading(false)
    }
    load()
    const unsubscribe = activityService.subscribeToNotifications(user.id, load)
    return () => { active = false; unsubscribe() }
  }, [user.id])

  const completed = requests.filter((request) => request.status === 'completed')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const walletCredits = walletTransactions.filter((item) => item.status === 'paid' && ['wallet_transfer', 'admin_credit', 'pickup_wallet_payment'].includes(item.transaction_type))
  const receivedPaise = walletCredits.filter((item) => item.payee_id === user.id).reduce((sum, item) => sum + Number(item.amount_paise) - Number(item.platform_fee_paise), 0)
  const sentPaise = walletCredits.filter((item) => item.payer_id === user.id && ['wallet_transfer', 'pickup_wallet_payment'].includes(item.transaction_type)).reduce((sum, item) => sum + Number(item.amount_paise), 0)
  const walletBalance = Math.max(0, receivedPaise - sentPaise) / 100
  const paidOutTodayPaise = walletTransactions.filter((item) => item.status === 'paid' && item.transaction_type === 'pickup_wallet_payment' && item.payer_id === user.id && new Date(item.paid_at || item.created_at) >= today).reduce((sum, item) => sum + Number(item.amount_paise), 0)
  const openRequests = requests.filter((request) => request.status === 'requested')
  const activeRequests = requests.filter((request) => ['accepted', 'on_the_way', 'arrived', 'weighing', 'awaiting_confirmation'].includes(request.status))
  const stats = [
    { title: 'Available wallet balance', value: formatCurrency(walletBalance), icon: Wallet },
    { title: 'New requests', value: openRequests.length, icon: Bell },
    { title: 'Active pickups', value: activeRequests.length, icon: Truck },
    { title: 'Paid to customers today', value: formatCurrency(paidOutTodayPaise / 100), icon: Check },
  ]

  const lastSevenDays = Array.from({ length: 7 }, (_, index) => {
    const day = new Date(today)
    day.setDate(today.getDate() - (6 - index))
    const paid = walletTransactions.filter((item) => item.status === 'paid' && item.transaction_type === 'pickup_wallet_payment' && item.payer_id === user.id && new Date(item.paid_at || item.created_at).toDateString() === day.toDateString())
    return { day, total: paid.reduce((sum, item) => sum + Number(item.amount_paise), 0) / 100 }
  })
  const maxDailyPayout = Math.max(1, ...lastSevenDays.map((item) => item.total))

  return (
    <div className="space-y-6">
      {error && <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{stats.map((item) => <StatCard key={item.title} title={item.title} value={item.value} icon={item.icon} tone="amber" />)}</div>
      <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft md:p-6">
          <div className="flex items-center justify-between"><h3 className="text-xl font-bold text-slate-900">Available requests</h3><Link to="/dealer/requests" className="text-sm font-semibold text-emerald-700">View all</Link></div>
          <div className="mt-5 space-y-4">
            {loading && <LoadingState label="Loading pickup requests…" />}
            {openRequests.slice(0, 3).map((request) => (
              <div key={request.id} className="rounded-2xl border border-slate-200 p-4">
                <div className="flex items-center justify-between"><div><div className="font-bold text-slate-900">{request.category}</div><div className="text-sm text-slate-500">{request.address || 'Area available after acceptance'}</div></div><Badge tone="amber">New</Badge></div>
                <div className="mt-3 text-sm text-slate-600">{request.quantity} {request.unit} · {formatCurrency(request.estimated_value)}</div>
                <Link to="/dealer/requests" className="mt-3 inline-flex text-sm font-semibold text-amber-700">Review request <ChevronRight className="ml-1 h-4 w-4" /></Link>
              </div>
            ))}
            {!loading && openRequests.length === 0 && <EmptyState title="No new pickup requests" detail="Available customer requests will appear here." />}
          </div>
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft md:p-6">
          <div className="flex items-center justify-between gap-3"><div><h3 className="text-xl font-bold text-slate-900">Customer payouts</h3><p className="mt-1 text-sm text-slate-500">Wallet payments sent over the last seven days</p></div><Link to="/dealer/wallet" className="text-sm font-semibold text-amber-700">Wallet</Link></div>
          <div className="mt-6 grid h-36 grid-cols-7 items-end gap-2 border-b border-slate-200 px-1">
            {lastSevenDays.map(({ day, total }) => <div key={day.toISOString()} className="flex h-full flex-col items-center justify-end gap-2" title={`${day.toLocaleDateString()}: ${formatCurrency(total)}`}>
              <div className="w-full max-w-8 rounded-t-md bg-amber-400" style={{ height: `${Math.max(total > 0 ? 6 : 0, total / maxDailyPayout * 100)}%` }} />
              <span className="mb-2 text-[10px] text-slate-500">{day.toLocaleDateString('en-IN', { weekday: 'short' })}</span>
            </div>)}
          </div>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <InfoTile label="Completed pickups" value={completed.length} />
            <InfoTile label="Completed pickup value" value={formatCurrency(completed.reduce((total, request) => total + Number(request.final_amount || 0), 0))} />
          </div>
        </div>
      </div>
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft md:p-6">
        <div className="flex items-center justify-between gap-3"><div><h3 className="text-xl font-bold text-slate-900">Work in progress</h3><p className="mt-1 text-sm text-slate-500">Continue an assigned pickup or customer confirmation</p></div><Link to="/dealer/earnings" className="text-sm font-semibold text-amber-700">Earnings history</Link></div>
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {activeRequests.slice(0, 6).map((request) => <Link key={request.id} to={`/dealer/pickup/${request.id}`} className="rounded-2xl border border-slate-200 p-4 transition hover:border-amber-300 hover:bg-amber-50/40">
            <div className="flex items-center justify-between gap-2"><span className="font-semibold text-slate-900">{request.category}</span><Badge tone={request.status === 'awaiting_confirmation' ? 'amber' : 'emerald'}>{request.status.replaceAll('_', ' ')}</Badge></div>
            <p className="mt-2 text-sm text-slate-600">{request.customer || request.address || 'Assigned pickup'}</p>
            <p className="mt-1 text-xs text-slate-500">{request.actual_weight ? `${request.actual_weight} kg · ` : ''}{request.final_amount ? formatCurrency(request.final_amount) : 'Final amount pending'}</p>
          </Link>)}
          {!loading && activeRequests.length === 0 && <p className="text-sm text-slate-500">No active pickups right now.</p>}
        </div>
      </section>
    </div>
  )
}

function DealerRequestsPage() {
  const { user } = useAuth()
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [workingId, setWorkingId] = useState(null)

  const loadRequests = async () => {
    setError('')
    try {
      setRequests(await pickupService.getDealerRequests())
    } catch (loadError) {
      setError(loadError.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadRequests()
    const unsubscribe = activityService.subscribeToNotifications(user.id, loadRequests)
    return unsubscribe
  }, [user.id])

  const handleAction = async (request, action) => {
    setWorkingId(request.id)
    setError('')
    try {
      if (action === 'accept') {
        const accepted = await pickupService.acceptRequest(request.id)
        setRequests((current) => current.map((item) => item.id === request.id ? { ...item, ...accepted } : item))
      } else {
        await pickupService.rejectRequest(request.id)
        setRequests((current) => current.filter((item) => item.id !== request.id))
      }
      await loadRequests()
    } catch (actionError) {
      setError(actionError.message)
    } finally {
      setWorkingId(null)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Live marketplace</p>
        <h2 className="mt-2 text-2xl font-bold text-slate-900">Pickup requests</h2>
        <p className="mt-2 text-sm text-slate-500">Customer address and contact details are shared only after you accept a pickup.</p>
      </div>
      {loading && <LoadingState label="Loading available requests…" />}
      {error && <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      {!loading && requests.length === 0 && <EmptyState title="No open pickup requests" detail="New local requests will appear here as customers book pickups." />}
      {requests.map((request) => (
        <div key={request.id} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-xs uppercase tracking-[0.2em] text-slate-400">{request.status.replaceAll('_', ' ')}</div>
              <h3 className="mt-2 text-xl font-bold text-slate-900">{request.customer || 'New customer request'}</h3>
            </div>
            <Badge tone={request.status === 'accepted' || request.status === 'on_the_way' || request.status === 'arrived' || request.status === 'weighing' ? 'emerald' : 'amber'}>{request.status.replaceAll('_', ' ')}</Badge>
          </div>
          <div className="mt-5 grid gap-3 md:grid-cols-4 text-sm text-slate-600">
            <InfoTile label="Area" value={request.address || 'Shared after acceptance'} />
            <InfoTile label="Scrap" value={request.category} />
            <InfoTile label="Quantity" value={`${request.quantity} ${request.unit}`} />
            <InfoTile label="Estimated value" value={formatCurrency(request.value ?? request.estimated_value)} />
          </div>
          <div className="mt-5 flex gap-3">
            {request.status === 'requested' ? <>
              <button disabled={workingId === request.id} onClick={() => handleAction(request, 'accept')} className="rounded-full bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50">{workingId === request.id ? 'Assigning…' : 'Accept request'}</button>
              <button disabled={workingId === request.id} onClick={() => handleAction(request, 'reject')} className="rounded-full border border-slate-200 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50">Reject</button>
            </> : <Link to={`/dealer/pickup/${request.id}`} className="rounded-full bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white">Manage accepted pickup</Link>}
          </div>
        </div>
      ))}
    </div>
  )
}

function DealerPickupPage() {
  const { id } = useParams()
  const { user } = useAuth()
  const [request, setRequest] = useState(null)
  const [pickupPayment, setPickupPayment] = useState(null)
  const [weight, setWeight] = useState('')
  const [amount, setAmount] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [payingCustomer, setPayingCustomer] = useState(false)
  const [sharingLocation, setSharingLocation] = useState(false)
  const [watchId, setWatchId] = useState(null)

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        const [result, payment] = await Promise.all([
          pickupService.getPickupStatus(id),
          walletService.getPickupPayment(id),
        ])
        if (active) {
          setRequest(result)
          setPickupPayment(payment)
          setWeight(result.actual_weight != null ? String(result.actual_weight) : String(result.quantity))
          setAmount(result.final_amount != null ? String(result.final_amount) : String(result.estimated_value))
        }
      } catch (loadError) {
        if (active) setError(loadError.message)
      }
    }
    load()
    const unsubscribe = pickupService.subscribeToPickup(id, (event) => {
      if (active && event.new) {
        setRequest((current) => ({ ...current, ...event.new }))
        walletService.getPickupPayment(id).then((payment) => {
          if (active) setPickupPayment(payment)
        }).catch((paymentError) => {
          if (active) setError(paymentError.message)
        })
      }
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [id])

  useEffect(() => () => {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId)
  }, [watchId])

  useEffect(() => {
    if (['completed', 'cancelled', 'rejected'].includes(request?.status) && watchId !== null) {
      navigator.geolocation.clearWatch(watchId)
    }
  }, [request?.status, watchId])

  const advance = async (nextStatus) => {
    setSaving(true)
    setError('')
    try {
      const result = await pickupService.updateStatus(
        id,
        nextStatus,
        nextStatus === 'awaiting_confirmation' ? weight : null,
        nextStatus === 'awaiting_confirmation' ? amount : null,
      )
      setRequest(result)
    } catch (updateError) {
      setError(updateError.message)
    } finally {
      setSaving(false)
    }
  }

  const payCustomerFromWallet = async () => {
    setPayingCustomer(true)
    setError('')
    try {
      await walletService.payCompletedPickupFromWallet(id)
      setPickupPayment(await walletService.getPickupPayment(id))
    } catch (paymentError) {
      setError(paymentError.message)
    } finally {
      setPayingCustomer(false)
    }
  }

  const toggleLocationSharing = () => {
    if (watchId !== null) {
      navigator.geolocation.clearWatch(watchId)
      setWatchId(null)
      setSharingLocation(false)
      return
    }
    if (!navigator.geolocation) {
      setError('This browser does not support location sharing.')
      return
    }
    const idValue = navigator.geolocation.watchPosition(
      ({ coords }) => {
        dealerService.updateLocation(coords.latitude, coords.longitude).catch((locationError) => setError(locationError.message))
      },
      (locationError) => setError(locationError.message || 'Could not share your location.'),
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 },
    )
    setWatchId(idValue)
    setSharingLocation(true)
  }

  if (!request) return error ? <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p> : <LoadingState label="Loading accepted pickup…" />

  const nextByStatus = {
    accepted: ['on_the_way', 'Mark as on the way'],
    on_the_way: ['arrived', 'Mark as arrived'],
    arrived: ['weighing', 'Start weighing'],
    weighing: ['awaiting_confirmation', 'Submit amount for customer confirmation'],
  }
  const next = nextByStatus[request.status]

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Assigned pickup</p>
            <h2 className="mt-2 text-2xl font-bold text-slate-900">{request.customer?.full_name || request.address}</h2>
            <p className="mt-1 text-sm text-slate-500">{request.address}{request.landmark ? ` · ${request.landmark}` : ''}</p>
          </div>
          <Badge tone="emerald">{request.status.replaceAll('_', ' ')}</Badge>
        </div>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          <InfoTile label="Scrap category" value={request.category} />
          <InfoTile label="Estimated quantity" value={`${request.quantity} ${request.unit}`} />
          {!['completed', 'cancelled', 'rejected'].includes(request.status) && <InfoTile label="Contact" value={request.contact_phone || request.customer?.phone || 'Not provided'} />}
        </div>
        {!['completed', 'cancelled', 'rejected'].includes(request.status) && <div className="mt-6 flex flex-wrap gap-3">
          {request.contact_phone && <a href={`tel:${request.contact_phone}`} className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700"><Phone className="mr-2 inline h-4 w-4" />Call customer</a>}
          <button onClick={toggleLocationSharing} className={`rounded-full px-4 py-2 text-sm font-semibold ${sharingLocation ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-900 text-white'}`}>{sharingLocation ? 'Stop sharing live location' : 'Share live location'}</button>
          {['accepted', 'on_the_way', 'arrived', 'weighing'].includes(request.status) && <button disabled={saving} onClick={() => advance('cancelled')} className="rounded-full border border-red-200 px-4 py-2 text-sm font-semibold text-red-700 disabled:opacity-50">Cancel pickup</button>}
        </div>}
        {request.status === 'weighing' && <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium text-slate-700">Actual weight (kg)<Input fieldType="number" value={weight} onChange={setWeight} placeholder="Actual weight" min="0.1" step="0.1" required /></label>
          <label className="text-sm font-medium text-slate-700">Final amount (₹)<Input fieldType="number" value={amount} onChange={setAmount} placeholder="Final amount" min="0.01" max="10000000" step="0.01" required /></label>
        </div>}
        {next && <button disabled={saving} onClick={() => advance(next[0])} className="mt-6 rounded-full bg-emerald-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Updating…' : next[1]}</button>}
        {request.status === 'awaiting_confirmation' && <p className="mt-5 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">Waiting for customer confirmation: {request.actual_weight} kg · {formatCurrency(request.final_amount)}.</p>}
        {request.status === 'completed' && <div className="mt-5 rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-800">
          <p>Customer confirmed: {request.actual_weight} kg · {formatCurrency(request.final_amount)}.</p>
          {pickupPayment?.status === 'paid' && pickupPayment.transaction_type === 'pickup_wallet_payment'
            ? <p className="mt-2 font-semibold">Payment successful · {formatCurrency(Number(pickupPayment.amount_paise) / 100)} transferred to customer wallet.</p>
            : pickupPayment?.transaction_type === 'pickup_payment'
              ? <p className="mt-2 font-semibold">{pickupPayment.status === 'paid' ? 'Razorpay bank payment successful.' : `Razorpay bank payment status: ${pickupPayment.status}.`}</p>
              : pickupPayment
                ? <p className="mt-2 text-amber-800">A payment record exists with status “{pickupPayment.status}”. No second payment can be started from this page.</p>
                : <div className="mt-3">
                  <p className="text-amber-800">No payment record exists for this completed pickup. Transfer the agreed amount from your app wallet to the customer.</p>
                  <button type="button" disabled={payingCustomer} onClick={payCustomerFromWallet} className="mt-3 rounded-full bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{payingCustomer ? 'Transferring…' : `Pay ${formatCurrency(request.final_amount)} from wallet`}</button>
                </div>}
        </div>}
        {request.status === 'cancelled' && <p className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-800">This pickup was cancelled.</p>}
        {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
      </div>
      {!['completed', 'cancelled', 'rejected'].includes(request.status) && <PickupChat pickupId={id} currentUserId={user.id} />}
    </div>
  )
}

function DealerEarningsPage() {
  const [completed, setCompleted] = useState([])
  const [paymentStatuses, setPaymentStatuses] = useState({})
  const [payingPickupId, setPayingPickupId] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    pickupService.getDealerRequests()
      .then(async (data) => {
        const settled = data.filter((request) => request.status === 'completed')
        const statuses = await paymentService.getDealerPaymentStatuses(settled.map((request) => request.id))
        if (active) {
          setCompleted(settled)
          setPaymentStatuses(statuses)
        }
      })
      .catch((loadError) => { if (active) setError(loadError.message) })
    return () => { active = false }
  }, [])

  const payCustomer = async (request) => {
    setPayingPickupId(request.id)
    setError('')
    try {
      await walletService.payCompletedPickupFromWallet(request.id)
      setPaymentStatuses((current) => ({ ...current, [request.id]: 'paid' }))
    } catch (paymentError) {
      setError(paymentError.message)
    } finally {
      setPayingPickupId('')
    }
  }

  const now = new Date()
  const since = (days) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  const earnings = (items) => items.reduce((total, item) => total + Number(item.final_amount || 0), 0)
  const todayItems = completed.filter((item) => new Date(item.completed_at || item.created_at) >= since(1))
  const weekItems = completed.filter((item) => new Date(item.completed_at || item.created_at) >= since(7))
  const monthItems = completed.filter((item) => new Date(item.completed_at || item.created_at) >= since(30))
  const todayEarnings = earnings(todayItems)
  const weekEarnings = earnings(weekItems)
  const monthEarnings = earnings(monthItems)
  const average = completed.length ? earnings(completed) / completed.length : 0

  return (
    <div className="space-y-6">
      {error && <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      <div className="grid gap-4 md:grid-cols-4">
        <StatCard title="Today's earnings" value={formatCurrency(todayEarnings)} icon={Wallet} tone="amber" />
        <StatCard title="Weekly earnings" value={formatCurrency(weekEarnings)} icon={TrendingUp} tone="emerald" />
        <StatCard title="Monthly earnings" value={formatCurrency(monthEarnings)} icon={CreditCard} tone="sky" />
        <StatCard title="Average transaction" value={formatCurrency(average)} subtitle={`${completed.length} completed pickups`} icon={Gauge} tone="violet" />
      </div>
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
        <h3 className="text-xl font-bold text-slate-900">Recent daily earnings</h3>
        <div className="mt-8 flex h-40 items-end gap-3">
          {Array.from({ length: 7 }).map((_, index) => {
            const day = new Date(now)
            day.setHours(0, 0, 0, 0)
            day.setDate(day.getDate() - (6 - index))
            const sum = completed
              .filter((item) => new Date(item.completed_at || item.created_at).toDateString() === day.toDateString())
              .reduce((total, item) => total + Number(item.final_amount || 0), 0)
            const max = Math.max(1, ...completed.map((item) => Number(item.final_amount || 0)))
            return <div key={day.toISOString()} title={`${day.toLocaleDateString()}: ${formatCurrency(sum)}`} className="flex-1 rounded-t-2xl bg-gradient-to-t from-amber-500 to-yellow-300" style={{ height: `${Math.max(4, (sum / max) * 100)}%` }} />
          })}
        </div>
      </div>
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
        <h3 className="text-xl font-bold text-slate-900">Pay customers</h3>
        <p className="mt-2 text-sm text-slate-600">For new pickups, payment transfers automatically from your app wallet when the customer confirms the agreed amount.</p>
        <div className="mt-5 space-y-3">
          {completed.map((request) => (
            <div key={request.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-slate-50 px-4 py-3">
              <div>
                <div className="font-semibold text-slate-800">{request.category} · {request.actual_weight} kg</div>
                <div className="text-xs text-slate-500">Pickup {request.id.slice(0, 8).toUpperCase()}</div>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-bold text-slate-900">{formatCurrency(request.final_amount)}</span>
                {paymentStatuses[request.id] === 'paid'
                  ? <span className="text-sm font-semibold text-emerald-700">Paid from wallet</span>
                  : <button type="button" disabled={Boolean(payingPickupId)} onClick={() => payCustomer(request)} className="rounded-full bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{payingPickupId === request.id ? 'Transferring…' : 'Pay from wallet'}</button>}
              </div>
            </div>
          ))}
          {!completed.length && <p className="text-sm text-slate-500">Completed pickups will appear here for payment.</p>}
        </div>
      </div>
    </div>
  )
}

function DealerProfilePage() {
  const { user, refreshProfile } = useAuth()
  const profile = user.profile
  const [businessName, setBusinessName] = useState(profile.business_name || '')
  const [address, setAddress] = useState(profile.address || '')
  const [phone, setPhone] = useState(profile.phone || '')
  const [serviceRadius, setServiceRadius] = useState(String(profile.service_radius_km || 8))
  const [categories, setCategories] = useState(profile.scrap_categories || [])
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sharingLocation, setSharingLocation] = useState(false)

  const toggleCategory = (category) => {
    setCategories((current) => current.includes(category)
      ? current.filter((item) => item !== category)
      : [...current, category])
  }

  const save = async (event) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      await profileService.update({
        business_name: businessName.trim(),
        address: address.trim(),
        phone: phone.trim(),
        service_radius_km: Number(serviceRadius),
        scrap_categories: categories,
      })
      await refreshProfile()
      setSaved(true)
    } catch (saveError) {
      setError(saveError.message)
    } finally {
      setSaving(false)
    }
  }

  const updateCurrentLocation = async () => {
    setError('')
    setSharingLocation(true)
    try {
      const current = await locationService.getCurrentLocation()
      await profileService.update({ latitude: current.lat, longitude: current.lng })
      await refreshProfile()
    } catch (locationError) {
      setError(locationError.message)
    } finally {
      setSharingLocation(false)
    }
  }

  return (
    <form onSubmit={save} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-2xl font-bold text-slate-900">{profile.business_name || 'Set up your shop profile'}</h2><p className="text-sm text-slate-500">Owner: {profile.full_name}</p></div>
        <Badge tone={profile.verified ? 'emerald' : 'amber'}>{profile.verified ? 'Verified dealer' : `Verification ${profile.verification_status}`}</Badge>
      </div>
      {!profile.verified && <p className="mt-5 rounded-2xl bg-amber-50 p-4 text-sm text-amber-900">Your shop becomes visible to customers and eligible for pickup requests after platform verification.</p>}
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <label className="text-sm font-medium text-slate-700">Shop / business name<Input value={businessName} onChange={setBusinessName} placeholder="Your business name" required /></label>
        <label className="text-sm font-medium text-slate-700">Contact phone<Input value={phone} onChange={setPhone} fieldType="tel" placeholder="Phone number" required /></label>
        <label className="text-sm font-medium text-slate-700">Shop address<Input value={address} onChange={setAddress} placeholder="Street, area and city" required /></label>
        <label className="text-sm font-medium text-slate-700">Service radius (km)<Input value={serviceRadius} onChange={setServiceRadius} fieldType="number" min="1" max="100" required /></label>
      </div>
      <div className="mt-5">
        <p className="text-sm font-medium text-slate-700">Scrap categories</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {scrapCategories.map((category) => (
            <label key={category.id} className={`cursor-pointer rounded-full border px-3 py-2 text-sm ${categories.includes(category.name) ? 'border-emerald-500 bg-emerald-50 text-emerald-800' : 'border-slate-200 text-slate-600'}`}>
              <input type="checkbox" className="sr-only" checked={categories.includes(category.name)} onChange={() => toggleCategory(category.name)} />
              {category.name}
            </label>
          ))}
        </div>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" onClick={updateCurrentLocation} disabled={sharingLocation} className="rounded-full border border-emerald-200 px-4 py-2 text-sm font-semibold text-emerald-700 disabled:opacity-50">{sharingLocation ? 'Updating…' : profile.latitude ? 'Refresh live map location' : 'Set dealer map location'}</button>
        <span className="text-xs text-slate-500">{profile.latitude ? 'A map location is set' : 'Set your location to appear in nearby dealer searches.'}</span>
      </div>
      {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
      {saved && <p className="mt-4 text-sm text-emerald-700">Shop profile saved.</p>}
      <button type="submit" disabled={saving} className="mt-6 rounded-full bg-emerald-600 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save profile'}</button>
    </form>
  )
}

function AdminLayout() {
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [exportError, setExportError] = useState('')
  const [exporting, setExporting] = useState(false)

  const exportProfiles = async () => {
    setExporting(true)
    setExportError('')
    try {
      const profiles = await adminService.getProfiles()
      const headers = ['Name', 'Role', 'Phone', 'Business', 'Verification status', 'Created']
      const rows = profiles.map((profile) => [
        profile.full_name,
        profile.role,
        profile.phone || '',
        profile.business_name || '',
        profile.verification_status,
        profile.created_at,
      ])
      const csv = [headers, ...rows]
        .map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(','))
        .join('\r\n')
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `scrapconnect-accounts-${new Date().toISOString().slice(0, 10)}.csv`
      link.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      setExportError(error.message)
    } finally {
      setExporting(false)
    }
  }
  const items = [
    { label: 'Overview', to: '/admin/dashboard', icon: LayoutDashboard },
    { label: 'Users', to: '/admin/users', icon: User },
    { label: 'Dealer Verification', to: '/admin/dealers', icon: ShieldCheck },
    { label: 'Revenue', to: '/admin/revenue', icon: TrendingUp },
    { label: 'Wallet Credits', to: '/admin/wallet-credits', icon: Wallet },
  ]

  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="fixed inset-y-0 left-0 hidden w-72 border-r border-slate-200 bg-white px-5 py-6 lg:block">
        <div className="flex items-center gap-3 pb-5">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-600 text-white"><ShieldCheck className="h-5 w-5" /></div>
          <div>
            <div className="text-lg font-bold text-slate-900">ScrapConnect</div>
            <div className="text-xs text-slate-500">Admin dashboard</div>
          </div>
        </div>
        <nav className="mt-8 space-y-2">
          {items.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `flex items-center gap-3 rounded-2xl px-3 py-3 text-sm font-medium transition ${isActive ? 'bg-violet-50 text-violet-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}>
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <button onClick={() => { logout(); navigate('/login'); }} className="mt-8 w-full rounded-2xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-700 hover:border-slate-300">Logout</button>
      </aside>

      <div className="lg:pl-72">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/85 backdrop-blur-sm">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-4 md:px-6">
            <div className="flex items-center gap-3">
              <button className="rounded-xl border border-slate-200 p-2 lg:hidden" aria-label="Toggle admin navigation" aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen((open) => !open)}><Menu className="h-4 w-4" /></button>
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Admin</p>
                <h1 className="text-lg font-bold text-slate-900">{user?.name}</h1>
              </div>
            </div>
            <button disabled={exporting} onClick={exportProfiles} className="rounded-full bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50">{exporting ? 'Exporting…' : 'Export accounts'}</button>
          </div>
          {mobileMenuOpen && <nav className="grid grid-cols-2 gap-2 border-t border-slate-200 bg-white px-4 py-3 lg:hidden">
            {items.map((item) => <NavLink key={item.to} to={item.to} onClick={() => setMobileMenuOpen(false)} className={({ isActive }) => `flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium ${isActive ? 'bg-violet-50 text-violet-700' : 'text-slate-600'}`}><item.icon className="h-4 w-4" />{item.label}</NavLink>)}
            <button onClick={() => { logout(); navigate('/login'); }} className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-red-700"><LogOut className="h-4 w-4" />Logout</button>
          </nav>}
        </header>

        <main className="mx-auto max-w-7xl px-4 py-6 md:px-6">
          {exportError && <p role="alert" className="mb-4 text-sm text-red-700">{exportError}</p>}
          <Routes>
            <Route path="/dashboard" element={<AdminDashboardPage />} />
            <Route path="/users" element={<AdminUserManagementPage />} />
            <Route path="/dealers" element={<AdminDealerVerificationPage />} />
            <Route path="/revenue" element={<AdminRevenuePage />} />
            <Route path="/wallet-credits" element={<AdminWalletCreditsPage />} />
            <Route path="*" element={<Navigate to="/admin/dashboard" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}

function AdminDashboardPage() {
  const [analytics, setAnalytics] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [lastUpdated, setLastUpdated] = useState(null)

  const loadAnalytics = async () => {
    setLoading(true)
    setError('')
    try {
      setAnalytics(await adminService.getDashboardAnalytics())
      setLastUpdated(new Date())
    } catch (loadError) {
      setError(loadError.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadAnalytics() }, [])

  const monthly = analytics?.monthly || []
  const maxMonthlyRequests = Math.max(1, ...monthly.map((month) => Number(month.requests)))
  const statusColors = {
    requested: '#8b5cf6', accepted: '#3b82f6', on_the_way: '#06b6d4',
    arrived: '#14b8a6', weighing: '#f59e0b', awaiting_confirmation: '#f97316',
    completed: '#10b981', cancelled: '#ef4444', rejected: '#64748b',
  }
  const statusTotal = (analytics?.statuses || []).reduce((sum, item) => sum + Number(item.count), 0)
  let statusOffset = 0
  const statusGradient = (analytics?.statuses || []).map((item) => {
    const start = statusOffset
    statusOffset += statusTotal ? Number(item.count) / statusTotal * 100 : 0
    return `${statusColors[item.status] || '#94a3b8'} ${start}% ${statusOffset}%`
  }).join(', ')

  const metricCards = analytics ? [
    { title: 'Registered users', value: Number(analytics.users).toLocaleString('en-IN'), subtitle: 'Customer accounts', icon: User, tone: 'violet' },
    { title: 'Verified dealers', value: Number(analytics.verifiedDealers).toLocaleString('en-IN'), subtitle: `${analytics.pendingDealers} awaiting review`, icon: ShieldCheck, tone: 'emerald' },
    { title: 'Pickups this month', value: Number(analytics.pickupsThisMonth).toLocaleString('en-IN'), subtitle: `${analytics.activePickups} active now`, icon: Truck, tone: 'amber' },
    { title: 'Recorded pickup value', value: formatCurrency(analytics.grossTransactionValue), subtitle: 'Completed pickups · app ledger value', icon: Wallet, tone: 'sky' },
  ] : []

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 rounded-3xl bg-gradient-to-r from-violet-950 via-violet-800 to-indigo-700 p-6 text-white shadow-soft md:p-8">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-200">Platform overview</p>
          <h2 className="mt-2 text-2xl font-bold md:text-3xl">Good to see you, admin</h2>
          <p className="mt-2 max-w-2xl text-sm text-violet-100">Monitor customer demand, dealer activity and pickup outcomes from one place.</p>
          {lastUpdated && <p className="mt-3 text-xs text-violet-200">Updated {lastUpdated.toLocaleTimeString()}</p>}
        </div>
        <button type="button" disabled={loading} onClick={loadAnalytics} className="inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2.5 text-sm font-semibold text-white hover:bg-white/25 disabled:opacity-60">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh overview
        </button>
      </div>

      {error && <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}<button type="button" onClick={loadAnalytics} className="ml-3 font-semibold underline">Try again</button></div>}
      {loading && !analytics && <LoadingState label="Loading admin analytics…" />}

      {analytics && <>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {metricCards.map((item) => <StatCard key={item.title} title={item.title} value={item.value} subtitle={item.subtitle} icon={item.icon} tone={item.tone} />)}
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft md:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div><h3 className="text-lg font-bold text-slate-900">Pickup activity</h3><p className="mt-1 text-sm text-slate-500">Requests created and completed over the last six months</p></div>
              <div className="flex gap-4 text-xs font-medium text-slate-600"><span><i className="mr-2 inline-block h-2.5 w-2.5 rounded-sm bg-violet-500" />Requests</span><span><i className="mr-2 inline-block h-2.5 w-2.5 rounded-sm bg-emerald-500" />Completed</span></div>
            </div>
            <div className="mt-6 grid h-52 grid-cols-6 gap-3 border-b border-slate-200 px-1">
              {monthly.map((month) => {
                const requests = Number(month.requests)
                const completed = Number(month.completed)
                return <div key={month.label} className="flex min-w-0 flex-col items-center justify-end gap-2">
                  <div className="flex h-40 w-full items-end justify-center gap-1" title={`${requests} requests, ${completed} completed`}>
                    <div className="w-4 max-w-[42%] rounded-t-md bg-violet-500 transition-all" style={{ height: `${Math.max(requests ? 5 : 0, requests / maxMonthlyRequests * 100)}%` }} />
                    <div className="w-4 max-w-[42%] rounded-t-md bg-emerald-500 transition-all" style={{ height: `${Math.max(completed ? 5 : 0, completed / maxMonthlyRequests * 100)}%` }} />
                  </div>
                  <span className="mb-2 text-xs text-slate-500">{month.label}</span>
                </div>
              })}
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <StatCard title="All-time pickups" value={Number(analytics.totalPickups).toLocaleString('en-IN')} icon={Package} tone="violet" />
              <StatCard title="Completed pickups" value={Number(analytics.completedPickups).toLocaleString('en-IN')} icon={Check} tone="emerald" />
            </div>
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft md:p-6">
            <h3 className="text-lg font-bold text-slate-900">Pickup status mix</h3>
            <p className="mt-1 text-sm text-slate-500">Current lifecycle state of all pickup requests</p>
            <div className="mt-6 flex flex-col items-center gap-6 sm:flex-row xl:flex-col 2xl:flex-row">
              <div className="relative h-40 w-40 shrink-0 rounded-full" style={{ background: statusTotal ? `conic-gradient(${statusGradient})` : '#e2e8f0' }}>
                <div className="absolute inset-5 flex flex-col items-center justify-center rounded-full bg-white"><strong className="text-2xl text-slate-900">{Number(analytics.totalPickups).toLocaleString('en-IN')}</strong><span className="text-xs text-slate-500">total requests</span></div>
              </div>
              <div className="grid w-full grid-cols-2 gap-x-4 gap-y-2">
                {(analytics.statuses || []).map((item) => <div key={item.status} className="flex items-center justify-between gap-2 text-xs">
                  <span className="flex items-center gap-2 text-slate-600"><i className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: statusColors[item.status] || '#94a3b8' }} />{item.status.replaceAll('_', ' ')}</span>
                  <strong className="text-slate-900">{item.count}</strong>
                </div>)}
                {!analytics.statuses?.length && <p className="col-span-2 text-sm text-slate-500">No pickup data yet.</p>}
              </div>
            </div>
          </section>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1.15fr_1fr]">
          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft md:p-6">
            <div className="flex items-center justify-between gap-3"><div><h3 className="text-lg font-bold text-slate-900">Popular scrap categories</h3><p className="mt-1 text-sm text-slate-500">Most requested materials</p></div><Link to="/admin/revenue" className="text-sm font-semibold text-violet-700">View revenue</Link></div>
            <div className="mt-5 space-y-4">
              {(analytics.categories || []).map((item) => {
                const maxCategory = Math.max(1, ...analytics.categories.map((category) => Number(category.count)))
                return <div key={item.category}>
                  <div className="mb-1.5 flex justify-between gap-3 text-sm"><span className="font-medium text-slate-700">{item.category}</span><span className="text-slate-500">{item.count} pickups</span></div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-violet-500" style={{ width: `${Number(item.count) / maxCategory * 100}%` }} /></div>
                </div>
              })}
              {!analytics.categories?.length && <p className="text-sm text-slate-500">Category trends will appear after the first request.</p>}
            </div>
          </section>

          <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft md:p-6">
            <div className="flex items-center justify-between gap-3"><div><h3 className="text-lg font-bold text-slate-900">Quick actions</h3><p className="mt-1 text-sm text-slate-500">Common platform operations</p></div></div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {[
                { to: '/admin/dealers', title: 'Review dealers', detail: `${analytics.pendingDealers} pending approval`, icon: ShieldCheck, tone: 'amber' },
                { to: '/admin/users', title: 'Manage accounts', detail: `${analytics.users} users · ${analytics.dealers} dealers`, icon: User, tone: 'violet' },
                { to: '/admin/revenue', title: 'Financial overview', detail: 'Recorded value and estimates', icon: TrendingUp, tone: 'emerald' },
                { to: '/admin/wallet-credits', title: 'Wallet credits', detail: 'Review pilot credit ledger', icon: Wallet, tone: 'sky' },
              ].map((action) => <Link key={action.to} to={action.to} className="rounded-2xl border border-slate-200 p-4 transition hover:border-violet-300 hover:bg-violet-50/50">
                <action.icon className="h-5 w-5 text-violet-700" /><div className="mt-3 font-semibold text-slate-900">{action.title}</div><div className="mt-1 text-xs text-slate-500">{action.detail}</div>
              </Link>)}
            </div>
          </section>
        </div>

        <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft md:p-6">
          <div className="flex items-center justify-between gap-3"><div><h3 className="text-lg font-bold text-slate-900">Recent pickup activity</h3><p className="mt-1 text-sm text-slate-500">Latest customer requests across the platform</p></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">Latest 8</span></div>
          <div className="mt-5 overflow-x-auto">
            <table className="min-w-[680px] w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-slate-400"><tr><th className="pb-3">Pickup</th><th className="pb-3">Customer</th><th className="pb-3">Dealer</th><th className="pb-3">Status</th><th className="pb-3 text-right">Amount</th></tr></thead>
              <tbody>
                {(analytics.recentPickups || []).map((pickup) => <tr key={pickup.id} className="border-t border-slate-100">
                  <td className="py-3"><div className="font-semibold text-slate-800">{pickup.category}</div><div className="text-xs text-slate-500">{new Date(pickup.created_at).toLocaleDateString()}</div></td>
                  <td className="py-3 text-slate-600">{pickup.customer_name || 'Customer'}</td>
                  <td className="py-3 text-slate-600">{pickup.dealer_name || 'Not assigned'}</td>
                  <td className="py-3"><Badge tone={pickup.status === 'completed' ? 'emerald' : ['cancelled', 'rejected'].includes(pickup.status) ? 'red' : 'amber'}>{pickup.status.replaceAll('_', ' ')}</Badge></td>
                  <td className="py-3 text-right font-semibold text-slate-800">{pickup.final_amount != null ? formatCurrency(pickup.final_amount) : '—'}</td>
                </tr>)}
                {!analytics.recentPickups?.length && <tr><td colSpan="5" className="py-8 text-center text-slate-500">No pickups have been created yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-slate-500">Commission is an estimate; real collection and bank settlement are not connected.</p>
        </section>
      </>}
    </div>
  )
}

function AdminUserManagementPage() {
  const [rows, setRows] = useState([])
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    adminService.getProfiles()
      .then((data) => { if (active) setRows(data) })
      .catch((loadError) => { if (active) setError(loadError.message) })
    return () => { active = false }
  }, [])
  const filtered = rows.filter((row) => `${row.full_name} ${row.business_name || ''} ${row.phone || ''}`.toLowerCase().includes(query.toLowerCase()))

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
      <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-2xl font-bold text-slate-900">Account management</h2><Input value={query} onChange={setQuery} placeholder="Search name, shop or phone" /></div>
      {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
      <div className="mt-6 overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="text-slate-500"><tr><th className="pb-3">Name</th><th className="pb-3">Role</th><th className="pb-3">Status</th><th className="pb-3">Action</th></tr></thead>
          <tbody className="text-slate-700">
            {filtered.map((row) => (
              <tr key={row.id} className="border-t border-slate-100">
                <td className="py-3"><div className="font-medium text-slate-900">{row.full_name}</div><div className="text-xs text-slate-500">{row.business_name || row.phone || '—'}</div></td>
                <td className="py-3 capitalize">{row.role}</td>
                <td className="py-3"><Badge tone={row.verified ? 'emerald' : 'amber'}>{row.role === 'dealer' ? row.verification_status : 'Active'}</Badge></td>
                <td className="py-3">{new Date(row.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
            {filtered.length === 0 && <tr><td colSpan="4" className="py-6 text-center text-slate-500">No accounts found.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function AdminDealerVerificationPage() {
  const [dealersToVerify, setDealersToVerify] = useState([])
  const [error, setError] = useState('')
  const [workingId, setWorkingId] = useState(null)
  const load = async () => {
    try {
      setDealersToVerify(await adminService.getUnverifiedDealers())
    } catch (loadError) {
      setError(loadError.message)
    }
  }
  useEffect(() => { load() }, [])

  const setStatus = async (dealer, status) => {
    setWorkingId(dealer.id)
    setError('')
    try {
      await adminService.setDealerVerification(dealer.id, status)
      await load()
    } catch (actionError) {
      setError(actionError.message)
    } finally {
      setWorkingId(null)
    }
  }

  return (
    <div className="space-y-6">
      {error && <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      {dealersToVerify.length === 0 && !error && <EmptyState title="No dealer verifications pending" detail="New dealer registrations will appear here." />}
      {dealersToVerify.map((dealer) => (
        <div key={dealer.id} className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft">
          <div className="flex items-center justify-between"><h3 className="text-xl font-bold text-slate-900">{dealer.business_name}</h3><Badge tone={dealer.verification_status === 'rejected' ? 'red' : 'amber'}>{dealer.verification_status}</Badge></div>
          <div className="mt-5 grid gap-3 md:grid-cols-4 text-sm text-slate-600">
            <InfoTile label="Phone" value={dealer.phone} />
            <InfoTile label="Owner" value={dealer.full_name} />
            <InfoTile label="Address" value={dealer.address || 'Not provided'} />
            <InfoTile label="Submitted date" value={new Date(dealer.created_at).toLocaleDateString()} />
          </div>
          <div className="mt-5 flex gap-3">
            <button disabled={workingId === dealer.id} onClick={() => setStatus(dealer, 'approved')} className="rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Approve dealer</button>
            <button disabled={workingId === dealer.id} onClick={() => setStatus(dealer, 'rejected')} className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50">Reject</button>
          </div>
        </div>
      ))}
    </div>
  )
}

function AdminRevenuePage() {
  const [stats, setStats] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    adminService.getDashboardStats()
      .then((data) => { if (active) setStats(data) })
      .catch((loadError) => { if (active) setError(loadError.message) })
    return () => { active = false }
  }, [])

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
      <h2 className="text-2xl font-bold text-slate-900">Financial estimates</h2>
      <p className="mt-2 text-sm text-slate-500">The 5% commission is an estimate based on recorded pickup amounts. Payments and commission collection are not connected.</p>
      {error && <p role="alert" className="mt-4 text-sm text-red-700">{error}</p>}
      <div className="mt-6 grid gap-4 md:grid-cols-3">
        <StatCard title="Recorded pickup amounts" value={formatCurrency(stats?.grossTransactionValue || 0)} icon={Wallet} tone="emerald" />
        <StatCard title="Estimated 5% commission" value={formatCurrency(stats?.estimatedPlatformCommission || 0)} icon={TrendingUp} tone="amber" />
      </div>
    </div>
  )
}

function AdminWalletCreditsPage() {
  const [email, setEmail] = useState('')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [transactions, setTransactions] = useState([])
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [saving, setSaving] = useState(false)

  const loadCredits = async () => {
    const rows = await walletService.listTransactions()
    setTransactions(rows.filter((row) => row.transaction_type === 'admin_credit'))
  }
  useEffect(() => {
    loadCredits().catch((loadError) => setError(loadError.message))
  }, [])

  const submitCredit = async (event) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    setSuccess('')
    try {
      await walletService.adminCreditToEmail(email, amount, reason)
      await loadCredits()
      setEmail('')
      setAmount('')
      setReason('')
      setSuccess('Pilot app credit added.')
    } catch (creditError) {
      setError(creditError.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950">
        <h2 className="font-bold">Pilot credits only</h2>
        <p className="mt-1">This creates app-only wallet credits. It does not collect money, prove a bank deposit, or enable cash withdrawal. Add credits only for a documented pilot adjustment.</p>
      </div>
      {error && <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>}
      {success && <p role="status" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">{success}</p>}
      <form onSubmit={submitCredit} className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
        <h3 className="text-xl font-bold text-slate-900">Add pilot credit</h3>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          <label className="text-sm font-medium text-slate-700">Account email<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 font-normal" /></label>
          <label className="text-sm font-medium text-slate-700">Amount (INR)<input required type="number" min="0.01" step="0.01" max="10000000" value={amount} onChange={(event) => setAmount(event.target.value)} className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 font-normal" /></label>
          <label className="text-sm font-medium text-slate-700">Reason<input required minLength="4" maxLength="140" value={reason} onChange={(event) => setReason(event.target.value)} className="mt-2 w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 font-normal" placeholder="Pilot adjustment reference" /></label>
        </div>
        <button disabled={saving} className="mt-5 rounded-full bg-violet-700 px-5 py-3 text-sm font-semibold text-white disabled:opacity-50">{saving ? 'Adding…' : 'Add app credit'}</button>
      </form>
      <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-soft">
        <h3 className="text-xl font-bold text-slate-900">Credit audit history</h3>
        <div className="mt-5 space-y-3">
          {transactions.map((row) => <div key={row.id} className="flex items-center justify-between rounded-2xl bg-slate-50 px-4 py-3"><div><div className="font-semibold text-slate-800">{row.note}</div><div className="text-xs text-slate-500">{new Date(row.created_at).toLocaleString()} · {row.payee_id}</div></div><div className="font-bold text-slate-900">{formatCurrency(Number(row.amount_paise) / 100)}</div></div>)}
          {!transactions.length && <p className="text-sm text-slate-500">No pilot credits added.</p>}
        </div>
      </div>
    </div>
  )
}

function NotFoundPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-soft">
        <div className="text-4xl font-black text-slate-900">404</div>
        <h2 className="mt-3 text-2xl font-bold text-slate-900">Page not found</h2>
        <Link to="/" className="mt-6 inline-block rounded-full bg-emerald-600 px-5 py-3 text-sm font-semibold text-white">Back to homepage</Link>
      </div>
    </div>
  )
}

function SectionHeader({ eyebrow, title, description, invert = false }) {
  return (
    <div className="max-w-2xl">
      <p className={`text-xs font-semibold uppercase tracking-[0.2em] ${invert ? 'text-emerald-200' : 'text-emerald-700'}`}>{eyebrow}</p>
      <h2 className={`mt-3 text-3xl font-black tracking-tight ${invert ? 'text-white' : 'text-slate-900'}`}>{title}</h2>
      <p className={`mt-3 text-base ${invert ? 'text-slate-300' : 'text-slate-600'}`}>{description}</p>
    </div>
  )
}

function StatCard({ title, value, subtitle, icon: Icon, tone }) {
  const toneClasses = {
    emerald: 'bg-emerald-100 text-emerald-700',
    sky: 'bg-sky-100 text-sky-700',
    amber: 'bg-amber-100 text-amber-700',
    violet: 'bg-violet-100 text-violet-700',
    red: 'bg-red-100 text-red-700',
  }

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-soft">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-500">{title}</p>
          <div className="mt-3 text-2xl font-black text-slate-900">{value}</div>
        </div>
        <div className={`flex h-12 w-12 items-center justify-center rounded-2xl ${toneClasses[tone] || toneClasses.emerald}`}><Icon className="h-5 w-5" /></div>
      </div>
      {subtitle && <p className="mt-3 text-xs text-slate-500">{subtitle}</p>}
    </div>
  )
}

function Badge({ children, tone = 'emerald' }) {
  const map = {
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    red: 'bg-red-50 text-red-700 border-red-200',
    sky: 'bg-sky-50 text-sky-700 border-sky-200',
  }
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${map[tone]}`}>{children}</span>
}

function Input({ value, onChange, placeholder, fieldType = 'text', ...inputProps }) {
  return (
    <input
      type={fieldType}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none"
      {...inputProps}
    />
  )
}

function SummaryItem({ label, value }) {
  return (
    <div className="rounded-2xl bg-slate-50 p-4">
      <div className="text-xs uppercase tracking-[0.15em] text-slate-400">{label}</div>
      <div className="mt-2 font-semibold text-slate-800">{value}</div>
    </div>
  )
}

function InfoTile({ label, value }) {
  return (
    <div className="rounded-2xl bg-slate-50 p-3">
      <div className="text-xs uppercase tracking-[0.15em] text-slate-400">{label}</div>
      <div className="mt-2 text-sm font-semibold text-slate-800">{value}</div>
    </div>
  )
}

function MapView({ compact = false, position = null, onLocationChange, dealers: mapDealers = [] }) {
  const center = position ? [position.lat, position.lng] : [28.6139, 77.209]
  return (
    <div className={`relative overflow-hidden rounded-3xl border border-slate-200 ${compact ? 'h-64' : 'h-72'}`}>
      <MapContainer center={center} zoom={position ? 14 : 5} scrollWheelZoom className="h-full w-full">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <MapViewport position={position} onLocationChange={onLocationChange} />
        {position && <CircleMarker center={[position.lat, position.lng]} radius={9} pathOptions={{ color: '#047857', fillColor: '#10b981', fillOpacity: 0.9 }}>
          <Popup>Pickup location</Popup>
        </CircleMarker>}
        {mapDealers.map((dealer) => (
          <CircleMarker key={dealer.id} center={[dealer.latitude, dealer.longitude]} radius={8} pathOptions={{ color: '#b45309', fillColor: '#f59e0b', fillOpacity: 0.9 }}>
            <Popup>{dealer.name || dealer.business_name || 'Local scrap dealer'}</Popup>
          </CircleMarker>
        ))}
      </MapContainer>
      {onLocationChange && <p className="pointer-events-none absolute bottom-3 left-3 z-[1000] rounded-full bg-white/95 px-3 py-1 text-xs font-medium text-slate-700 shadow">Click map to pin pickup location</p>}
    </div>
  )
}

function MapViewport({ position, onLocationChange }) {
  const map = useMap()
  const latitude = position?.lat
  const longitude = position?.lng
  useEffect(() => {
    if (latitude !== undefined && longitude !== undefined) {
      map.setView([latitude, longitude], Math.max(map.getZoom(), 14))
    }
  }, [latitude, longitude, map])
  useMapEvents({
    click(event) {
      onLocationChange?.({ lat: event.latlng.lat, lng: event.latlng.lng })
    },
  })
  return null
}

function LoadingState({ label }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-5 text-sm text-slate-600">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-600 border-t-transparent" />
      {label}
    </div>
  )
}

function EmptyState({ title, detail }) {
  return (
    <div className="rounded-3xl border border-dashed border-slate-300 bg-white p-8 text-center">
      <Package className="mx-auto h-8 w-8 text-slate-400" />
      <h3 className="mt-3 font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 text-sm text-slate-500">{detail}</p>
    </div>
  )
}

function Button({ children, full = false, loading = false, type = 'button', className = '', onClick }) {
  return (
    <button type={type} onClick={onClick} className={`rounded-full bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-70 ${full ? 'w-full' : ''} ${className}`} disabled={loading}>
      {loading ? 'Loading...' : children}
    </button>
  )
}

export default App
