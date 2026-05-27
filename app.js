const SUPABASE_URL = 'https://jbsocnomwxodqyhiukcl.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impic29jbm9td3hvZHF5aGl1a2NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyNjQ5NTUsImV4cCI6MjA5Mzg0MDk1NX0.ehX6AEqpSpVAF9Q3UxIabZXdZKLDqKKP9KL3pDIPhHE';

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

let currentThread = null;
let chatHistory = [];
let systemContext = '';
let isListening = false;
let audioEnabled = false;
let recognition = null;
let currentView = 'dashboard';
let davidProfile = null;
let pendingRoute = null;

// ─── DAVID PROFILE ───────────────────────────────────────────────────────────

async function loadDavidProfile() {
  try {
    const result = await db.from('David').select('*').limit(1).single();
    if (result.data) davidProfile = result.data;
  } catch(e) { davidProfile = null; }
}

function buildDavidContext() {
  if (!davidProfile) return '';
  return `WHO DAVID IS:
Personality: ${davidProfile.personality || ''}
Work Style: ${davidProfile.work_style || ''}
Values: ${davidProfile.values || ''}
Observed Patterns: ${davidProfile.patterns || ''}
Current Focus: ${davidProfile.current_focus || ''}
Relationship Notes: ${davidProfile.relationship_notes || ''}`.trim();
}

async function updateDavidProfile(sessionSummary) {
  if (!davidProfile) return;
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: `You are a background observer. You have David's current profile and a session summary. Your job: determine if the session revealed anything NEW about David's personality, patterns, work style, values, or focus. If yes, return a JSON object with only the fields that should change and their new complete values. If no meaningful update is needed, return {}. Current profile: ${JSON.stringify(davidProfile)} Respond with ONLY valid JSON. No explanation, no markdown.`,
        messages: [{ role: 'user', content: `Session summary: ${sessionSummary}` }]
      })
    });
    const data = await response.json();
    if (data.content && data.content[0]) {
      const updates = JSON.parse(data.content[0].text.trim());
      if (Object.keys(updates).length > 0) {
        updates.last_updated = new Date().toISOString();
        await db.from('David').update(updates).eq('id', davidProfile.id);
        Object.assign(davidProfile, updates);
      }
    }
  } catch(e) {}
}

// ─── TRIAGE LOGIC ─────────────────────────────────────────────────────────────

const TRIAGE_DAYS = 14;

function getLastActivityDate(thread) {
  const progress = thread['Current progress'] || '';
  const lastSaved = progress.match(/\[(?:Auto-saved|Session) ([^\]]+)\]/g);
  if (lastSaved) {
    const lastEntry = lastSaved[lastSaved.length - 1];
    const dateStr = lastEntry.replace(/\[(?:Auto-saved|Session) /, '').replace(']', '').split(' ')[0];
    const lastDate = new Date(dateStr);
    if (!isNaN(lastDate)) return lastDate;
  }
  if (thread['created_at']) {
    const created = new Date(thread['created_at']);
    if (!isNaN(created)) return created;
  }
  return null;
}

function isInTriage(thread) {
  if (thread['Status'] !== 'Active') return false;
  if (thread['thread_type'] === 'feature') return false;
  const lastActivity = getLastActivityDate(thread);
  if (!lastActivity) return false;
  const daysSince = (Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24);
  return daysSince >= TRIAGE_DAYS;
}

function daysSinceActivity(thread) {
  const lastActivity = getLastActivityDate(thread);
  if (!lastActivity) return null;
  return Math.floor((Date.now() - lastActivity.getTime()) / (1000 * 60 * 60 * 24));
}

// ─── TRIAGE LIFECYCLE ─────────────────────────────────────────────────────────

function showTriageScreen(thread) {
  const days = daysSinceActivity(thread);
  const daysText = days !== null ? `${days} days ago` : 'unknown';

  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('thread-view').style.display = 'flex';
  document.getElementById('thread-title').textContent = thread['Thread name'];
  document.getElementById('chat-messages').innerHTML = '';

  document.getElementById('board-content').innerHTML = `
    <div class="triage-screen">
      <div class="triage-screen-eyebrow">🕰 Triage</div>
      <div class="triage-screen-title">${thread['Thread name']}</div>
      <div class="triage-screen-meta">Last active ${daysText}</div>
      ${thread['Goal'] ? `<div class="triage-screen-goal">${thread['Goal']}</div>` : ''}
      <div class="triage-screen-actions">
        <button class="triage-action-btn reactivate" onclick="triageReactivate(${thread.id})">
          <span class="triage-action-icon">⚡</span>
          <span class="triage-action-label">Reactivate</span>
          <span class="triage-action-sub">Pick up where you left off</span>
        </button>
        <button class="triage-action-btn review" onclick="triageReview(${thread.id})">
          <span class="triage-action-icon">👁</span>
          <span class="triage-action-label">Review</span>
          <span class="triage-action-sub">See progress before deciding</span>
        </button>
        <button class="triage-action-btn archive" onclick="triageArchive(${thread.id})">
          <span class="triage-action-icon">📦</span>
          <span class="triage-action-label">Archive</span>
          <span class="triage-action-sub">Mark complete and close</span>
        </button>
      </div>
    </div>`;

  addMessage('assistant', `${thread['Thread name']} has been quiet for ${daysText}. What do you want to do with it?`);
}

async function openThreadDirect(thread) {
  currentThread = thread;
  chatHistory = [];
  audioEnabled = false;
  isListening = false;
  currentView = 'thread';
  pendingRoute = null;

  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('thread-view').style.display = 'flex';
  document.getElementById('thread-title').textContent = currentThread['Thread name'];
  document.getElementById('chat-messages').innerHTML = '';
  document.getElementById('board-content').innerHTML = '<p class="loading" style="margin-top:16px;">Loading...</p>';

  const micBtn = document.getElementById('mic-btn');
  micBtn.textContent = '🎤';
  micBtn.style.opacity = '1';

  const ideas = (await db.from('Ideas').select('*').eq('thread_id', thread.id)).data || [];
  const board = buildBoardFromThread(currentThread, ideas);
  renderBoard(board);

  generateInsightCard(currentThread, ideas).then(insight => {
    if (insight) injectInsight(insight);
    else { const card = document.getElementById('insight-card'); if (card) card.style.display = 'none'; }
  });

  const allThreadsResult = await db.from('Threads').select('*');
  const otherThreads = (allThreadsResult.data || []).filter(t => t.id !== thread.id && t['Status'] === 'Active');
  const davidCtx = buildDavidContext();
  const crossThreadContext = otherThreads.length > 0 ? '\n\nOTHER ACTIVE PROJECTS:\n' + otherThreads.map(t => `- ${t['Thread name']}: ${t['Goal']?t['Goal'].slice(0,100):'No goal'}`).join('\n') : '';
  const recentProgress = currentThread['Current progress'] ? '\n\nRECENT HISTORY:\n' + currentThread['Current progress'].slice(-2000) : '';

  systemContext = `You are Jarvis, a personal AI partner for David Rogers.\n\n${davidCtx}\n\nCURRENT PROJECT: "${currentThread['Thread name']}"\nGoal: ${currentThread['Goal']}\nStatus: ${currentThread['Status']}\nNext Steps: ${currentThread['Next step']}\nDecisions Made: ${currentThread['Decisions made']}\nOpen Questions: ${currentThread['Open question']}${recentProgress}${crossThreadContext}\n\nKeep responses short and conversational. No markdown.`;
}

