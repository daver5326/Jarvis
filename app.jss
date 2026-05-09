const SUPABASE_URL = 'https://jbsocnomwxodqyhiukcl.supabase.co';
const SUPABASE_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impic29jbm9td3hvZHF5aGl1a2NsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyNjQ5NTUsImV4cCI6MjA5Mzg0MDk1NX0.ehX6AEqpSpVAF9Q3UxIabZXdZKLDqKKP9KL3pDIPhHE'

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_KEY);

async function loadThreads() {
  try {
    const result = await db.from('Threads').select('*');
    console.log('result:', JSON.stringify(result));
    if (result.data && result.data.length > 0) {
      document.getElementById('thread-list').innerHTML = 
        '<p>' + result.data[0].thread_name + '</p>';
    } else {
      document.getElementById('thread-list').innerHTML = 
        '<p>No data: ' + JSON.stringify(result) + '</p>';
    }
  } catch(e) {
    document.getElementById('thread-list').innerHTML = 
      '<p>Exception: ' + e.message + '</p>';
  }
}

loadThreads();
