// api/deploy.js
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, content, commitMessage } = req.body;
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || 'main';
  const filePath = 'app.js';
  const apiBase = `https://api.github.com/repos/${repo}/contents/${filePath}`;

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json'
  };

  try {

    // ── READ ──────────────────────────────────────────────────────────────────
    if (action === 'read') {
      const r = await fetch(`${apiBase}?ref=${branch}`, { headers });
      const data = await r.json();
      if (data.message) return res.status(404).json({ error: data.message });
      const decoded = Buffer.from(data.content, 'base64').toString('utf8');
      return res.status(200).json({ success: true, content: decoded, sha: data.sha });
    }

    // ── WRITE ─────────────────────────────────────────────────────────────────
    if (action === 'write') {
      if (!content) return res.status(400).json({ error: 'content required' });

      // Get current SHA first (required by GitHub API to update a file)
      const readRes = await fetch(`${apiBase}?ref=${branch}`, { headers });
      const readData = await readRes.json();
      if (readData.message) return res.status(404).json({ error: readData.message });
      const currentSha = readData.sha;

      const encoded = Buffer.from(content, 'utf8').toString('base64');
      const writeRes = await fetch(apiBase, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message: commitMessage || 'Jarvis self-update',
          content: encoded,
          sha: currentSha,
          branch
        })
      });
      const writeData = await writeRes.json();
      if (writeData.message && !writeData.commit) return res.status(500).json({ error: writeData.message });
      return res.status(200).json({ success: true, commit: writeData.commit?.sha });
    }

    // ── ROLLBACK ──────────────────────────────────────────────────────────────
    if (action === 'rollback') {
      // Get the last 2 commits on this file
      const logRes = await fetch(
        `https://api.github.com/repos/${repo}/commits?path=${filePath}&per_page=2&sha=${branch}`,
        { headers }
      );
      const commits = await logRes.json();
      if (!commits[1]) return res.status(400).json({ error: 'No previous commit to roll back to' });

      const prevSha = commits[1].sha;

      // Get the file content at that commit
      const prevRes = await fetch(`${apiBase}?ref=${prevSha}`, { headers });
      const prevData = await prevRes.json();
      const prevContent = Buffer.from(prevData.content, 'base64').toString('utf8');

      // Get current SHA to overwrite
      const currRes = await fetch(`${apiBase}?ref=${branch}`, { headers });
      const currData = await currRes.json();

      const encoded = Buffer.from(prevContent, 'utf8').toString('base64');
      const revertRes = await fetch(apiBase, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message: 'Jarvis rollback to previous version',
          content: encoded,
          sha: currData.sha,
          branch
        })
      });
      const revertData = await revertRes.json();
      if (revertData.message && !revertData.commit) return res.status(500).json({ error: revertData.message });
      return res.status(200).json({ success: true, commit: revertData.commit?.sha, restoredFrom: prevSha });
    }

    return res.status(400).json({ error: 'Invalid action. Use read, write, or rollback.' });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