async function triageReactivate(id) {
  const result = await db.from('Threads').select('*').eq('id', id).single();
  if (!result.data) return;
  const note = '\n\n[Reactivated ' + new Date().toLocaleDateString() + ']';
  const newProgress = (result.data['Current progress'] || '') + note;
  await db.from('Threads').update({ 'Current progress': newProgress }).eq('id', id);
  const updatedThread = { ...result.data, 'Current progress': newProgress };
  setTimeout(() => loadThreads(), 1000);
  await openThreadDirect(updatedThread);
  addMessage('assistant', `Back on ${updatedThread['Thread name']}. Next step was: ${updatedThread['Next step'] || 'not set'} — still the right move?`);
}

async function triageReview(id) {
  const result = await db.from('Threads').select('*').eq('id', id).single();
  if (!result.data) return;
  await openThreadDirect(result.data);
  addMessage('assistant', `Reviewing ${result.data['Thread name']}. Take a look at the board — what do you want to do with it?`);
}

async function triageArchive(id) {
  if (!confirm('Archive this thread? It will be marked Complete and moved out of active view.')) return;
  await db.from('Threads').update({ 'Status': 'Complete' }).eq('id', id);
  setTimeout(() => loadThreads(), 500);
  backToDashboard();
  setTimeout(() => showDashboardMessage('assistant', 'Archived. Good call — keeping things clean.'), 300);
}

// ─── THREADS / DASHBOARD ─────────────────────────────────────────────────────

async function loadThreads() {
  try {
    const result = await db.from('Threads').select('*');
    if (result.error) throw result.error;
    const threads = result.data || [];

    if (threads.length === 0) {
      document.getElementById('thread-list').innerHTML = '<p class="loading">No threads yet. Tap + to add one.</p>';
      return;
    }

    const active = [];
    const triage = [];
    const other = [];
    const features = [];

    threads.forEach(t => {
      if (t['thread_type'] === 'feature') {
        features.push(t);
      } else if (t['Status'] === 'Active' && isInTriage(t)) {
        triage.push(t);
      } else if (t['Status'] === 'Active') {
        active.push(t);
      } else {
        other.push(t);
      }
    });

    const renderCard = (thread) => {
      const isComplete = thread['Status'] === 'Complete';
      const isPaused = thread['Status'] === 'Paused';
      const isFeature = thread['thread_type'] === 'feature';
      return `<div class="thread-card ${isPaused ? 'paused' : ''} ${isComplete ? 'complete' : ''} ${isFeature ? 'feature' : ''}" onclick="openThread(${thread.id})">
        <div class="platform-badge">${isFeature ? 'Feature' : (thread.platform || 'Claude')}</div>
        <h2>${thread['Thread name']}</h2>
        <p class="thread-status">${thread['Status'] || 'Active'} · ${thread['Next step'] ? thread['Next step'].slice(0,60) + '...' : (isFeature ? 'Tap to use' : 'No next step set')}</p>
      </div>`;
    };

    let html = '';
    if (active.length > 0) html += active.map(renderCard).join('');
    if (features.length > 0) {
      html += `<div class="triage-section" style="border-top-color:rgba(123,47,255,0.3);">
        <div class="triage-header">
          <div class="triage-dot" style="background:var(--purple-bright);box-shadow:0 0 7px var(--purple-bright);"></div>
          <span class="triage-label" style="color:var(--purple-glow);">Built by Jarvis</span>
          <span class="triage-count" style="background:rgba(123,47,255,0.12);color:var(--purple-glow);">${features.length}</span>
        </div>
        ${features.map(renderCard).join('')}
      </div>`;
    }
    if (other.length > 0) html += other.map(renderCard).join('');
    if (triage.length > 0) {
      html += `<div class="triage-section">
        <div class="triage-header">
          <div class="triage-dot"></div>
          <span class="triage-label">Triage</span>
          <span class="triage-count">${triage.length}</span>
        </div>
        <p class="triage-desc">Inactive 14+ days — review, reactivate, or close.</p>
        ${triage.map(t => {
          const days = daysSinceActivity(t);
          return `<div class="thread-card triage" onclick="openThread(${t.id})">
            <div class="platform-badge">${t.platform || 'Claude'}</div>
            <h2>${t['Thread name']}</h2>
            <p class="thread-status">Inactive ${days !== null ? days + ' days' : ''} · ${t['Next step'] ? t['Next step'].slice(0,50) + '...' : 'No next step set'}</p>
          </div>`;
        }).join('')}
      </div>`;
    }

    document.getElementById('thread-list').innerHTML = html;

  } catch(e) {
    document.getElementById('thread-list').innerHTML = '<p class="loading">Error: ' + e.message + '</p>';
  }
}

// ─── BOARD ────────────────────────────────────────────────────────────────────

function buildBoardFromThread(thread, ideas) {
  const board = {};
  if (thread['Goal']) board.where = thread['Goal'];
  if (thread['Next step']) {
    board.moving = [{ title: 'Next Step', body: thread['Next step'], tag: 'strategy', why: 'This is the current priority.', next: thread['Next step'] }];
  }
  if (thread['Open question']) {
    board.blocked = thread['Open question'].split('\n').filter(q => q.trim()).map(q => ({
      title: q.slice(0,60), body: q, tag: 'strategy', why: 'Unresolved question blocking progress.', next: 'Decide or research this.'
    }));
  }
  if (thread['Decisions made']) {
    board.decided = thread['Decisions made'].split('\n').filter(d => d.trim()).map(d => ({
      title: d.slice(0,60), body: d, tag: 'strategy', why: 'Decision locked in.', next: 'Execute on this.'
    }));
  }
  if (ideas && ideas.length > 0) {
    board.horizon = ideas.slice(0,4).map(i => ({
      title: i.idea_text.slice(0,55), body: i.idea_text, tag: 'strategy', why: 'Banked for future consideration.', next: 'Revisit when ready.'
    }));
  }
  return board;
}

