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

async function loadThreads() {
  try {
    const result = await db.from('Threads').select('*');
    if (result.error) throw result.error;
    if (result.data && result.data.length > 0) {
      const sorted = result.data.sort((a, b) => {
        const order = { 'Active': 0, 'Paused': 1, 'Complete': 2 };
        return (order[a['Status']] || 0) - (order[b['Status']] || 0);
      });
      const html = sorted.map(thread => {
        const isComplete = thread['Status'] === 'Complete';
        const isPaused = thread['Status'] === 'Paused';
        return `
          <div class="thread-card ${isPaused ? 'paused' : ''} ${isComplete ? 'complete' : ''}" onclick="openThread(${thread.id})">
            <div class="platform-badge">${thread.platform || 'Claude'}</div>
            <h2>${thread['Thread name']}</h2>
            <p class="thread-status">${thread['Status'] || 'Active'} · ${thread['Next step'] ? thread['Next step'].slice(0,60) + '...' : 'No next step set'}</p>
          </div>
        `;
      }).join('');
      document.getElementById('thread-list').innerHTML = html;
    } else {
      document.getElementById('thread-list').innerHTML = 
        '<p class="loading">No threads yet. Tap + to add one.</p>';
    }
  } catch(e) {
    document.getElementById('thread-list').innerHTML = 
      '<p class="loading">Error: ' + e.message + '</p>';
  }
}

async function buildMasterContext() {
  const result = await db.from('Threads').select('*');
  const threads = (result.data || []).filter(t => t['Status'] === 'Active');
  return `You are Jarvis, a personal AI assistant for David Rogers.

David is viewing his dashboard — no specific project is open. You have awareness of all his active projects.

ACTIVE PROJECTS:
${threads.map(t => `- ${t['Thread name']}: ${t['Goal'] ? t['Goal'].slice(0, 120) : 'No goal'} | Next: ${t['Next step'] ? t['Next step'].slice(0, 80) : 'Not set'}`).join('\n')}

ABOUT DAVID:
- 60 years old, works exclusively from his phone
- Has ADHD — needs focused, clear, concise responses  
- Building Jarvis as personal tool and future market product
- Responds well to pushback and honest assessment
- Voice input preferred — keep responses short and conversational

You can help David decide what to work on, capture new ideas, switch to a project, or just think things through. If he says "project [name]" or "switch to [name]", confirm you're switching and the app will navigate there. Respond conversationally — never use code blocks, YAML, bullet lists, or formatted output. Just talk.`;
}

