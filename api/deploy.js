export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { filename, content } = req.body;
  if (!filename || !content) return res.status(400).json({ error: 'filename and content required' });

  const token = process.env.VERCEL_TOKEN;
  const projectId = 'prj_1qKcwy7UhsVzESeuST9CrBbufHGx';

  try {
    // 1. Upload file to Vercel
    const uploadRes = await fetch('https://api.vercel.com/v2/files', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'x-vercel-digest': await sha1(content)
      },
      body: content
    });

    const fileData = await uploadRes.json();

    // 2. Trigger deployment
    const deployRes = await fetch('https://api.vercel.com/v13/deployments', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'jarvis',
        project: projectId,
        files: [{ file: filename, sha: fileData.sha }],
        target: 'production'
      })
    });

    const deployData = await deployRes.json();
    res.status(200).json({ success: true, deployment: deployData.url });

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
}

async function sha1(str) {
  const buffer = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-1', buffer);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2,'0')).join('');
}