async function generateInsightCard(thread, ideas) {
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: 'You generate one sharp insight sentence about a project. No markdown, no preamble, just the insight.',
        messages: [{ role: 'user', content: `Project: ${thread['Thread name']}\nGoal: ${thread['Goal']||''}\nNext Step: ${thread['Next step']||''}\nOpen Questions: ${thread['Open question']||''}\nDecisions: ${thread['Decisions made']||''}\nBanked Ideas: ${(ideas||[]).map(i=>i.idea_text).join(' | ')||'None'}` }]
      })
    });
    const data = await response.json();
    if (data.content && data.content[0]) return data.content[0].text.trim();
  } catch(e) {}
  return null;
}

function renderBoard(board) {
  const zoneColors = { moving: '#34d399', blocked: '#f87171', decided: '#60a5fa', horizon: '#fbbf24' };
  const zoneLabels = { moving: 'Moving', blocked: 'Blocked', decided: 'Decided', horizon: 'Horizon' };
  const zoneDots  = { moving: 'green',  blocked: 'red',     decided: 'blue',    horizon: 'amber'  };
  let html = '';

  if (board.where) {
    html += `<div class="where-card"><div class="zone-eyebrow">🧭 Where We Are</div><div class="where-body">${board.where}</div><div class="where-ts">Updated · ${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div></div>`;
  }

  html += `<div class="insight" id="insight-card" style="opacity:0.35;"><div class="insight-icon">⚡</div><div><div class="insight-label">Jarvis Insight</div><div class="insight-text" id="insight-text">Thinking...</div></div></div>`;

  ['moving','blocked','decided','horizon'].forEach(zone => {
    const cards = board[zone];
    const color = zoneDots[zone];
    const label = zoneLabels[zone];
    html += `<div class="zone-section"><div class="zone-header"><div class="zone-dot ${color}"></div><span class="zone-name ${color}">${label}</span><span class="zone-count ${color}">${cards ? cards.length : 0}</span></div>`;
    if (!cards || cards.length === 0) {
      html += `<div class="card-empty">Nothing here yet</div>`;
    } else {
      cards.forEach(card => {
        const t = (card.title||'').replace(/'/g,"\\'");
        const b = (card.body||'').replace(/'/g,"\\'");
        const w = (card.why||'').replace(/'/g,"\\'");
        const n = (card.next||'').replace(/'/g,"\\'");
        const c = zoneColors[zone];
        html += `<div class="card ${color}" onclick="openCardDetail('${t}','${label}','${c}','${b}','${w}','${n}')"><div class="card-title">${card.title}</div><div class="card-body">${card.body}</div><span class="card-tag tag-${card.tag||'strategy'}">${card.tag||'strategy'}</span><div class="card-arrow">›</div></div>`;
      });
    }
    html += `</div>`;
  });

  document.getElementById('board-content').innerHTML = html;
}

function injectInsight(text) {
  const card = document.getElementById('insight-card');
  const textEl = document.getElementById('insight-text');
  if (card && textEl) { textEl.textContent = text; card.style.opacity = '1'; card.style.transition = 'opacity 0.5s ease'; }
}

// ─── FEATURE UI ───────────────────────────────────────────────────────────────

function renderFeatureUI(thread) {
  const container = document.getElementById('board-content');
  try {
    const html = thread['custom_ui'] || '<p class="loading">No UI generated yet.</p>';
    container.innerHTML = html;
    container.querySelectorAll('script').forEach(oldScript => {
      const newScript = document.createElement('script');
      newScript.textContent = oldScript.textContent;
      oldScript.parentNode.replaceChild(newScript, oldScript);
    });
  } catch(e) {
    container.innerHTML = '<p class="loading">Error rendering feature: ' + e.message + '</p>';
  }
}

// ─── CARD DETAIL ─────────────────────────────────────────────────────────────

function openCardDetail(title, zone, color, body, why, next) {
  document.getElementById('ov-zone').textContent = zone;
  document.getElementById('ov-zone').style.color = color;
  document.getElementById('ov-title').textContent = title;
  document.getElementById('ov-body').textContent = body;
  document.getElementById('ov-why').textContent = why;
  document.getElementById('ov-next').textContent = next;
  document.getElementById('card-overlay').classList.add('open');
}

function closeCardDetail() {
  document.getElementById('card-overlay').classList.remove('open');
}

// ─── OPEN THREAD ─────────────────────────────────────────────────────────────

async function openThread(id) {
  const result = await db.from('Threads').select('*').eq('id', id).single();
  if (!result.data) return;
  currentThread = result.data;
  chatHistory = [];
  audioEnabled = false;
  isListening = false;
  currentView = 'thread';
  pendingRoute = null;

  const micBtn = document.getElementById('mic-btn');
  micBtn.textContent = '🎤';
  micBtn.style.opacity = '1';

  if (isInTriage(currentThread)) {
    showTriageScreen(currentThread);
    return;
  }

  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('thread-view').style.display = 'flex';
  document.getElementById('thread-title').textContent = currentThread['Thread name'];
  document.getElementById('chat-messages').innerHTML = '';
  document.getElementById('board-content').innerHTML = '<p class="loading" style="margin-top:16px;">Loading...</p>';

  if (currentThread['thread_type'] === 'feature') {
    renderFeatureUI(currentThread);
    systemContext = `You are Jarvis. David is using a feature you built: "${currentThread['Thread name']}". The underlying table is "${currentThread['Goal']}". Help him use it, add entries, view data, or modify it. Keep responses short and conversational. No markdown.`;
    addMessage('assistant', `${currentThread['Thread name']} — ready to use. What would you like to do?`);
    return;
  }

  const ideasResult = await db.from('Ideas').select('*').eq('thread_id', id);
  const ideas = ideasResult.data || [];
  const board = buildBoardFromThread(currentThread, ideas);
  renderBoard(board);

  generateInsightCard(currentThread, ideas).then(insight => {
    if (insight) injectInsight(insight);
    else { const card = document.getElementById('insight-card'); if (card) card.style.display = 'none'; }
  });

  const allThreadsResult = await db.from('Threads').select('*');
  const otherThreads = (allThreadsResult.data || []).filter(t => t.id !== id && t['Status'] === 'Active');
  const davidCtx = buildDavidContext();
  const crossThreadContext = otherThreads.length > 0 ? '\n\nOTHER ACTIVE PROJECTS:\n' + otherThreads.map(t => `- ${t['Thread name']}: ${t['Goal']?t['Goal'].slice(0,100):'No goal'}${t['Next step']?' | Next: '+t['Next step'].slice(0,80):''}`).join('\n') : '';
  const ideasContext = ideas.length > 0 ? '\n\nBANKED IDEAS:\n' + ideas.map(i => '- ' + i.idea_text.slice(0,200)).join('\n') : '';
  const recentProgress = currentThread['Current progress'] ? '\n\nRECENT HISTORY:\n' + currentThread['Current progress'].slice(-2000) : '';

  systemContext = `You are Jarvis, a personal AI partner for David Rogers.\n\n${davidCtx}\n\nCURRENT PROJECT: "${currentThread['Thread name']}"\nGoal: ${currentThread['Goal']}\nStatus: ${currentThread['Status']}\nNext Steps: ${currentThread['Next step']}\nDecisions Made: ${currentThread['Decisions made']}\nOpen Questions: ${currentThread['Open question']}\nNotes: ${currentThread['Note']}${recentProgress}${ideasContext}${crossThreadContext}\n\nDavid is looking at the visual board for this project while chatting with you. Help him go deep on specific cards, make decisions, capture ideas, or take action. Keep responses short and conversational. No markdown.`;

  let openingMsg = `On ${currentThread['Thread name']}.`;
  if (currentThread['Next step']) openingMsg += ` Next up: ${currentThread['Next step']}`;
  addMessage('assistant', openingMsg);
}

// ─── DASHBOARD ROUTING ────────────────────────────────────────────────────────

async function analyzeAndRoute(text, threads) {
  const active = threads.filter(t => t['Status'] === 'Active' && t['thread_type'] !== 'feature');
  if (active.length === 0) return null;

  const threadList = active.map(t => `ID:${t.id} | Name: ${t['Thread name']} | Goal: ${(t['Goal']||'').slice(0,100)}`).join('\n');

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: `You are Jarvis's routing brain. David said something on the dashboard. Decide if it belongs to an existing project thread.

Active threads:
${threadList}

Rules:
- If the message clearly relates to one of these threads, return JSON: {"route": true, "thread_id": <id>, "thread_name": "<name>", "reason": "one short sentence why"}
- If it's a new topic that deserves its own thread, return JSON: {"route": false, "suggest_new": true, "suggested_name": "<short thread name>", "reason": "one short sentence why"}
- If it's just casual chat or a question, return JSON: {"route": false, "suggest_new": false}
Respond with ONLY valid JSON.`,
        messages: [{ role: 'user', content: text }]
      })
    });
    const data = await response.json();
    if (data.content && data.content[0]) {
      const raw = data.content[0].text.trim().replace(/```json|```/g, '');
      return JSON.parse(raw);
    }
  } catch(e) {}
  return null;
}

