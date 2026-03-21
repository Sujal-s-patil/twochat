import { useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'

const socket = io('/', {
  autoConnect: false,
  withCredentials: true,
})

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function FileCard({ file }) {
  const url = `/api/files/${file.id}`

  if (file.mimeType.startsWith('image/')) {
    return <img className="media image" src={url} alt={file.name} loading="lazy" />
  }

  if (file.mimeType.startsWith('audio/')) {
    return <audio className="media player" src={url} controls preload="metadata" />
  }

  if (file.mimeType.startsWith('video/')) {
    return <video className="media player" src={url} controls preload="metadata" />
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
  const endRef = useRef(null)
  const fileInputRef = useRef(null)

  const sortedMessages = useMemo(
    () => [...messages].sort((a, b) => a.createdAt - b.createdAt),
    [messages],
  )

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
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
      setMessages((prev) => [...prev, message])
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
      const res = await fetch('/api/messages', { credentials: 'include' })
      if (!res.ok) {
        setError('Failed to load messages.')
        return
      }
      const data = await res.json()
      setMessages(data.messages || [])
    })()
  }, [user])

  async function handleLogin(event) {
    event.preventDefault()
    setError('')

    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password }),
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
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
    })
    setUser(null)
    setMessages([])
  }

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
          <small>Default users: alice / bob with seeded passwords from server env.</small>
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

      <section className="timeline" aria-live="polite">
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
        <div ref={endRef} />
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
