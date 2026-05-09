const SUPABASE_URL = 'https://jbsocnomwxodqyhiukcl.supabase.co';
const SUPABASE_KEY = 'sb_publishable_SPl4Kyi2h-EcGRayoeopTA_hAYrGOjs';

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
