// components/chat/NegotiationRoom.jsx
// Phase 26 — Real-Time Negotiation Interface
//
// This component is a self-contained React component (Babel-transpiled, no bundler)
// for embedding in a script-tag page. It connects to the Socket.io gateway,
// renders the chat timeline, and surfaces REVISED_OFFER messages as interactive
// "smart bubbles" with an inline Accept button.
//
// Props:
//   bidId      {string}  — MongoDB ObjectId of the bid this room is for
//   token      {string}  — JWT access token for auth handshake & REST calls
//   currentUserId {string} — The logged-in user's MongoDB ObjectId
//   lang       {string}  — 'en' (default) | 'bn' for bilingual UI

const TRANSLATIONS = {
  en: {
    title:           'Negotiation Room',
    connecting:      'Connecting…',
    connected:       'Connected',
    disconnected:    'Disconnected',
    placeholder:     'Type a message…',
    send:            'Send',
    revisedOffer:    'Revised Offer',
    acceptOffer:     'Accept Offer',
    amount:          'Amount',
    days:            'Days',
    offerAccepted:   '✅ Offer Accepted',
    offerSuperseded: 'Superseded',
    makeOffer:       'Make a Revised Offer',
    offerAmount:     'Offer Amount (BDT)',
    offerDays:       'Timeline (Days)',
    submitOffer:     'Submit Offer',
    cancel:          'Cancel',
    loadMore:        'Load older messages',
    systemMsg:       'System',
    errorSend:       'Failed to send. Please retry.',
    errorAccept:     'Failed to accept offer.',
    loadingHistory:  'Loading messages…',
    noMessages:      'No messages yet. Start the negotiation!'
  },
  bn: {
    title:           'আলোচনা কক্ষ',
    connecting:      'সংযুক্ত হচ্ছে…',
    connected:       'সংযুক্ত',
    disconnected:    'সংযোগ বিচ্ছিন্ন',
    placeholder:     'বার্তা লিখুন…',
    send:            'পাঠান',
    revisedOffer:    'সংশোধিত অফার',
    acceptOffer:     'অফার গ্রহণ করুন',
    amount:          'পরিমাণ',
    days:            'দিন',
    offerAccepted:   '✅ অফার গৃহীত হয়েছে',
    offerSuperseded: 'বাতিল',
    makeOffer:       'সংশোধিত অফার করুন',
    offerAmount:     'অফারের পরিমাণ (BDT)',
    offerDays:       'সময়সীমা (দিন)',
    submitOffer:     'অফার জমা দিন',
    cancel:          'বাতিল করুন',
    loadMore:        'পুরনো বার্তা লোড করুন',
    systemMsg:       'সিস্টেম',
    errorSend:       'পাঠাতে ব্যর্থ। পুনরায় চেষ্টা করুন।',
    errorAccept:     'অফার গ্রহণ ব্যর্থ।',
    loadingHistory:  'বার্তা লোড হচ্ছে…',
    noMessages:      'এখনো কোনো বার্তা নেই। আলোচনা শুরু করুন!'
  }
};

