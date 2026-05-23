const SUPABASE_URL = 'https://jbsocnomwxovqyhiukcl.supabase.co';
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

// ─── THREADS / DASHBOARD ─────────────────────────────────────────────────────

const TRIAGE_DAYS = 14;

function isInTriage(thread) {
  if (thread['Status'] !== 'Active') return false;
  const progress = thread['Current progress'] || '';
  const lastSaved = progress.match(/\[(?:Auto-saved|Session) ([^\]]+)\]/g);
  if (!lastSaved) return false;
  const lastEntry = lastSaved[lastSaved.length - 1];
  const dateStr = lastEntry.replace(/\[(?:Auto-saved|Session) /, '').replace(']', '').split(' ')[0];
  const lastDate = new Date(dateStr);
  if (isNaN(lastDate)) return false;
  const daysSince = (Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24);
  return daysSince >= TRIAGE_DAYS;
}

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

    threads.forEach(t => {
      if (t['Status'] === 'Active' && isInTriage(t)) {
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
      return `<div class="thread-card ${isPaused ? 'paused' : ''} ${isComplete ? 'complete' : ''}" onclick="openThread(${thread.id})">
        <div class="platform-badge">${thread.platform || 'Claude'}</div>
        <h2>${thread['Thread name']}</h2>
        <p class="thread-status">${thread['Status'] || 'Active'} · ${thread['Next step'] ? thread['Next step'].slice(0,60) + '...' : 'No next step set'}</p>
      </div>`;
    };

    let html = '';

    if (active.length > 0) {
      html += active.map(renderCard).join('');
    }

    if (other.length > 0) {
      html += other.map(renderCard).join('');
    }

    if (triage.length > 0) {
      html += `<div class="triage-section">
        <div class="triage-header">
          <div class="triage-dot"></div>
          <span class="triage-label">Triage</span>
          <span class="triage-count">${triage.length}</span>
        </div>
        <p class="triage-desc">Inactive 14+ days — review, reactivate, or close.</p>
        ${triage.map(t => `<div class="thread-card triage" onclick="openThread(${t.id})">
          <div class="platform-badge">${t.platform || 'Claude'}</div>
          <h2>${t['Thread name']}</h2>
          <p class="thread-status">Triage · ${t['Next step'] ? t['Next step'].slice(0,60) + '...' : 'No next step set'}</p>
        </div>`).join('')}
      </div>`;
    }

    document.getElementById('thread-list').innerHTML = html;

  } catch(e) {
    document.getElementById('thread-list').innerHTML = '<p class="loading">Error: ' + e.message + '</p>';
  }
}

// ─── BOARD: INSTANT RENDER FROM THREAD DATA ──────────────────────────────────

function buildBoardFromThread(thread, ideas) {
  const board = {};

  // Goal → Where We Are
  if (thread['Goal']) {
    board.where = thread['Goal'];
  }

  // Next Step → Moving
  if (thread['Next step']) {
    board.moving = [{
      title: 'Next Step',
      body: thread['Next step'],
      tag: 'strategy',
      why: 'This is the current priority.',
      next: thread['Next step']
    }];
  }

  // Open Questions → Blocked
  if (thread['Open question']) {
    const questions = thread['Open question'].split('\n').filter(q => q.trim());
    board.blocked = questions.map(q => ({
      title: q.slice(0, 60),
      body: q,
      tag: 'strategy',
      why: 'Unresolved question blocking progress.',
      next: 'Decide or research this.'
    }));
  }

  // Decisions Made → Decided
  if (thread['Decisions made']) {
    const decisions = thread['Decisions made'].split('\n').filter(d => d.trim());
    board.decided = decisions.map(d => ({
      title: d.slice(0, 60),
      body: d,
      tag: 'strategy',
      why: 'Decision locked in.',
      next: 'Execute on this.'
    }));
  }

  // Banked Ideas → Horizon
  if (ideas && ideas.length > 0) {
    board.horizon = ideas.slice(0, 4).map(i => ({
      title: i.idea_text.slice(0, 55),
      body: i.idea_text,
      tag: 'strategy',
      why: 'Banked for future consideration.',
      next: 'Revisit when ready.'
    }));
  }

  return board;
}

