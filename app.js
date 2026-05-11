const SUPABASE_URL = 'https://jbsocnomwxodqyhiukcl.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impic29jbm9td3hvZHF5aGl1a2NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyNjQ5NTUsImV4cCI6MjA5Mzg0MDk1NX0.ehX6AEqpSpVAF9Q3UxIabZXdZKLDqKKP9KL3pDIPhHE';

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

let currentThread = null;
let chatHistory = [];
let systemContext = '';

async function loadThreads() {
  try {
    const result = await db.from('Threads').select('*');
    if (result.data && result.data.length > 0) {
      const html = result.data.map(thread => `
        <div class="thread-card" onclick="openThread(${thread.id})">
          <div class="platform-badge">${thread.platform || 'Claude'}</div>
          <h2>${thread['Thread name']}</h2>
          <p>${thread['Goal'] || ''}</p>
        </div>
      `).join('');
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

async function openThread(id) {
  const result = await db.from('Threads').select('*').eq('id', id).single();
  if (!result.data) return;
  
  currentThread = result.data;
  chatHistory = [];
  
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('chat-view').style.display = 'flex';
  document.getElementById('thread-title').textContent = currentThread['Thread name'];
  document.getElementById('chat-messages').innerHTML = '';
  
  systemContext = `You are Jarvis, a personal AI assistant helping with a project called "${currentThread['Thread name']}".

Goal: ${currentThread['Goal']}
Status: ${currentThread['Status']}
Progress: ${currentThread['Current progress']}
Next Steps: ${currentThread['Next step']}
Decisions Made: ${currentThread['Decisions made']}
Open Questions: ${currentThread['Open question']}
Notes: ${currentThread['Note']}

The user works exclusively from their phone. They prefer direct, practical guidance. They have ADHD and benefit from focused, clear responses. Get straight to helping them make progress.`;

  addMessage('assistant', `Ready to work on ${currentThread['Thread name']}. ${currentThread['Next step'] ? 'Next up: ' + currentThread['Next step'] : 'What would you like to tackle?'}`);
}

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = 'message ' + role;
  div.textContent = text;
  document.getElementById('chat-messages').appendChild(div);
  document.getElementById('chat-messages').scrollTop = 999999;
  if (role !== 'assistant' || chatHistory.length === 0) {
    chatHistory.push({ role, content: text });
  }
}

async function sendMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  
  input.value = '';
  addMessage('user', text);
  chatHistory.push({ role: 'user', content: text });
  
  const thinking = document.createElement('div');
  thinking.className = 'message assistant thinking';
  thinking.textContent = '...';
  document.getElementById('chat-messages').appendChild(thinking);
  
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

function backToDashboard() {
  document.getElementById('dashboard').style.display = 'block';
  document.getElementById('chat-view').style.display = 'none';
  currentThread = null;
  chatHistory = [];
}

document.getElementById('send-btn').addEventListener('click', sendMessage);
document.getElementById('chat-input').addEventListener('keypress', function(e) {
  if (e.key === 'Enter') sendMessage();
});
document.getElementById('new-thread-btn').addEventListener('click', function() {
  alert('New thread form coming soon.');
});

loadThreads();
