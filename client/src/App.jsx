import { useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'

const socket = io('/', {
  autoConnect: false,
  withCredentials: true,
})

const MESSAGE_PAGE_SIZE = 30
const AWAY_AUTO_LOGOUT_MS = 60 * 60 * 1000
const LAST_LEFT_APP_AT_KEY = 'single-chat:last-left-app-at'
const TOP_CLICK_LOAD_ZONE_PX = 130

function mergeUniqueMessages(existing, incoming, options = {}) {
  const prepend = Boolean(options.prepend)
  const ordered = prepend ? [...incoming, ...existing] : [...existing, ...incoming]
  const seen = new Set()

  return ordered.filter((message) => {
    if (seen.has(message.id)) {
      return false
    }
    seen.add(message.id)
    return true
  })
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function FileCard({ file }) {
  const url = `/api/files/${file.id}`
  const [videoUnsupported, setVideoUnsupported] = useState(false)

  if (file.mimeType.startsWith('image/')) {
    return <img className="media image" src={url} alt={file.name} loading="lazy" />
  }

  if (file.mimeType.startsWith('audio/')) {
    return <audio className="media player" src={url} controls preload="metadata" />
  }

  if (file.mimeType.startsWith('video/')) {
    return (
      <>
        <video
          className="media player"
          controls
          preload="metadata"
          playsInline
          onError={() => setVideoUnsupported(true)}
        >
          <source src={url} type={file.mimeType} />
        </video>
        {videoUnsupported && (
          <a className="file-link" href={url} target="_blank" rel="noreferrer">
            Video codec is not supported in this browser. Open/download {file.name}
          </a>
        )}
      </>
    )
  }

  return (
    <a className="file-link" href={url} target="_blank" rel="noreferrer">
      Open {file.name}
    </a>
  )
}

function App() {
  const [user, setUser] = useState(null)
  const [messages, setMessages] = useState([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [hasMoreMessages, setHasMoreMessages] = useState(false)
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false)
  const [nextOffset, setNextOffset] = useState(0)
  const timelineRef = useRef(null)
  const fileInputRef = useRef(null)
  const logoutInFlightRef = useRef(false)
  const shouldScrollToBottomRef = useRef(false)
  const pendingScrollAdjustRef = useRef(null)
  const initialBottomSettledRef = useRef(false)
  const hasMoreMessagesRef = useRef(false)
  const loadingOlderMessagesRef = useRef(false)
  const nextOffsetRef = useRef(0)
  const userRef = useRef(null)

  const sortedMessages = useMemo(
    () => [...messages].sort((a, b) => a.createdAt - b.createdAt),
    [messages],
  )

  useEffect(() => {
    hasMoreMessagesRef.current = hasMoreMessages
  }, [hasMoreMessages])

  useEffect(() => {
    loadingOlderMessagesRef.current = loadingOlderMessages
  }, [loadingOlderMessages])

  useEffect(() => {
    nextOffsetRef.current = nextOffset
  }, [nextOffset])

  useEffect(() => {
    userRef.current = user
  }, [user])

  useEffect(() => {
    const timeline = timelineRef.current
    if (!timeline) {
      return
    }

    if (pendingScrollAdjustRef.current) {
      const { previousScrollHeight, previousScrollTop } = pendingScrollAdjustRef.current
      pendingScrollAdjustRef.current = null
      requestAnimationFrame(() => {
        const delta = timeline.scrollHeight - previousScrollHeight
        timeline.scrollTop = previousScrollTop + delta
      })
      return
    }

    if (!shouldScrollToBottomRef.current) {
      return
    }

    shouldScrollToBottomRef.current = false
    requestAnimationFrame(() => {
      timeline.scrollTop = timeline.scrollHeight
      initialBottomSettledRef.current = true
    })
  }, [sortedMessages])

  useEffect(() => {
    ;(async () => {
      try {
        const res = await fetch('/api/auth/me', { credentials: 'include' })
        if (!res.ok) {
          setLoading(false)
          return
        }

        const data = await res.json()
        setUser(data.user)
      } catch {
        setError('Could not reach server.')
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  useEffect(() => {
    if (!user) {
      return undefined
    }

    const onMessage = (message) => {
      const timeline = timelineRef.current
      const isNearBottom =
        !timeline || timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80
      if (isNearBottom) {
        shouldScrollToBottomRef.current = true
      }
      setMessages((prev) => mergeUniqueMessages(prev, [message]))
    }

    socket.connect()
    socket.on('message:new', onMessage)

    return () => {
      socket.off('message:new', onMessage)
      socket.disconnect()
    }
  }, [user])

  useEffect(() => {
    if (!user) {
      return
    }

    ;(async () => {
      const res = await fetch(`/api/messages?limit=${MESSAGE_PAGE_SIZE}&offset=0`, {
        credentials: 'include',
      })
      if (!res.ok) {
        setError('Failed to load messages.')
        return
      }
      const data = await res.json()
      const pageMessages = data.messages || []
      setMessages((prev) => mergeUniqueMessages(pageMessages, prev))
      setHasMoreMessages(Boolean(data.pagination?.hasMore))
      setNextOffset(Number(data.pagination?.nextOffset || pageMessages.length || 0))
      shouldScrollToBottomRef.current = true
    })()
  }, [user])

  async function loadOlderMessages() {
    if (
      !initialBottomSettledRef.current ||
      !userRef.current ||
      loadingOlderMessagesRef.current ||
      !hasMoreMessagesRef.current
    ) {
      return
    }

    loadingOlderMessagesRef.current = true
    setLoadingOlderMessages(true)
    try {
      const timeline = timelineRef.current
      const previousScrollHeight = timeline?.scrollHeight || 0
      const previousScrollTop = timeline?.scrollTop || 0
      const offsetToLoad = nextOffsetRef.current

      const res = await fetch(`/api/messages?limit=${MESSAGE_PAGE_SIZE}&offset=${offsetToLoad}`, {
        credentials: 'include',
      })

      if (!res.ok) {
        setError('Failed to load older messages.')
        return
      }

      const data = await res.json()
      const olderMessages = data.messages || []

      if (olderMessages.length > 0) {
        pendingScrollAdjustRef.current = {
          previousScrollHeight,
          previousScrollTop,
        }
        setMessages((prev) => mergeUniqueMessages(prev, olderMessages, { prepend: true }))
      }

      const updatedHasMore = Boolean(data.pagination?.hasMore)
      const updatedNextOffset = Number(data.pagination?.nextOffset || offsetToLoad + olderMessages.length)

      hasMoreMessagesRef.current = updatedHasMore
      nextOffsetRef.current = updatedNextOffset
      setHasMoreMessages(updatedHasMore)
      setNextOffset(updatedNextOffset)
    } catch {
      setError('Failed to load older messages.')
    } finally {
      loadingOlderMessagesRef.current = false
      setLoadingOlderMessages(false)
    }
  }

  async function handleLogin(event) {
    event.preventDefault()
    setError('')
    const normalizedUsername = username.trim().toLowerCase()

    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username: normalizedUsername, password }),
    })

    const data = await res.json()
    if (!res.ok) {
      setError(data.error || 'Login failed.')
      return
    }
    setUser(data.user)
  }

  function sendMessage(event) {
    event.preventDefault()
    if (!text.trim()) {
      return
    }
    socket.emit('message:send', { text })
    setText('')
  }

  async function handleFileUpload(event) {
    const file = event.target.files?.[0]
    if (!file) {
      return
    }

    setUploading(true)
    setError('')

    try {
      const formData = new FormData()
      formData.append('file', file)

      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      })

      const data = await res.json()
      if (!res.ok) {
        setError(data.error || 'Upload failed.')
      }
    } catch {
      setError('Upload failed.')
    } finally {
      event.target.value = ''
      setUploading(false)
    }
  }

  async function handleLogout() {
    if (logoutInFlightRef.current) {
      return
    }

    logoutInFlightRef.current = true
    socket.disconnect()
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
    })
    setUser(null)
    setMessages([])
    setHasMoreMessages(false)
    setNextOffset(0)
    localStorage.removeItem(LAST_LEFT_APP_AT_KEY)
    logoutInFlightRef.current = false
  }

  useEffect(() => {
    if (!user) {
      return undefined
    }

    const logoutNow = async (message) => {
      if (logoutInFlightRef.current) {
        return
      }

      logoutInFlightRef.current = true
      socket.disconnect()
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          credentials: 'include',
          keepalive: true,
        })
      } catch {
        // Ignore network errors here; local logout state should still be applied.
      }

      setUser(null)
      setMessages([])
      setHasMoreMessages(false)
      setNextOffset(0)
      setError(message)
      localStorage.removeItem(LAST_LEFT_APP_AT_KEY)
      logoutInFlightRef.current = false
    }

    const checkAwayDurationAndLogoutIfNeeded = () => {
      const lastLeftAtRaw = localStorage.getItem(LAST_LEFT_APP_AT_KEY)
      if (!lastLeftAtRaw) {
        return
      }

      const lastLeftAt = Number(lastLeftAtRaw)
      if (!Number.isFinite(lastLeftAt)) {
        localStorage.removeItem(LAST_LEFT_APP_AT_KEY)
        return
      }

      if (Date.now() - lastLeftAt >= AWAY_AUTO_LOGOUT_MS) {
        logoutNow('Session expired after being away for 1 hour.')
      }
    }

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        localStorage.setItem(LAST_LEFT_APP_AT_KEY, String(Date.now()))
      } else if (document.visibilityState === 'visible') {
        checkAwayDurationAndLogoutIfNeeded()
      }
    }

    const handlePageHide = () => {
      localStorage.setItem(LAST_LEFT_APP_AT_KEY, String(Date.now()))
    }

    checkAwayDurationAndLogoutIfNeeded()

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('pagehide', handlePageHide)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('pagehide', handlePageHide)
    }
  }, [user])

  if (loading) {
    return <main className="screen"><p>Loading...</p></main>
  }

  if (!user) {
    return (
      <main className="screen">
        <section className="auth-card">
          <h1>Private Two-Person Chat</h1>
          <p>Login with your username and password to enter the room.</p>
          <form className="auth-form" onSubmit={handleLogin}>
            <label>
              Username
              <input
                type="text"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </label>
            <button type="submit">Enter Chat</button>
          </form>
          {error && <p className="error">{error}</p>}
        </section>
      </main>
    )
  }

  return (
    <main className="chat-shell">
      <header className="chat-header">
        <div>
          <h2>Secure Chat</h2>
          <p>Logged in as {user.username}</p>
        </div>
        <button className="ghost" type="button" onClick={handleLogout}>Logout</button>
      </header>

      <section
        ref={timelineRef}
        className="timeline"
        aria-live="polite"
        onClick={(event) => {
          if (event.target !== event.currentTarget) {
            return
          }

          const rect = event.currentTarget.getBoundingClientRect()
          const clickY = event.clientY - rect.top
          if (clickY <= TOP_CLICK_LOAD_ZONE_PX) {
            loadOlderMessages()
          }
        }}
      >
        {hasMoreMessages && (
          <button
            type="button"
            className="load-older-hint"
            onClick={loadOlderMessages}
            disabled={loadingOlderMessages}
          >
            {loadingOlderMessages ? 'Loading older messages...' : 'Click here to load older messages'}
          </button>
        )}
        {loadingOlderMessages && <p className="history-status">Loading older messages...</p>}
        {sortedMessages.map((message) => {
          const mine = message.sender.id === user.id
          return (
            <article key={message.id} className={`bubble ${mine ? 'mine' : ''}`}>
              <strong>{message.sender.username}</strong>
              {message.type === 'text' && <p>{message.body}</p>}
              {message.type === 'file' && message.file && <FileCard file={message.file} />}
              <time>{formatTime(message.createdAt)}</time>
            </article>
          )
        })}
      </section>

      <form className="composer" onSubmit={sendMessage}>
        <input
          type="text"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Enter message"
          maxLength={4000}
        />
        <input
          ref={fileInputRef}
          className="hidden"
          type="file"
          accept="image/*,audio/*,video/*,application/pdf"
          onChange={handleFileUpload}
        />
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
          {uploading ? 'Uploading...' : 'Upload file'}
        </button>
        <button type="submit">Send</button>
      </form>

      {error && <p className="error floating">{error}</p>}
    </main>
  )
}

export default App