async function openThread(id) {
  const result = await db.from('Threads').select('*').eq('id', id).single();
  if (!result.data) return;
  
  currentThread = result.data;
  chatHistory = [];
  audioEnabled = false;
  isListening = false;
  currentView = 'chat';
  
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('chat-view').style.display = 'flex';
  document.getElementById('thread-title').textContent = currentThread['Thread name'];
  document.getElementById('chat-messages').innerHTML = '';
  
  const micBtn = document.getElementById('mic-btn');
  micBtn.textContent = '🎤';
  micBtn.style.opacity = '1';

  const ideasResult = await db.from('Ideas').select('*').eq('thread_id', id);
  const ideas = ideasResult.data || [];
  
  if (ideas.length > 0) {
    const ideasHtml = ideas.map(idea => 
      `<div class="idea-chip">💡 ${idea.idea_text.slice(0, 100)}${idea.idea_text.length > 100 ? '...' : ''}</div>`
    ).join('');
    const ideasDiv = document.createElement('div');
    ideasDiv.className = 'ideas-panel';
    ideasDiv.innerHTML = '<div class="ideas-label">BANKED IDEAS (' + ideas.length + ')</div>' + ideasHtml;
    document.getElementById('chat-messages').appendChild(ideasDiv);
  }

  const allThreadsResult = await db.from('Threads').select('*');
  const otherThreads = (allThreadsResult.data || []).filter(t => t.id !== id && t['Status'] === 'Active');
  
  const crossThreadContext = otherThreads.length > 0
    ? '\n\nOTHER ACTIVE PROJECTS:\n' + otherThreads.map(t => 
        `- ${t['Thread name']}: ${t['Goal'] ? t['Goal'].slice(0, 100) : 'No goal set'}${t['Next step'] ? ' | Next: ' + t['Next step'].slice(0, 80) : ''}`
      ).join('\n')
    : '';

  const ideasContext = ideas.length > 0 
    ? '\n\nBANKED IDEAS:\n' + ideas.map(i => '- ' + i.idea_text.slice(0, 200)).join('\n')
    : '';

  const recentProgress = currentThread['Current progress'] 
    ? '\n\nRECENT SESSION HISTORY:\n' + currentThread['Current progress'].slice(-2000)
    : '';
  
  systemContext = `You are Jarvis, a personal AI assistant for David Rogers.

CURRENT PROJECT: "${currentThread['Thread name']}"
Goal: ${currentThread['Goal']}
Status: ${currentThread['Status']}
Next Steps: ${currentThread['Next step']}
Decisions Made: ${currentThread['Decisions made']}
Open Questions: ${currentThread['Open question']}
Notes: ${currentThread['Note']}${recentProgress}${ideasContext}${crossThreadContext}

ABOUT DAVID:
- 60 years old, works exclusively from his phone
- Has ADHD — needs focused, clear, concise responses
- Prefers direct practical guidance, not excessive explanation
- Building Jarvis as both personal tool and future market product
- Responds well to pushback and honest assessment
- Tends toward big picture thinking — sometimes needs redirecting to immediate problem
- Voice input preferred — keep responses short and conversational

CAPABILITIES:
- "bank it" or "bank that" → saves idea to permanent database
- "save that" or "remember that" or "hold that" → saves idea
- "save progress" or "save session" → saves conversation summary
- "project [name]" or "switch to [name]" → switches project
- "edit thread" → opens edit form
- "what am I working on" → list all active projects
- "show ideas" → read back banked ideas for this thread
- Tap ← Back → auto-saves session

Respond conversationally. Never use code blocks, YAML, markdown formatting, or bullet lists. Just talk naturally — responses may be listened to, not read.`;

  // Smart opening — reference recent history if available
  let openingMsg = `Ready to work on ${currentThread['Thread name']}.`;
  if (currentThread['Current progress'] && currentThread['Current progress'].length > 100) {
    openingMsg += ` Picking up where we left off.`;
  } else if (currentThread['Next step']) {
    openingMsg += ` Next up: ${currentThread['Next step']}`;
  }
  
  addMessage('assistant', openingMsg);
}

function speak(text) {
  if (!audioEnabled) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  utterance.pitch = 1.0;
  utterance.volume = 1.0;
  window.speechSynthesis.speak(utterance);
}

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = 'message ' + role;
  div.textContent = text;
  
  const messagesEl = document.getElementById('chat-messages') || document.getElementById('dashboard-messages');
  if (messagesEl) {
    messagesEl.appendChild(div);
    messagesEl.scrollTop = 999999;
  }
  
  if (role !== 'assistant' || chatHistory.length === 0) {
    chatHistory.push({ role, content: text });
  }
  if (role === 'assistant' && text !== '...') {
    speak(text);
  }
}

