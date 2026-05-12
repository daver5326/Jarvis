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
  audioEnabled = false;
  isListening = false;
  
  document.getElementById('dashboard').style.display = 'none';
  document.getElementById('chat-view').style.display = 'flex';
  document.getElementById('thread-title').textContent = currentThread['Thread name'];
  document.getElementById('chat-messages').innerHTML = '';
  
  const micBtn = document.getElementById('mic-btn');
  micBtn.textContent = '🎤';
  micBtn.style.opacity = '1';
  
  systemContext = `You are Jarvis, a personal AI assistant helping with a project called "${currentThread['Thread name']}".

Goal: ${currentThread['Goal']}
Status: ${currentThread['Status']}
Progress: ${currentThread['Current progress']}
Next Steps: ${currentThread['Next step']}
Decisions Made: ${currentThread['Decisions made']}
Open Questions: ${currentThread['Open question']}
Notes: ${currentThread['Note']}

The user works exclusively from their phone. They prefer direct, practical guidance. They have ADHD and benefit from focused, clear responses. Get straight to helping them make progress. Keep responses concise and conversational since they may be listening rather than reading.`;

  addMessage('assistant', `Ready to work on ${currentThread['Thread name']}. ${currentThread['Next step'] ? 'Next up: ' + currentThread['Next step'] : 'What would you like to tackle?'}`);
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
  document.getElementById('chat-messages').appendChild(div);
  document.getElementById('chat-messages').scrollTop = 999999;
  if (role !== 'assistant' || chatHistory.length === 0) {
    chatHistory.push({ role, content: text });
  }
  if (role === 'assistant' && text !== '...') {
    speak(text);
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

function backToDashboard() {
  window.speechSynthesis.cancel();
  if (isListening && recognition) {
    isListening = false;
    recognition.stop();
  }
  audioEnabled = false;
  document.getElementById('dashboard').style.display = 'block';
  document.getElementById('chat-view').style.display = 'none';
  currentThread = null;
  chatHistory = [];
}

async function saveIdea(transcript) {
  if (!currentThread) {
    addMessage('assistant', "I need to be in a thread to save an idea. Open a project first.");
    return;
  }
  
  const recentContext = chatHistory.slice(-4).map(m => m.content).join(' | ');
  const ideaText = recentContext || transcript;
  
  const { error } = await db.from('Ideas').insert([{
    thread_id: currentThread.id,
    idea_text: ideaText
  }]);
  
  if (error) {
    addMessage('assistant', 'Error saving idea: ' + error.message);
  } else {
    addMessage('assistant', 'Banked. I saved that idea from our conversation.');
  }
}

async function switchToProject(name) {
  const result = await db.from('Threads').select('*');
  if (!result.data) return;
  const match = result.data.find(t => 
    t['Thread name'].toLowerCase().includes(name)
  );
  if (match) {
    openThread(match.id);
  } else {
    addMessage('assistant', `I couldn't find a project called "${name}". Check the dashboard for your project names.`);
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
  
  if (!name || !goal) {
    alert('Thread name and goal are required.');
    return;
  }

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
  
  if (error) {
    alert('Error saving thread: ' + error.message);
    return;
  }

  ['nt-name','nt-goal','nt-progress','nt-nextstep','nt-decisions','nt-questions','nt-notes'].forEach(id => {
    document.getElementById(id).value = '';
  });

  closeNewThreadForm();
  loadThreads();
}

const micBtn = document.getElementById('mic-btn');

if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = function(event) {
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        final += event.results[i][0].transcript;
      } else {
        interim += event.results[i][0].transcript;
      }
    }
    const textarea = document.getElementById('chat-input');
    textarea.value = final || interim;
    textarea.scrollTop = textarea.scrollHeight;
    
    if (final) {
      const transcript = final.toLowerCase().trim();
      textarea.value = '';
      
      if (transcript.startsWith('project ')) {
        const projectName = transcript.replace('project ', '').trim();
        switchToProject(projectName);
      } else if (transcript.includes('new thread') || transcript.includes('add thread')) {
        openNewThreadForm();
      } else if (transcript.includes('bank that') || transcript.includes('save that') || transcript.includes('save this idea') || transcript.includes('remember that') || transcript.includes('hold that')) {
        saveIdea(transcript);
      } else {
        textarea.value = final.trim();
        sendMessage();
      }
    }
  };

  recognition.onerror = function() {
    isListening = false;
    micBtn.textContent = '🎤';
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
      audioEnabled = true;
      isListening = true;
      micBtn.textContent = '🔴';
      const utterance = new SpeechSynthesisUtterance('Jarvis listening.');
      window.speechSynthesis.speak(utterance);
      recognition.start();
    } else if (isListening) {
      isListening = false;
      recognition.stop();
      micBtn.textContent = '🎤';
    } else {
      isListening = true;
      micBtn.textContent = '🔴';
      recognition.start();
    }
  });

} else {
  micBtn.style.opacity = '0.3';
}

document.getElementById('send-btn').addEventListener('click', sendMessage);
document.getElementById('chat-input').addEventListener('keypress', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
document.getElementById('new-thread-btn').addEventListener('click', openNewThreadForm);

loadThreads();