// ─────────────────────────────────────────────
// NegotiationRoom — Main Component
// ─────────────────────────────────────────────
function NegotiationRoom({ bidId, token, currentUserId, lang = 'en' }) {
  const t = TRANSLATIONS[lang] || TRANSLATIONS.en;

  const [messages,       setMessages]      = React.useState([]);
  const [text,           setText]          = React.useState('');
  const [socketStatus,   setSocketStatus]  = React.useState('connecting');
  const [error,          setError]         = React.useState(null);
  const [showOfferForm,  setShowOfferForm] = React.useState(false);
  const [offerAmount,    setOfferAmount]   = React.useState('');
  const [offerDays,      setOfferDays]     = React.useState('');
  const [isAccepting,    setIsAccepting]   = React.useState(null); // messageId being accepted
  const [isSending,      setIsSending]     = React.useState(false);
  const [nextCursor,     setNextCursor]    = React.useState(null);
  const [loadingHistory, setLoadingHistory]= React.useState(true);
  const [bidClosed,      setBidClosed]     = React.useState(false);

  const socketRef  = React.useRef(null);
  const bottomRef  = React.useRef(null);
  const socketBase = window.location.origin; // same host/port as REST API

  // ── Fetch paginated history ─────────────────────────────────────────────────
  const fetchHistory = React.useCallback(async (cursor = null) => {
    try {
      const url = cursor
        ? `/api/chat/${bidId}?before=${encodeURIComponent(cursor)}&limit=30`
        : `/api/chat/${bidId}?limit=30`;

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!res.ok) {
        const txt = await res.text();
        let msg = 'Failed to load history.';
        try { msg = JSON.parse(txt).message || msg; } catch (_) {}
        throw new Error(msg);
      }

      const { data } = await res.json();
      setMessages(prev => [...data.messages, ...prev]);
      setNextCursor(data.pagination.nextCursor);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingHistory(false);
    }
  }, [bidId, token]);

  // ── Socket.io connection ─────────────────────────────────────────────────────
  React.useEffect(() => {
    fetchHistory();

    // io() is provided by <script src="/socket.io/socket.io.js">
    const socket = io(socketBase, {
      auth: { token },
      transports: ['websocket', 'polling']
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setSocketStatus('connected');
      socket.emit('join_room', { bidId });
    });

    socket.on('disconnect', () => setSocketStatus('disconnected'));

    socket.on('connect_error', (err) => {
      setSocketStatus('disconnected');
      setError(`Connection error: ${err.message}`);
    });

    socket.on('new_message', (msg) => {
      setMessages(prev => [...prev, msg]);
    });

    socket.on('offer_accepted', ({ bidId: acceptedBid }) => {
      if (acceptedBid === bidId) setBidClosed(true);
    });

    socket.on('error', ({ message }) => setError(message));

    return () => {
      socket.emit('leave_room', { bidId });
      socket.disconnect();
    };
  }, [bidId, token, socketBase]);

  // Auto-scroll to latest message
  React.useEffect(() => {
    if (bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // ── Send plain text message ─────────────────────────────────────────────────
  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || isSending || bidClosed) return;

    setIsSending(true);
    setError(null);

    socketRef.current?.emit('send_message', {
      bidId,
      messageType: 'TEXT',
      text: trimmed
    });

    setText('');
    setIsSending(false);
  };

  // ── Submit a REVISED_OFFER ──────────────────────────────────────────────────
  const handleSubmitOffer = () => {
    const amount = Number(offerAmount);
    const days   = Number(offerDays);

    if (!amount || amount < 100 || !days || days < 1) {
      setError('Please enter a valid amount (≥100) and timeline (≥1 day).');
      return;
    }

    setError(null);
    socketRef.current?.emit('send_message', {
      bidId,
      messageType:   'REVISED_OFFER',
      text:          `Revised offer: ৳${amount.toLocaleString()} in ${days} days.`,
      revisedAmount: amount,
      revisedDays:   days
    });

    setOfferAmount('');
    setOfferDays('');
    setShowOfferForm(false);
  };

  // ── Accept a REVISED_OFFER (CLIENT only) ────────────────────────────────────
  const handleAcceptOffer = async (messageId) => {
    setIsAccepting(messageId);
    setError(null);
    try {
      const res = await fetch(`/api/chat/${bidId}/accept-offer`, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          Authorization:   `Bearer ${token}`
        },
        body: JSON.stringify({ messageId })
      });

      if (!res.ok) {
        const txt = await res.text();
        let msg = t.errorAccept;
        try { msg = JSON.parse(txt).message || msg; } catch (_) {}
        throw new Error(msg);
      }

      setBidClosed(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setIsAccepting(null);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // ── Styles ──────────────────────────────────────────────────────────────────
  const styles = {
    container: {
      display: 'flex', flexDirection: 'column',
      height: '100%', minHeight: '520px', maxHeight: '800px',
      background: 'linear-gradient(135deg, #0f0f23 0%, #1a1a3e 100%)',
      borderRadius: '16px', overflow: 'hidden',
      fontFamily: "'Inter', 'Noto Sans Bengali', sans-serif",
      boxShadow: '0 25px 50px rgba(0,0,0,0.5)',
      border: '1px solid rgba(99,102,241,0.3)'
    },
    header: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '16px 20px',
      background: 'rgba(99,102,241,0.15)',
      backdropFilter: 'blur(10px)',
      borderBottom: '1px solid rgba(99,102,241,0.2)'
    },
    title: {
      margin: 0, color: '#e0e0ff',
      fontSize: '1rem', fontWeight: 700, letterSpacing: '0.02em'
    },
    statusDot: (status) => ({
      display: 'inline-flex', alignItems: 'center', gap: '6px',
      fontSize: '0.75rem', fontWeight: 500,
      color: status === 'connected' ? '#4ade80'
           : status === 'connecting' ? '#facc15'
           : '#f87171'
    }),
    dot: (status) => ({
      width: '8px', height: '8px', borderRadius: '50%',
      background: status === 'connected' ? '#4ade80'
                : status === 'connecting' ? '#facc15'
                : '#f87171',
      animation: status === 'connecting' ? 'pulse 1.5s infinite' : 'none'
    }),
    messageList: {
      flex: 1, overflowY: 'auto', padding: '16px',
      display: 'flex', flexDirection: 'column', gap: '10px',
      scrollbarWidth: 'thin',
      scrollbarColor: 'rgba(99,102,241,0.3) transparent'
    },
    bubble: (isOwn, type) => ({
      maxWidth: '75%', padding: '10px 14px',
      borderRadius: isOwn ? '16px 4px 16px 16px' : '4px 16px 16px 16px',
      alignSelf: isOwn ? 'flex-end' : 'flex-start',
      background: type === 'REVISED_OFFER'
        ? 'linear-gradient(135deg, rgba(245,158,11,0.25), rgba(251,191,36,0.15))'
        : type === 'OFFER_ACCEPTED'
        ? 'linear-gradient(135deg, rgba(74,222,128,0.2), rgba(34,197,94,0.1))'
        : isOwn
        ? 'linear-gradient(135deg, rgba(99,102,241,0.7), rgba(139,92,246,0.5))'
        : 'rgba(255,255,255,0.07)',
      border: type === 'REVISED_OFFER' ? '1px solid rgba(245,158,11,0.4)'
            : type === 'OFFER_ACCEPTED' ? '1px solid rgba(74,222,128,0.4)'
            : 'none',
      boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
      transition: 'transform 0.15s ease',
    }),
    bubbleText: { color: '#e0e0ff', fontSize: '0.875rem', margin: 0, lineHeight: 1.5 },
    bubbleMeta: {
      color: 'rgba(160,160,200,0.6)', fontSize: '0.7rem',
      marginTop: '4px', textAlign: 'right'
    },
    offerBadge: {
      display: 'inline-flex', alignItems: 'center', gap: '4px',
      background: 'rgba(245,158,11,0.2)', border: '1px solid rgba(245,158,11,0.5)',
      borderRadius: '4px', padding: '2px 8px', marginBottom: '6px',
      color: '#fbbf24', fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.05em'
    },
    offerDetails: {
      display: 'flex', gap: '12px', margin: '8px 0',
      flexWrap: 'wrap'
    },
    offerStat: {
      background: 'rgba(0,0,0,0.2)', borderRadius: '8px',
      padding: '6px 12px', textAlign: 'center'
    },
    offerStatLabel: { color: '#a0a0c8', fontSize: '0.65rem', marginBottom: '2px' },
    offerStatValue: { color: '#fbbf24', fontSize: '0.95rem', fontWeight: 700 },
    acceptBtn: (accepting) => ({
      marginTop: '10px', padding: '8px 16px',
      background: accepting
        ? 'rgba(74,222,128,0.2)'
        : 'linear-gradient(135deg, #4ade80, #22c55e)',
      border: '1px solid rgba(74,222,128,0.5)',
      borderRadius: '8px', cursor: accepting ? 'not-allowed' : 'pointer',
      color: accepting ? '#4ade80' : '#fff',
      fontSize: '0.8rem', fontWeight: 700,
      transition: 'all 0.2s ease', width: '100%',
      opacity: accepting ? 0.7 : 1
    }),
    errorBanner: {
      margin: '0 16px', padding: '10px 14px',
      background: 'rgba(239,68,68,0.15)',
      border: '1px solid rgba(239,68,68,0.4)',
      borderRadius: '8px', color: '#fca5a5',
      fontSize: '0.8rem', display: 'flex', alignItems: 'center',
      justifyContent: 'space-between'
    },
    inputArea: {
      padding: '12px 16px',
      borderTop: '1px solid rgba(99,102,241,0.2)',
      background: 'rgba(0,0,0,0.2)'
    },
    offerFormBox: {
      background: 'rgba(245,158,11,0.08)',
      border: '1px solid rgba(245,158,11,0.25)',
      borderRadius: '12px', padding: '14px',
      marginBottom: '10px'
    },
    offerFormTitle: {
      color: '#fbbf24', fontSize: '0.8rem',
      fontWeight: 700, marginBottom: '10px'
    },
    offerFormRow: { display: 'flex', gap: '8px', marginBottom: '8px' },
    offerInput: {
      flex: 1, padding: '8px 12px', fontSize: '0.85rem',
      background: 'rgba(255,255,255,0.05)',
      border: '1px solid rgba(245,158,11,0.3)',
      borderRadius: '8px', color: '#e0e0ff', outline: 'none'
    },
    inputRow: { display: 'flex', gap: '8px', alignItems: 'flex-end' },
    textarea: {
      flex: 1, padding: '10px 14px', fontSize: '0.875rem',
      background: 'rgba(255,255,255,0.05)',
      border: '1px solid rgba(99,102,241,0.3)',
      borderRadius: '10px', color: '#e0e0ff',
      resize: 'none', outline: 'none', minHeight: '42px',
      maxHeight: '120px', fontFamily: 'inherit',
      lineHeight: 1.5
    },
    sendBtn: {
      padding: '10px 20px',
      background: 'linear-gradient(135deg, #6366f1, #8b5cf6)',
      border: 'none', borderRadius: '10px',
      color: '#fff', fontWeight: 700, fontSize: '0.85rem',
      cursor: 'pointer', transition: 'all 0.2s ease',
      flexShrink: 0
    },
    actionRow: {
      display: 'flex', gap: '8px', marginBottom: '8px'
    },
    offerToggleBtn: {
      padding: '6px 14px', fontSize: '0.75rem', fontWeight: 700,
      background: showOfferForm ? 'rgba(245,158,11,0.15)' : 'rgba(245,158,11,0.08)',
      border: '1px solid rgba(245,158,11,0.35)',
      borderRadius: '20px', color: '#fbbf24', cursor: 'pointer',
      transition: 'all 0.2s ease'
    },
    loadMoreBtn: {
      alignSelf: 'center', padding: '6px 14px',
      background: 'rgba(99,102,241,0.1)',
      border: '1px solid rgba(99,102,241,0.25)',
      borderRadius: '20px', color: '#a0a0e0',
      fontSize: '0.75rem', cursor: 'pointer',
      marginBottom: '4px', transition: 'all 0.2s ease'
    }
  };

  const formatTime = (ts) => {
    try {
      return new Date(ts).toLocaleTimeString(lang === 'bn' ? 'bn-BD' : 'en-GB', {
        hour: '2-digit', minute: '2-digit'
      });
    } catch (_) { return ''; }
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <h2 style={styles.title}>{t.title}</h2>
        <span style={styles.statusDot(socketStatus)}>
          <span style={styles.dot(socketStatus)} />
          {t[socketStatus] || socketStatus}
        </span>
      </div>

      {/* Error banner */}
      {error && (
        <div style={styles.errorBanner}>
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: '1rem' }}
            aria-label="Dismiss error"
          >✕</button>
        </div>
      )}

      {/* Message list */}
      <div style={styles.messageList} id="negotiation-message-list">
        {nextCursor && (
          <button
            style={styles.loadMoreBtn}
            onClick={() => fetchHistory(nextCursor)}
          >
            {t.loadMore}
          </button>
        )}

        {loadingHistory && (
          <p style={{ color: 'rgba(160,160,200,0.6)', textAlign: 'center', fontSize: '0.85rem' }}>
            {t.loadingHistory}
          </p>
        )}

        {!loadingHistory && messages.length === 0 && (
          <p style={{ color: 'rgba(160,160,200,0.5)', textAlign: 'center', fontSize: '0.85rem', marginTop: '40px' }}>
            {t.noMessages}
          </p>
        )}

        {messages.map((msg) => {
          const isOwn     = msg.senderId === currentUserId || msg.senderId?._id === currentUserId;
          const isOffer   = msg.messageType === 'REVISED_OFFER';
          const isAccepted= msg.messageType === 'OFFER_ACCEPTED';

          return (
            <div
              key={msg._id}
              style={{ display: 'flex', flexDirection: 'column', alignItems: isOwn ? 'flex-end' : 'flex-start' }}
            >
              <div style={styles.bubble(isOwn, msg.messageType)}>

                {/* REVISED_OFFER bubble */}
                {isOffer && (
                  <>
                    <div style={styles.offerBadge}>
                      ⚖️ {t.revisedOffer}
                    </div>
                    <div style={styles.offerDetails}>
                      <div style={styles.offerStat}>
                        <div style={styles.offerStatLabel}>{t.amount}</div>
                        <div style={styles.offerStatValue}>
                          ৳{(msg.payload.revisedAmount || 0).toLocaleString()}
                        </div>
                      </div>
                      <div style={styles.offerStat}>
                        <div style={styles.offerStatLabel}>{t.days}</div>
                        <div style={styles.offerStatValue}>{msg.payload.revisedDays}</div>
                      </div>
                    </div>
                    {msg.payload.text && <p style={styles.bubbleText}>{msg.payload.text}</p>}

                    {/* Accept button — visible only to the recipient and if offer is still PENDING */}
                    {!isOwn && msg.offerStatus === 'PENDING' && !bidClosed && (
                      <button
                        id={`accept-offer-btn-${msg._id}`}
                        style={styles.acceptBtn(isAccepting === msg._id)}
                        onClick={() => handleAcceptOffer(msg._id)}
                        disabled={isAccepting === msg._id}
                        aria-label={t.acceptOffer}
                      >
                        {isAccepting === msg._id ? '…' : t.acceptOffer}
                      </button>
                    )}

                    {msg.offerStatus === 'ACCEPTED' && (
                      <p style={{ color: '#4ade80', fontSize: '0.75rem', marginTop: '6px', fontWeight: 700 }}>
                        {t.offerAccepted}
                      </p>
                    )}
                    {msg.offerStatus === 'SUPERSEDED' && (
                      <p style={{ color: 'rgba(160,160,200,0.5)', fontSize: '0.7rem', marginTop: '4px' }}>
                        — {t.offerSuperseded} —
                      </p>
                    )}
                  </>
                )}

                {/* OFFER_ACCEPTED system message */}
                {isAccepted && (
                  <>
                    <div style={{ ...styles.offerBadge, background: 'rgba(74,222,128,0.15)', borderColor: 'rgba(74,222,128,0.4)', color: '#4ade80' }}>
                      ✅ {t.offerAccepted}
                    </div>
                    <div style={styles.offerDetails}>
                      <div style={styles.offerStat}>
                        <div style={styles.offerStatLabel}>{t.amount}</div>
                        <div style={{ ...styles.offerStatValue, color: '#4ade80' }}>
                          ৳{(msg.payload.acceptedAmount || 0).toLocaleString()}
                        </div>
                      </div>
                      <div style={styles.offerStat}>
                        <div style={styles.offerStatLabel}>{t.days}</div>
                        <div style={{ ...styles.offerStatValue, color: '#4ade80' }}>{msg.payload.acceptedDays}</div>
                      </div>
                    </div>
                    {msg.payload.text && <p style={{ ...styles.bubbleText, color: '#86efac' }}>{msg.payload.text}</p>}
                  </>
                )}

                {/* Plain TEXT message */}
                {msg.messageType === 'TEXT' && (
                  <p style={styles.bubbleText}>{msg.payload.text}</p>
                )}

                <p style={styles.bubbleMeta}>{formatTime(msg.createdAt)}</p>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      {!bidClosed ? (
        <div style={styles.inputArea}>
          {/* Offer form toggle */}
          <div style={styles.actionRow}>
            <button
              id="toggle-offer-form-btn"
              style={styles.offerToggleBtn}
              onClick={() => setShowOfferForm(v => !v)}
              aria-expanded={showOfferForm}
            >
              ⚖️ {t.makeOffer}
            </button>
          </div>

          {/* Revised offer form */}
          {showOfferForm && (
            <div style={styles.offerFormBox}>
              <p style={styles.offerFormTitle}>⚖️ {t.makeOffer}</p>
              <div style={styles.offerFormRow}>
                <input
                  id="offer-amount-input"
                  type="number"
                  placeholder={t.offerAmount}
                  value={offerAmount}
                  onChange={e => setOfferAmount(e.target.value)}
                  style={styles.offerInput}
                  min="100"
                  aria-label={t.offerAmount}
                />
                <input
                  id="offer-days-input"
                  type="number"
                  placeholder={t.offerDays}
                  value={offerDays}
                  onChange={e => setOfferDays(e.target.value)}
                  style={styles.offerInput}
                  min="1"
                  aria-label={t.offerDays}
                />
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  id="submit-offer-btn"
                  onClick={handleSubmitOffer}
                  style={{ ...styles.sendBtn, background: 'linear-gradient(135deg, #f59e0b, #d97706)', flex: 1 }}
                >
                  {t.submitOffer}
                </button>
                <button
                  onClick={() => setShowOfferForm(false)}
                  style={{ ...styles.sendBtn, background: 'rgba(255,255,255,0.07)', flex: 0, padding: '10px 14px' }}
                >
                  {t.cancel}
                </button>
              </div>
            </div>
          )}

          {/* Text input row */}
          <div style={styles.inputRow}>
            <textarea
              id="negotiation-message-input"
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t.placeholder}
              style={styles.textarea}
              rows={1}
              aria-label={t.placeholder}
            />
            <button
              id="negotiation-send-btn"
              style={styles.sendBtn}
              onClick={handleSend}
              disabled={isSending || !text.trim()}
              aria-label={t.send}
            >
              {t.send}
            </button>
          </div>
        </div>
      ) : (
        <div style={{ padding: '16px', textAlign: 'center', color: '#4ade80', fontWeight: 700, fontSize: '0.9rem' }}>
          {t.offerAccepted} — {lang === 'bn' ? 'আলোচনা সম্পন্ন হয়েছে।' : 'Negotiation complete. The bid terms are finalised.'}
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
        #negotiation-message-list::-webkit-scrollbar { width: 4px; }
        #negotiation-message-list::-webkit-scrollbar-track { background: transparent; }
        #negotiation-message-list::-webkit-scrollbar-thumb { background: rgba(99,102,241,0.3); border-radius: 2px; }
      `}</style>
    </div>
  );
}

// Export for use in module environments (Next.js, Vite) and also expose globally
// for script-tag page inclusion.
if (typeof module !== 'undefined') {
  module.exports = { NegotiationRoom };
}
if (typeof window !== 'undefined') {
  window.NegotiationRoom = NegotiationRoom;
}