function showRoutingSuggestion(routing, text) {
  const msgContainer = document.getElementById('dashboard-messages');

  if (routing.route) {
    pendingRoute = { type: 'existing', thread_id: routing.thread_id, text };
    const div = document.createElement('div');
    div.className = 'message assistant';
    div.innerHTML = `${routing.reason} — route this to <strong>${routing.thread_name}</strong>?
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button onclick="confirmRoute()" style="background:var(--purple-bright);color:#fff;border:none;border-radius:8px;padding:8px 16px;font-family:Syne,sans-serif;font-size:12px;font-weight:700;cursor:pointer;">Yes, route it</button>
        <button onclick="dismissRoute()" style="background:var(--white-08);color:var(--text-secondary);border:1px solid var(--border);border-radius:8px;padding:8px 16px;font-family:Syne,sans-serif;font-size:12px;cursor:pointer;">Just chat</button>
      </div>`;
    msgContainer.appendChild(div);
    msgContainer.scrollTop = 999999;
  } else if (routing.suggest_new) {
    pendingRoute = { type: 'new', suggested_name: routing.suggested_name, text };
    const div = document.createElement('div');
    div.className = 'message assistant';
    div.innerHTML = `${routing.reason} — start a new thread called <strong>${routing.suggested_name}</strong>?
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button onclick="confirmRoute()" style="background:var(--purple-bright);color:#fff;border:none;border-radius:8px;padding:8px 16px;font-family:Syne,sans-serif;font-size:12px;font-weight:700;cursor:pointer;">Yes, create it</button>
        <button onclick="dismissRoute()" style="background:var(--white-08);color:var(--text-secondary);border:1px solid var(--border);border-radius:8px;padding:8px 16px;font-family:Syne,sans-serif;font-size:12px;cursor:pointer;">Just chat</button>
      </div>`;
    msgContainer.appendChild(div);
    msgContainer.scrollTop = 999999;
  } else {
    return false;
  }
  return true;
}

async function confirmRoute() {
  if (!pendingRoute) return;
  const msgContainer = document.getElementById('dashboard-messages');
  const lastMsg = msgContainer.lastElementChild;
  if (lastMsg) lastMsg.remove();

  if (pendingRoute.type === 'existing') {
    const threadId = pendingRoute.thread_id;
    const text = pendingRoute.text;
    pendingRoute = null;
    const result = await db.from('Threads').select('*').eq('id', threadId).single();
    if (result.data) {
      const note = '\n\n[Routed from dashboard ' + new Date().toLocaleDateString() + ']\n' + text;
      const newProgress = (result.data['Current progress'] || '') + note;
      await db.from('Threads').update({ 'Current progress': newProgress }).eq('id', threadId);
      openThread(threadId);
    }
  } else if (pendingRoute.type === 'new') {
    const name = pendingRoute.suggested_name;
    const text = pendingRoute.text;
    pendingRoute = null;
    const { data: newThread, error } = await db.from('Threads').insert([{
      'Thread name': name,
      'Goal': text,
      'Status': 'Active',
      'platform': 'Jarvis'
    }]).select().single();
    if (!error && newThread) {
      loadThreads();
      openThread(newThread.id);
    }
  }
}

function dismissRoute() {
  pendingRoute = null;
  const msgContainer = document.getElementById('dashboard-messages');
  const lastMsg = msgContainer.lastElementChild;
  if (lastMsg) lastMsg.remove();
}

// ─── CONTEXT ─────────────────────────────────────────────────────────────────

async function buildMasterContext(threads) {
  const active = threads.filter(t => t['Status'] === 'Active' && t['thread_type'] !== 'feature');
  const davidCtx = buildDavidContext();
  return `You are Jarvis, a personal AI partner for David Rogers. You are not an assistant — you are a thinking partner who knows David's work deeply.

${davidCtx}

ACTIVE PROJECTS:
${active.map(t => `- ${t['Thread name']}: ${t['Goal'] ? t['Goal'].slice(0,120) : 'No goal'} | Next: ${t['Next step'] ? t['Next step'].slice(0,80) : 'Not set'}`).join('\n')}

You are on the dashboard — David's brainstorm and command space. Help him think, capture ideas, route them to the right project, or suggest new threads. Respond conversationally. Never use markdown, bullet lists, or code blocks. Keep it short and direct.`;
}

