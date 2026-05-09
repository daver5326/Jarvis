const SUPABASE_URL = 'https://jbsocnomwxodqyhiukcl.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impic29jbm9td3hvZHF5aGl1a2NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyNjQ5NTUsImV4cCI6MjA5Mzg0MDk1NX0.ehX6AEqpSpVAF9Q3UxIabZXdZKLDqKKP9KL3pDIPhHE';

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

async function loadThreads() {
  try {
    const result = await db.from('Threads').select('*');
    if (result.data && result.data.length > 0) {
      const html = result.data.map(thread => `
        <div class="thread-card">
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

document.getElementById('new-thread-btn').onclick = function() {
  alert('New thread form coming soon.');
};

loadThreads();