async function generateInsightCard(thread, ideas) {
  const prompt = `You are Jarvis. One sharp insight about this project — one sentence connecting something here to a broader opportunity or risk. No preamble.

Project: ${thread['Thread name']}
Goal: ${thread['Goal'] || ''}
Next Step: ${thread['Next step'] || ''}
Open Questions: ${thread['Open question'] || ''}
Decisions: ${thread['Decisions made'] || ''}
Banked Ideas: ${(ideas || []).map(i => i.idea_text).join(' | ') || 'None'}`;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: 'You generate one sharp insight sentence about a project. No markdown, no preamble, just the insight.',
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    if (data.content && data.content[0]) {
      return data.content[0].text.trim();
    }
  } catch(e) {}
  return null;
}

function renderBoard(board) {
  const zoneColors = { moving: '#34d399', blocked: '#f87171', decided: '#60a5fa', horizon: '#fbbf24' };
  const zoneLabels = { moving: 'Moving', blocked: 'Blocked', decided: 'Decided', horizon: 'Horizon' };
  const zoneDots  = { moving: 'green',  blocked: 'red',     decided: 'blue',    horizon: 'amber'  };

  let html = '';

  if (board.where) {
    html += `<div class="where-card">
      <div class="zone-eyebrow">🧭 Where We Are</div>
      <div class="where-body">${board.where}</div>
      <div class="where-ts">Updated · ${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>
    </div>`;
  }

  // Insight placeholder — filled async
  html += `<div class="insight" id="insight-card" style="opacity:0.35;">
    <div class="insight-icon">⚡</div>
    <div>
      <div class="insight-label">Jarvis Insight</div>
      <div class="insight-text" id="insight-text">Thinking...</div>
    </div>
  </div>`;

  const hasContent = ['moving','blocked','decided','horizon'].some(z => board[z] && board[z].length > 0);

  ['moving','blocked','decided','horizon'].forEach(zone => {
    const cards = board[zone];
    const color = zoneDots[zone];
    const label = zoneLabels[zone];

    html += `<div class="zone-section">
      <div class="zone-header">
        <div class="zone-dot ${color}"></div>
        <span class="zone-name ${color}">${label}</span>
        <span class="zone-count ${color}">${cards ? cards.length : 0}</span>
      </div>`;

    if (!cards || cards.length === 0) {
      html += `<div class="card-empty">Nothing here yet</div>`;
    } else {
      cards.forEach(card => {
        const t = (card.title||'').replace(/'/g,"\\'");
        const b = (card.body||'').replace(/'/g,"\\'");
        const w = (card.why||'').replace(/'/g,"\\'");
        const n = (card.next||'').replace(/'/g,"\\'");
        const c = zoneColors[zone];
        html += `<div class="card ${color}" onclick="openCardDetail('${t}','${label}','${c}','${b}','${w}','${n}')">
          <div class="card-title">${card.title}</div>
          <div class="card-body">${card.body}</div>
          <span class="card-tag tag-${card.tag||'strategy'}">${card.tag||'strategy'}</span>
          <div class="card-arrow">›</div>
        </div>`;
      });
    }

    html += `</div>`;
  });

  document.getElementById('board-content').innerHTML = html;
}

function injectInsight(text) {
  const card = document.getElementById('insight-card');
  const textEl = document.getElementById('insight-text');
  if (card && textEl) {
    textEl.textContent = text;
    card.style.opacity = '1';
    card.style.transition = 'opacity 0.5s ease';
  }
}

// ─── CARD DETAIL OVERLAY ─────────────────────────────────────────────────────

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

  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('thread-view').style.display = 'flex';
  document.getElementById('thread-title').textContent = currentThread['Thread name'];
  document.getElementById('chat-messages').innerHTML = '';
  document.getElementById('board-content').innerHTML = '<p class="loading" style="margin-top:16px;">Loading board...</p>';

  const micBtn = document.getElementById('mic-btn');
  micBtn.textContent = '🎤';
  micBtn.style.opacity = '1';

  const ideasResult = await db.from('Ideas').select('*').eq('thread_id', id);
  const ideas = ideasResult.data || [];

  // ── Instant board render ──
  const board = buildBoardFromThread(currentThread, ideas);
  renderBoard(board);

  // ── Async insight card ──
  generateInsightCard(currentThread, ideas).then(insight => {
    if (insight) injectInsight(insight);
    else {
      const card = document.getElementById('insight-card');
      if (card) card.style.display = 'none';
    }
  });

  // ── System context for chat ──
  const allThreadsResult = await db.from('Threads').select('*');
  const otherThreads = (allThreadsResult.data || []).filter(t => t.id !== id && t['Status'] === 'Active');
  const davidCtx = buildDavidContext();

  const crossThreadContext = otherThreads.length > 0
    ? '\n\nOTHER ACTIVE PROJECTS:\n' + otherThreads.map(t => `- ${t['Thread name']}: ${t['Goal'] ? t['Goal'].slice(0,100) : 'No goal'}${t['Next step'] ? ' | Next: ' + t['Next step'].slice(0,80) : ''}`).join('\n')
    : '';

  const ideasContext = ideas.length > 0
    ? '\n\nBANKED IDEAS:\n' + ideas.map(i => '- ' + i.idea_text.slice(0,200)).join('\n')
    : '';

  const recentProgress = currentThread['Current progress']
    ? '\n\nRECENT HISTORY:\n' + currentThread['Current progress'].slice(-2000)
    : '';

  systemContext = `You are Jarvis, a personal AI partner for David Rogers.

${davidCtx}

CURRENT PROJECT: "${currentThread['Thread name']}"
Goal: ${currentThread['Goal']}
Status: ${currentThread['Status']}
Next Steps: ${currentThread['Next step']}
Decisions Made: ${currentThread['Decisions made']}
Open Questions: ${currentThread['Open question']}
Notes: ${currentThread['Note']}${recentProgress}${ideasContext}${crossThreadContext}

David is looking at the visual board for this project while chatting with you. Help him go deep on specific cards, make decisions, capture ideas, or take action. Keep responses short and conversational. No markdown.`;

  let openingMsg = `On ${currentThread['Thread name']}.`;
  if (currentThread['Next step']) openingMsg += ` Next up: ${currentThread['Next step']}`;
  addMessage('assistant', openingMsg);
}

// ─── CONTEXT / CHAT ──────────────────────────────────────────────────────────

async function buildMasterContext(threads) {
  const active = threads.filter(t => t['Status'] === 'Active');
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
  if (match) {
    openThread(match.id);
  } else {
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
  if (role !== 'assistant' || chatHistory.length === 0) {
    chatHistory.push({ role, content: text });
  }
  if (role === 'assistant' && text !== '...') speak(text);
}

function speak(text) {
  if (!audioEnabled) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05; u.pitch = 1.0; u.volume = 1.0;
  window.speechSynthesis.speak(u);
}

async function sendMessage(inputId) {
  const inputElId = inputId || (currentView === 'dashboard' ? 'dashboard-input' : 'chat-input');
  const input = document.getElementById(inputElId);
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  if (currentView === 'dashboard') {
    const allResult = await db.from('Threads').select('*');
    systemContext = await buildMasterContext(allResult.data || []);
    showDashboardMessage('user', text);
    chatHistory.push({ role: 'user', content: text });
    const thinking = document.createElement('div');
    thinking.className = 'message assistant thinking';
    thinking.textContent = '...';
    const msgContainer = document.getElementById('dashboard-messages');
    msgContainer.appendChild(thinking);
    msgContainer.scrollTop = 999999;
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
        showDashboardMessage('assistant', reply);
        chatHistory.push({ role: 'assistant', content: reply });
        speak(reply);
      }
    } catch(e) {
      thinking.remove();
      showDashboardMessage('assistant', 'Error: ' + e.message);
    }
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
  if (error) { addMessage('assistant', 'Error saving: ' + error.message); }
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
  if (error) { alert('Error: ' + error.message); }
  else { Object.assign(currentThread, updates); closeEditThread(); addMessage('assistant', 'Thread updated.'); }
}

async function deleteThread() {
  if (!currentThread) return;
  if (!confirm('Delete "' + currentThread['Thread name'] + '"? Cannot be undone.')) return;
  const { error } = await db.from('Threads').delete().eq('id', currentThread.id);
  if (error) { alert('Error: ' + error.message); }
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
  const active = threads.filter(t => t['Status'] === 'Active');
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

loadDavidProfile().then(() => {
  loadThreads().then(() => {
    setTimeout(greetOnLoad, 800);
  });
});