async function switchToProject(name) {
  const result = await db.from('Threads').select('*');
  if (!result.data) return;
  const match = result.data.find(t => t['Thread name'].toLowerCase().includes(name));
  if (match) openThread(match.id);
  else {
    const msg = `Couldn't find "${name}". Your projects: ${(result.data||[]).map(t => t['Thread name']).join(', ')}`;
    if (currentView === 'dashboard') showDashboardMessage('assistant', msg);
    else addMessage('assistant', msg);
  }
}

function showDashboardMessage(role, text) {
  const msgContainer = document.getElementById('dashboard-messages');
  msgContainer.style.display = 'flex';
  const div = document.createElement('div');
  div.className = 'message ' + role;
  div.textContent = text;
  msgContainer.appendChild(div);
  msgContainer.scrollTop = 999999;
}

function addMessage(role, text) {
  const messagesEl = document.getElementById('chat-messages');
  if (!messagesEl) return;
  const div = document.createElement('div');
  div.className = 'message ' + role;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = 999999;
  if (role !== 'assistant' || chatHistory.length === 0) chatHistory.push({ role, content: text });
  if (role === 'assistant' && text !== '...') speak(text);
}

function speak(text) {
  if (!audioEnabled) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05; u.pitch = 1.0; u.volume = 1.0;
  window.speechSynthesis.speak(u);
}

// ─── INTENT DETECTION ─────────────────────────────────────────────────────────

function detectSelfModifyIntent(text) {
  const triggers = ['update yourself', 'modify yourself', 'change your code', 'update your code',
    'rewrite yourself', 'update jarvis code', 'change jarvis', 'modify jarvis',
    'update the app', 'change the app', 'fix the app', 'improve the app',
    'add to yourself', 'update app.js'];
  const lower = text.toLowerCase();
  return triggers.some(t => lower.includes(t));
}

function detectBuildIntent(text) {
  const triggers = ['build', 'create', 'add a', 'i want to track', 'make a', 'new feature', 'can you build', 'can jarvis build', 'add feature', 'i need a'];
  const lower = text.toLowerCase();
  return triggers.some(t => lower.includes(t));
}

function detectUpdateIntent(text) {
  const triggers = ['update jarvis', 'update the jarvis', 'file this', 'save this to', 'add this to', 'put this in', 'log this to', 'store this in', 'session summary', 'update my thread', 'update thread'];
  const lower = text.toLowerCase();
  return triggers.some(t => lower.includes(t));
}

// ─── THREAD UPDATE ────────────────────────────────────────────────────────────

async function handleThreadUpdate(text, threads) {
  const msgContainer = document.getElementById('dashboard-messages');
  const status = document.createElement('div');
  status.className = 'message assistant';
  status.textContent = 'Organizing this and filing it...';
  msgContainer.appendChild(status);
  msgContainer.scrollTop = 999999;

  const active = threads.filter(t => t['Status'] === 'Active' && t['thread_type'] !== 'feature');
  const threadList = active.map(t => `ID:${t.id} | Name: ${t['Thread name']} | Goal: ${(t['Goal']||'').slice(0,80)}`).join('\n');

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: `You are Jarvis organizing information from David into the right project thread.

IMPORTANT: You must ONLY update an existing thread from this list. Never create a new thread. Always pick the best matching thread_id from the list below.

Active threads:
${threadList}

David has given you a session summary or update. Your job:
1. Pick the single best matching thread_id from the list above
2. Extract what should update each field

Respond with ONLY valid JSON:
{
  "thread_id": <must be one of the IDs listed above>,
  "thread_name": "<name of the matched thread>",
  "updates": {
    "Goal": "<updated goal or null if unchanged>",
    "Next step": "<most important next action or null>",
    "Decisions made": "<new decisions to append, or null>",
    "Open question": "<new open questions to append, or null>",
    "Current progress": "<concise summary of this session to append>"
  }
}
Always include thread_id, thread_name, and Current progress. Only include other fields if there is genuinely new information.`,
        messages: [{ role: 'user', content: text }]
      })
    });

    const data = await response.json();
    const raw = data.content[0].text.trim().replace(/```json|```/g, '');
    const plan = JSON.parse(raw);

    const validThread = active.find(t => t.id === plan.thread_id);
    if (!validThread) throw new Error(`Thread ID ${plan.thread_id} not found in active threads`);

    const current = validThread;
    const updates = {};

    if (plan.updates['Goal']) updates['Goal'] = plan.updates['Goal'];
    if (plan.updates['Next step']) updates['Next step'] = plan.updates['Next step'];
    if (plan.updates['Decisions made']) updates['Decisions made'] = plan.updates['Decisions made'];
    if (plan.updates['Open question']) updates['Open question'] = plan.updates['Open question'];

    if (plan.updates['Current progress']) {
      updates['Current progress'] = (current['Current progress'] || '') + '\n\n[Session ' + new Date().toLocaleDateString() + ']\n' + plan.updates['Current progress'];
    }

    const { error } = await db.from('Threads').update(updates).eq('id', plan.thread_id);
    if (error) throw new Error(error.message);

    status.textContent = `Filed to "${plan.thread_name}" — updated.`;
    loadThreads();

  } catch(e) {
    status.textContent = 'Filing failed: ' + e.message;
  }
}

// ─── BUILD REQUEST ────────────────────────────────────────────────────────────

