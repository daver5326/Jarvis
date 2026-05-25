export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, table, columns } = req.body;
  if (!action || !table) return res.status(400).json({ error: 'action and table required' });

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;

  try {
    let sql = '';

    if (action === 'create') {
      const colDefs = columns.map(c => `${c.name} ${c.type}`).join(', ');
      sql = `CREATE TABLE IF NOT EXISTS "${table}" (id bigint generated always as identity primary key, ${colDefs}, created_at timestamptz default now())`;
    } else if (action === 'add_column') {
      const { name, type } = columns[0];
      sql = `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS ${name} ${type}`;
    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }

    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': serviceKey,
        'Authorization': `Bearer ${serviceKey}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ sql })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(errText);
    }

    res.status(200).json({ success: true, action, table });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}
