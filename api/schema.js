import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, table, columns } = req.body;
  if (!action || !table) return res.status(400).json({ error: 'action and table required' });

  try {
    if (action === 'create') {
      const colDefs = columns.map(c => `${c.name} ${c.type}`).join(', ');
      const sql = `CREATE TABLE IF NOT EXISTS "${table}" (id bigint generated always as identity primary key, ${colDefs}, created_at timestamptz default now())`;
      const { error } = await supabase.rpc('exec_sql', { sql });
      if (error) throw error;
      return res.status(200).json({ success: true, action: 'created', table });
    }

    if (action === 'add_column') {
      const { name, type } = columns[0];
      const sql = `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS ${name} ${type}`;
      const { error } = await supabase.rpc('exec_sql', { sql });
      if (error) throw error;
      return res.status(200).json({ success: true, action: 'column_added', table, column: name });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