async function handleBuildRequest(text) {
  const msgContainer = currentView === 'dashboard' ? document.getElementById('dashboard-messages') : document.getElementById('chat-messages');
  const status = document.createElement('div');
  status.className = 'message assistant';
  status.textContent = 'On it — figuring out what to build...';
  msgContainer.appendChild(status);
  msgContainer.scrollTop = 999999;

  try {
    const planRes = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: `You are Jarvis, a builder. David has requested something to be built.
You must respond with ONLY valid JSON in this exact structure:
{
  "table": "snake_case_table_name",
  "thread_name": "Human readable name for this feature",
  "columns": [{"name": "col_name", "type": "text|integer|boolean|timestamptz"}],
  "confirmation": "One sentence telling David exactly what you are building.",
  "ui_description": "Brief description of what the UI should do — form to add entries, list to view them, etc."
}
No markdown, no explanation, just JSON.`,
        messages: [{ role: 'user', content: text }]
      })
    });

    const planData = await planRes.json();
    const raw = planData.content[0].text.trim().replace(/```json|```/g, '');
    const plan = JSON.parse(raw);
    status.textContent = plan.confirmation;

    const schemaRes = await fetch('/api/schema', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'create', table: plan.table, columns: plan.columns })
    });
    const schemaData = await schemaRes.json();
    if (!schemaData.success) throw new Error('Schema failed: ' + schemaData.error);

    status.textContent = plan.confirmation + ' Building UI...';

    const uiRes = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: `You are Jarvis building a UI component. Generate a self-contained HTML+JS snippet that:
- Uses the Supabase client already available as window.db (already initialized)
- Matches this color scheme: purple/gold dark theme, CSS variables --purple-bright, --gold, --white-08, --border, --text-primary, --text-secondary
- Uses font-family DM Sans and Syne (already loaded)
- Has a form to add new entries and a list/table to view recent entries
- Calls Supabase directly: await window.db.from('TABLE_NAME').insert([...]) and .select()
- Is clean, minimal, mobile-friendly
- Has NO external dependencies beyond what is already on the page
- Returns ONLY the HTML/JS, no explanation, no markdown fences`,
        messages: [{ role: 'user', content: `Build a UI for table "${plan.table}" with columns: ${plan.columns.map(c=>c.name).join(', ')}. ${plan.ui_description}` }]
      })
    });

    const uiData = await uiRes.json();
    const uiHtml = uiData.content[0].text.trim().replace(/```html|```/g, '');

    const { data: newThread, error: threadError } = await db.from('Threads').insert([{
      'Thread name': plan.thread_name,
      'Goal': plan.table,
      'Status': 'Active',
      'thread_type': 'feature',
      'custom_ui': uiHtml,
      'platform': 'Jarvis'
    }]).select().single();

    if (threadError) throw new Error('Thread save failed: ' + threadError.message);

    const doneMsg = document.createElement('div');
    doneMsg.className = 'message assistant';
    doneMsg.textContent = `Done. "${plan.thread_name}" is ready — find it in your dashboard under Built by Jarvis.`;
    msgContainer.appendChild(doneMsg);
    msgContainer.scrollTop = 999999;

    if (currentView === 'dashboard') loadThreads();

  } catch(e) {
    status.textContent = 'Build failed: ' + e.message;
  }
}

// ─── SELF-MODIFY ──────────────────────────────────────────────────────────────