async function sendMessage(inputId) {
  const inputElId = inputId || (currentView === 'dashboard' ? 'dashboard-input' : 'chat-input');
  const input = document.getElementById(inputElId);
  const text = input.value.trim();
  if (!text) return;
  
  input.value = '';

  // For dashboard, use master context
  if (currentView === 'dashboard') {
    const masterCtx = await buildMasterContext();
    systemContext = masterCtx;
    
    const msgContainer = document.getElementById('dashboard-messages');
    msgContainer.style.display = 'flex';
    
    const userDiv = document.createElement('div');
    userDiv.className = 'message user';
    userDiv.textContent = text;
    msgContainer.appendChild(userDiv);
    msgContainer.scrollTop = 999999;
    chatHistory.push({ role: 'user', content: text });
    
    const thinking = document.createElement('div');
    thinking.className = 'message assistant thinking';
    thinking.textContent = '...';
    msgContainer.appendChild(thinking);
    msgContainer.scrollTop = 999999;
    
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system: systemContext,
          messages: chatHistory.slice(-10)
        })
      });
      const data = await response.json();
      thinking.remove();
      if (data.content && data.content[0]) {
        const reply = data.content[0].text;
        const replyDiv = document.createElement('div');
        replyDiv.className = 'message assistant';
        replyDiv.textContent = reply;
        msgContainer.appendChild(replyDiv);
        msgContainer.scrollTop = 999999;
        chatHistory.push({ role: 'assistant', content: reply });
        speak(reply);
      }
    } catch(e) {
      thinking.remove();
      const errDiv = document.createElement('div');
      errDiv.className = 'message assistant';
      errDiv.textContent = 'Error: ' + e.message;
      msgContainer.appendChild(errDiv);
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
      body: JSON.stringify({
        system: systemContext,
        messages: chatHistory.slice(-10)
      })
    });
    const data = await response.json();
    thinking.remove();
    if (data.content && data.content[0]) {
      const reply = data.content[0].text;
      addMessage('assistant', reply);
      chatHistory.push({ role: 'assistant', content: reply });
    } else {
      addMessage('assistant', 'Error: ' + JSON.stringify(data));
    }
  } catch(e) {
    thinking.remove();
    addMessage('assistant', 'Error: ' + e.message);
  }
}

async function autoSaveProgress() {
  if (!currentThread || chatHistory.length < 3) return;
  const summary = chatHistory.slice(-8).map(m => (m.role === 'user' ? 'Me: ' : 'Jarvis: ') + m.content).join('\n');
  const newProgress = (currentThread['Current progress'] || '') + '\n\n[Auto-saved ' + new Date().toLocaleDateString() + ' ' + new Date().toLocaleTimeString() + ']\n' + summary;
  await db.from('Threads').update({ 'Current progress': newProgress }).eq('id', currentThread.id);
}

function backToDashboard() {
  autoSaveProgress();
  window.speechSynthesis.cancel();
  if (isListening && recognition) {
    isListening = false;
    recognition.stop();
  }
  audioEnabled = false;
  currentView = 'dashboard';
  document.getElementById('dashboard').style.display = 'block';
  document.getElementById('chat-view').style.display = 'none';
  currentThread = null;
  chatHistory = [];
  
  const micBtn = document.getElementById('mic-btn');
  if (micBtn) { micBtn.textContent = '🎤'; }
}

async function saveIdea(transcript) {
  const targetThread = currentThread;
  if (!targetThread) {
    // On dashboard, just save to a general idea without thread_id
    addDashboardMessage('assistant', 'Banked to your Idea Bank.');
    return;
  }
  const recentContext = chatHistory.slice(-4).map(m => m.content).join(' | ');
  const ideaText = recentContext || transcript;
  const { error } = await db.from('Ideas').insert([{
    thread_id: targetThread.id,
    idea_text: ideaText
  }]);
  if (error) {
    addMessage('assistant', 'Error saving idea: ' + error.message);
  } else {
    addMessage('assistant', 'Banked.');
  }
}

function addDashboardMessage(role, text) {
  const msgContainer = document.getElementById('dashboard-messages');
  msgContainer.style.display = 'flex';
  const div = document.createElement('div');
  div.className = 'message ' + role;
  div.textContent = text;
  msgContainer.appendChild(div);
  msgContainer.scrollTop = 999999;
  if (role === 'assistant') speak(text);
}

async function saveProgress() {
  if (!currentThread) return;
  const summary = chatHistory.slice(-6).map(m => (m.role === 'user' ? 'Me: ' : 'Jarvis: ') + m.content).join('\n');
  const newProgress = (currentThread['Current progress'] || '') + '\n\n[Session ' + new Date().toLocaleDateString() + ']\n' + summary;
  const { error } = await db.from('Threads').update({ 'Current progress': newProgress }).eq('id', currentThread.id);
  if (error) {
    addMessage('assistant', 'Error saving progress: ' + error.message);
  } else {
    currentThread['Current progress'] = newProgress;
    addMessage('assistant', 'Progress saved.');
  }
}

