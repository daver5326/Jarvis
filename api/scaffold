export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { repo, files } = req.body;
  if (!repo || !files) return res.status(400).json({ error: 'repo and files required' });

  const token = process.env.GITHUB_TOKEN;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };

  try {
    const results = [];

    for (const file of files) {
      const encoded = Buffer.from(file.content).toString('base64');

      // Check if file already exists (to get sha)
      let sha = null;
      try {
        const checkRes = await fetch(
          `https://api.github.com/repos/${repo}/contents/${file.path}`,
          { headers }
        );
        if (checkRes.ok) {
          const checkData = await checkRes.json();
          sha = checkData.sha;
        }
      } catch(e) {}

      const body = {
        message: `Scaffold: add ${file.path}`,
        content: encoded,
        branch: 'main',
      };
      if (sha) body.sha = sha;

      const writeRes = await fetch(
        `https://api.github.com/repos/${repo}/contents/${file.path}`,
        { method: 'PUT', headers, body: JSON.stringify(body) }
      );

      const writeData = await writeRes.json();
      results.push({
        path: file.path,
        success: writeRes.ok,
        error: writeRes.ok ? null : writeData.message
      });
    }

    return res.status(200).json({ success: true, results });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