async function handleSelfModifyRequest(instruction) {
  const msgContainer = currentView === 'dashboard'
    ? document.getElementById('dashboard-messages')
    : document.getElementById('chat-messages');

  const status = document.createElement('div');
  status.className = 'message assistant';
  status.textContent = 'Reading my own code...';
  msgContainer.appendChild(status);
  msgContainer.scrollTop = 999999;

  try {
    const readRes = await fetch('/api/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'read' })
    });
    const readData = await readRes.json();
    if (!readData.success) throw new Error('Could not read code: ' + readData.error);

    const currentCode = readData.content;
    status.textContent = 'Got it. Thinking through the change...';

    const proposeRes = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: `You are Jarvis's code modification engine. David wants to change app.js.
Return ONLY a JSON object with this structure:
{
  "summary": "One sentence describing the change.",
  "find": "the exact string to find in the current code",
  "replace": "the new string to replace it with"
}
Rules:
- Think first about what behavior the user wants, then find the right code to change
- "find" must be copied character-for-character from the provided code — no paraphrasing
- Keep "find" to 1-3 lines, just enough to be unique
- No markdown, no explanation, ONLY the JSON object`,

- No markdown, no explanation, ONLY the JSON object`,
        messages: [{
          role: 'user',
          content: `Instruction: ${instruction}\n\nCurrent app.js:\n${currentCode}`
        }]
      })
    });

    const proposeData = await proposeRes.json();
    const raw = proposeData.content[0].text.trim().replace(/```json|```/g, '');
    const proposal = JSON.parse(raw);

    if (!currentCode.includes(proposal.find)) {
      throw new Error('Could not locate the code section to change.');
    }

    const updatedCode = currentCode.replace(proposal.find, proposal.replace);
    status.remove();
    showStagedChange(proposal.summary, updatedCode, msgContainer);

  } catch(e) {
    status.textContent = 'Self-modify failed: ' + e.message;
  }
}

function showStagedChange(summary, updatedCode, container) {
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.id = 'staged-change-msg';
  div.innerHTML = `
    <div style="font-size:13px;color:var(--text-secondary);margin-bottom:6px;letter-spacing:0.05em;">STAGED CHANGE</div>
    <div style="font-size:15px;margin-bottom:14px;">${summary}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button id="confirm-deploy-btn" style="background:var(--purple-bright);color:#fff;border:none;border-radius:8px;padding:9px 18px;font-family:Syne,sans-serif;font-size:12px;font-weight:700;cursor:pointer;">Deploy this</button>
      <button id="cancel-deploy-btn" style="background:var(--white-08);color:var(--text-secondary);border:1px solid var(--border);border-radius:8px;padding:9px 18px;font-family:Syne,sans-serif;font-size:12px;cursor:pointer;">Cancel</button>
    </div>`;
  container.appendChild(div);
  container.scrollTop = 999999;

  document.getElementById('confirm-deploy-btn').onclick = () => confirmDeploy(updatedCode, summary, div, container);
  document.getElementById('cancel-deploy-btn').onclick = () => {
    div.remove();
    const cancelled = document.createElement('div');
    cancelled.className = 'message assistant';
    cancelled.textContent = 'Change cancelled. Nothing was deployed.';
    container.appendChild(cancelled);
  };
}

async function confirmDeploy(updatedCode, summary, stagedDiv, container) {
  stagedDiv.remove();
  const status = document.createElement('div');
  status.className = 'message assistant';
  status.textContent = 'Deploying...';
  container.appendChild(status);
  container.scrollTop = 999999;

  try {
    const deployRes = await fetch('/api/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'write',
        content: updatedCode,
        commitMessage: 'Jarvis self-update: ' + summary
      })
    });
    const deployData = await deployRes.json();
    if (!deployData.success) throw new Error(deployData.error);

    status.innerHTML = `Deployed. Live in ~30 seconds.
      <div style="margin-top:10px;">
        <button onclick="handleRollback(this)" style="background:var(--white-08);color:var(--text-secondary);border:1px solid var(--border);border-radius:8px;padding:7px 14px;font-family:Syne,sans-serif;font-size:11px;cursor:pointer;">↩ Rollback if broken</button>
      </div>`;
  } catch(e) {
    status.textContent = 'Deploy failed: ' + e.message;
  }
}

async function handleRollback(btn) {
  btn.textContent = 'Rolling back...';
  btn.disabled = true;
  try {
    const res = await fetch('/api/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'rollback' })
    });
    const data = await res.json();
    if (!data.success) throw new Error(data.error);
    btn.closest('.message').textContent = 'Rolled back. Previous version deploying now.';
  } catch(e) {
    btn.textContent = 'Rollback failed: ' + e.message;
    btn.disabled = false;
  }
}

// ─── SEND MESSAGE ─────────────────────────────────────────────────────────────

async function sendMessage(inputId) {
  const inputElId = inputId || (currentView === 'dashboard' ? 'dashboard-input' : 'chat-input');
  const input = document.getElementById(inputElId);
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  if (currentView === 'dashboard') {
    const allResult = await db.from('Threads').select('*');
    const threads = allResult.data || [];

    if (detectUpdateIntent(text)) {
      showDashboardMessage('user', text);
      handleThreadUpdate(text, threads);
      return;
    }

    if (detectSelfModifyIntent(text)) {
      showDashboardMessage('user', text);
      handleSelfModifyRequest(text);
      return;
    }

    if (detectBuildIntent(text)) {
      showDashboardMessage('user', text);
      handleBuildRequest(text);
      return;
    }

    systemContext = await buildMasterContext(threads);
    showDashboardMessage('user', text);
    chatHistory.push({ role: 'user', content: text });

    const routingPromise = analyzeAndRoute(text, threads);

    const thinking = document.createElement('div');
    thinking.className = 'message assistant thinking';
    thinking.textContent = '...';
    const msgContainer = document.getElementById('dashboard-messages');
    msgContainer.appendChild(thinking);
    msgContainer.scrollTop = 999999;

    try {
      const [chatResponse, routing] = await Promise.all([
        fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ system: systemContext, messages: chatHistory.slice(-10) })
        }),
        routingPromise
      ]);

      thinking.remove();
      const data = await chatResponse.json();

      if (data.content && data.content[0]) {
        const reply = data.content[0].text;
        showDashboardMessage('assistant', reply);
        chatHistory.push({ role: 'assistant', content: reply });
        speak(reply);
      }

      if (routing && (routing.route || routing.suggest_new)) {
        setTimeout(() => showRoutingSuggestion(routing, text), 600);
      }

    } catch(e) {
      thinking.remove();
      showDashboardMessage('assistant', 'Error: ' + e.message);
    }
    return;
  }

  if (detectSelfModifyIntent(text)) {
    addMessage('user', text);
    handleSelfModifyRequest(text);
    return;
  }

  if (detectBuildIntent(text)) {
    addMessage('user', text);
    handleBuildRequest(text);
    return;
  }

  addMessage('user', text);
  chatHistory.push({ role: 'user', content: text });
  const thinking = document.createElement('div');
  thinking.className = 'message assistant thinking';
  thinking.textContent = '...';
  document.getElementById('chat-messages').appendChild(thinking);
  document.getElementById('chat-messages').scrollTop = 999999;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system: systemContext, messages: chatHistory.slice(-10) })
    });
    const data = await response.json();
    thinking.remove();
    if (data.content && data.content[0]) {
      const reply = data.content[0].text;
      addMessage('assistant', reply);
      chatHistory.push({ role: 'assistant', content: reply });
    }
  } catch(e) {
    thinking.remove();
    addMessage('assistant', 'Error: ' + e.message);
  }
}

// ─── SAVE / PROGRESS ─────────────────────────────────────────────────────────

async function autoSaveProgress() {
  if (!currentThread || chatHistory.length < 3) return;
  const summary = chatHistory.slice(-8).map(m => (m.role === 'user' ? 'Me: ' : 'Jarvis: ') + m.content).join('\n');
  const newProgress = (currentThread['Current progress'] || '') + '\n\n[Auto-saved ' + new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString() + ']\n' + summary;
  await db.from('Threads').update({ 'Current progress': newProgress }).eq('id', currentThread.id);
  updateDavidProfile(summary);
}

async function saveProgress() {
  if (!currentThread) return;
  const summary = chatHistory.slice(-6).map(m => (m.role === 'user' ? 'Me: ' : 'Jarvis: ') + m.content).join('\n');
  const newProgress = (currentThread['Current progress'] || '') + '\n\n[Session ' + new Date().toLocaleDateString() + ']\n' + summary;
  const { error } = await db.from('Threads').update({ 'Current progress': newProgress }).eq('id', currentThread.id);
  if (error) addMessage('assistant', 'Error saving: ' + error.message);
  else { currentThread['Current progress'] = newProgress; addMessage('assistant', 'Progress saved.'); updateDavidProfile(summary); }
}

async function saveIdea(transcript) {
  if (!currentThread) { showDashboardMessage('assistant', 'Open a project first.'); return; }
  const recentContext = chatHistory.slice(-4).map(m => m.content).join(' | ');
  const { error } = await db.from('Ideas').insert([{ thread_id: currentThread.id, idea_text: recentContext || transcript }]);
  if (error) addMessage('assistant', 'Error saving idea: ' + error.message);
  else addMessage('assistant', 'Banked.');
}

// ─── NAVIGATION ──────────────────────────────────────────────────────────────

function backToDashboard() {
  autoSaveProgress();
  window.speechSynthesis.cancel();
  if (isListening && recognition) { isListening = false; recognition.stop(); }
  audioEnabled = false;
  currentView = 'dashboard';
  pendingRoute = null;
  document.getElementById('dashboard').style.display = 'block';
  document.getElementById('thread-view').style.display = 'none';
  currentThread = null;
  chatHistory = [];
  const micBtn = document.getElementById('mic-btn');
  if (micBtn) micBtn.textContent = '🎤';
}

function openNewThreadForm() {
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('new-thread-view').style.display = 'block';
}

function closeNewThreadForm() {
  document.getElementById('new-thread-view').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
}

function openEditThread() {
  if (!currentThread) return;
  document.getElementById('thread-view').style.display = 'none';
  document.getElementById('edit-thread-view').style.display = 'block';
  document.getElementById('et-name').value = currentThread['Thread name'] || '';
  document.getElementById('et-status').value = currentThread['Status'] || 'Active';
  document.getElementById('et-goal').value = currentThread['Goal'] || '';
  document.getElementById('et-progress').value = currentThread['Current progress'] || '';
  document.getElementById('et-nextstep').value = currentThread['Next step'] || '';
  document.getElementById('et-decisions').value = currentThread['Decisions made'] || '';
  document.getElementById('et-questions').value = currentThread['Open question'] || '';
  document.getElementById('et-notes').value = currentThread['Note'] || '';
}

function closeEditThread() {
  document.getElementById('edit-thread-view').style.display = 'none';
  document.getElementById('thread-view').style.display = 'flex';
}

async function saveEditThread() {
  const updates = {
    'Thread name': document.getElementById('et-name').value.trim(),
    'Status': document.getElementById('et-status').value,
    'Goal': document.getElementById('et-goal').value.trim(),
    'Current progress': document.getElementById('et-progress').value.trim(),
    'Next step': document.getElementById('et-nextstep').value.trim(),
    'Decisions made': document.getElementById('et-decisions').value.trim(),
    'Open question': document.getElementById('et-questions').value.trim(),
    'Note': document.getElementById('et-notes').value.trim(),
  };
  const { error } = await db.from('Threads').update(updates).eq('id', currentThread.id);
  if (error) alert('Error: ' + error.message);
  else { Object.assign(currentThread, updates); closeEditThread(); addMessage('assistant', 'Thread updated.'); }
}

async function deleteThread() {
  if (!currentThread) return;
  if (!confirm('Delete "' + currentThread['Thread name'] + '"? Cannot be undone.')) return;
  const { error } = await db.from('Threads').delete().eq('id', currentThread.id);
  if (error) alert('Error: ' + error.message);
  else {
    document.getElementById('edit-thread-view').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    currentView = 'dashboard'; currentThread = null; loadThreads();
  }
}

async function saveNewThread() {
  const name = document.getElementById('nt-name').value.trim();
  const goal = document.getElementById('nt-goal').value.trim();
  if (!name || !goal) { alert('Name and goal are required.'); return; }
  const newThread = {
    'Thread name': name,
    'platform': document.getElementById('nt-platform').value,
    'Goal': goal,
    'Status': 'Active',
    'Current progress': document.getElementById('nt-progress').value.trim(),
    'Next step': document.getElementById('nt-nextstep').value.trim(),
    'Decisions made': document.getElementById('nt-decisions').value.trim(),
    'Open question': document.getElementById('nt-questions').value.trim(),
    'Note': document.getElementById('nt-notes').value.trim(),
  };
  const { error } = await db.from('Threads').insert([newThread]);
  if (error) { alert('Error: ' + error.message); return; }
  ['nt-name','nt-goal','nt-progress','nt-nextstep','nt-decisions','nt-questions','nt-notes'].forEach(id => {
    document.getElementById(id).value = '';
  });
  closeNewThreadForm();
  loadThreads();
}

// ─── GREETING ─────────────────────────────────────────────────────────────────

async function greetOnLoad() {
  const result = await db.from('Threads').select('*');
  const threads = result.data || [];
  const active = threads.filter(t => t['Status'] === 'Active' && t['thread_type'] !== 'feature' && !isInTriage(t));
  if (active.length === 0) return;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const suggested = active.find(t => t['Next step']) || active[0];
  const masterCtx = await buildMasterContext(threads);
  systemContext = masterCtx;
  chatHistory = [];

  const prompt = `${greeting} David. Brief, natural, personal greeting. ${active.length} active projects. Suggest one thing to work on based on: "${suggested['Thread name']}" — next step: "${suggested['Next step'] || 'no next step set'}". 2-3 sentences max. Direct and energetic.`;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system: masterCtx, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await response.json();
    if (data.content && data.content[0]) {
      const msg = data.content[0].text;
      showDashboardMessage('assistant', msg);
      const u = new SpeechSynthesisUtterance(msg);
      u.rate = 1.05;
      window.speechSynthesis.speak(u);
      chatHistory.push({ role: 'assistant', content: msg });
    }
  } catch(e) {}
}

// ─── VOICE ───────────────────────────────────────────────────────────────────

function handleVoiceTranscript(transcript) {
  const t = transcript.toLowerCase().trim();
  if (t.startsWith('project ') || t.startsWith('switch to ') || t.startsWith('open ')) {
    switchToProject(t.replace(/^(project |switch to |open )/, '').trim());
  } else if (t === 'new thread' || t === 'add thread') {
    openNewThreadForm();
  } else if (['bank it','bank that','save that','remember that','hold that'].includes(t)) {
    saveIdea(t);
  } else if (t.includes('save progress') || t.includes('save session')) {
    saveProgress();
  } else if (t.includes('edit thread') || t.includes('update thread')) {
    openEditThread();
  } else {
    const inputId = currentView === 'dashboard' ? 'dashboard-input' : 'chat-input';
    const input = document.getElementById(inputId);
    if (input) { input.value = transcript.trim(); sendMessage(inputId); }
  }
}

const micBtn = document.getElementById('mic-btn');

if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = function(event) {
    let interim = '', final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) final += event.results[i][0].transcript;
      else interim += event.results[i][0].transcript;
    }
    const inputId = currentView === 'dashboard' ? 'dashboard-input' : 'chat-input';
    const textarea = document.getElementById(inputId);
    if (textarea) { textarea.value = final || interim; textarea.scrollTop = textarea.scrollHeight; }
    if (final) handleVoiceTranscript(final);
  };

  recognition.onerror = function(e) {
    if (e.error !== 'no-speech') { isListening = false; micBtn.textContent = '🎤'; }
  };

  recognition.onend = function() {
    if (isListening) { setTimeout(() => { if (isListening) recognition.start(); }, 300); }
    else { micBtn.textContent = '🎤'; }
  };

  micBtn.addEventListener('click', function() {
    if (!audioEnabled) {
      audioEnabled = true; isListening = true; micBtn.textContent = '🔴';
      window.speechSynthesis.speak(new SpeechSynthesisUtterance('Jarvis listening.'));
      recognition.start();
    } else if (isListening) {
      isListening = false; recognition.stop(); micBtn.textContent = '🎤';
    } else {
      isListening = true; micBtn.textContent = '🔴'; recognition.start();
    }
  });
} else {
  micBtn.style.opacity = '0.3';
}

// ─── EVENT LISTENERS ─────────────────────────────────────────────────────────

document.getElementById('send-btn').addEventListener('click', () => sendMessage('chat-input'));
document.getElementById('chat-input').addEventListener('keypress', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage('chat-input'); }
});
document.getElementById('dashboard-send').addEventListener('click', () => sendMessage('dashboard-input'));
document.getElementById('dashboard-input').addEventListener('keypress', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage('dashboard-input'); }
});
document.getElementById('new-thread-btn').addEventListener('click', openNewThreadForm);

// ─── INIT ─────────────────────────────────────────────────────────────────────

window.db = db;

loadDavidProfile().then(() => {
  loadThreads().then(() => {
    setTimeout(greetOnLoad, 800);
  });
});