function openEditThread() {
  if (!currentThread) return;
  document.getElementById('chat-view').style.display = 'none';
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
  document.getElementById('chat-view').style.display = 'flex';
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
  if (error) {
    alert('Error: ' + error.message);
  } else {
    Object.assign(currentThread, updates);
    closeEditThread();
    addMessage('assistant', 'Thread updated.');
  }
}

async function deleteThread() {
  if (!currentThread) return;
  const confirmed = confirm('Delete "' + currentThread['Thread name'] + '"? This cannot be undone.');
  if (!confirmed) return;
  const { error } = await db.from('Threads').delete().eq('id', currentThread.id);
  if (error) {
    alert('Error deleting: ' + error.message);
  } else {
    document.getElementById('edit-thread-view').style.display = 'none';
    document.getElementById('dashboard').style.display = 'block';
    currentView = 'dashboard';
    currentThread = null;
    loadThreads();
  }
}

async function switchToProject(name) {
  const result = await db.from('Threads').select('*');
  if (!result.data) return;
  const match = result.data.find(t => t['Thread name'].toLowerCase().includes(name));
  if (match) {
    openThread(match.id);
  } else {
    addMessage('assistant', `Couldn't find "${name}". Check your dashboard.`);
  }
}

function openNewThreadForm() {
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('new-thread-view').style.display = 'block';
}

function closeNewThreadForm() {
  document.getElementById('new-thread-view').style.display = 'none';
  document.getElementById('dashboard').style.display = 'block';
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

// Voice handler — works for both dashboard and thread views
function handleVoiceTranscript(transcript) {
  const t = transcript.toLowerCase().trim();
  
  if (t.startsWith('project ') || t.startsWith('switch to ') || t.startsWith('open ')) {
    const name = t.replace(/^(project |switch to |open )/, '').trim();
    switchToProject(name);
  } else if (t === 'new thread' || t === 'add thread') {
    openNewThreadForm();
  } else if (t === 'bank it' || t === 'bank that' || t === 'save that' || t === 'remember that' || t === 'hold that') {
    saveIdea(t);
  } else if (t.includes('save progress') || t.includes('save session')) {
    saveProgress();
  } else if (t.includes('edit thread') || t.includes('update thread')) {
    openEditThread();
  } else {
    // Regular message
    const inputId = currentView === 'dashboard' ? 'dashboard-input' : 'chat-input';
    const input = document.getElementById(inputId);
    if (input) {
      input.value = transcript.trim();
      sendMessage(inputId);
    }
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
    if (textarea) {
      textarea.value = final || interim;
      textarea.scrollTop = textarea.scrollHeight;
    }
    if (final) handleVoiceTranscript(final);
  };

  recognition.onerror = function(e) {
    if (e.error !== 'no-speech') {
      isListening = false;
      micBtn.textContent = '🎤';
    }
  };

  recognition.onend = function() {
    if (isListening) {
      setTimeout(() => { if (isListening) recognition.start(); }, 300);
    } else {
      micBtn.textContent = '🎤';
    }
  };

  micBtn.addEventListener('click', function() {
    if (!audioEnabled) {
      audioEnabled = true; isListening = true; micBtn.textContent = '🔴';
      const u = new SpeechSynthesisUtterance('Jarvis listening.');
      window.speechSynthesis.speak(u);
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

document.getElementById('send-btn').addEventListener('click', () => sendMessage('chat-input'));
document.getElementById('chat-input').addEventListener('keypress', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage('chat-input'); }
});
document.getElementById('dashboard-send').addEventListener('click', () => sendMessage('dashboard-input'));
document.getElementById('dashboard-input').addEventListener('keypress', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage('dashboard-input'); }
});
document.getElementById('new-thread-btn').addEventListener('click', openNewThreadForm);

loadThreads();
