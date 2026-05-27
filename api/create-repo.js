export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Repo name required' });

  const token = process.env.GITHUB_TOKEN;

  try {
    const createRes = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name,
        description: description || '',
        private: false,
        auto_init: true,
      })
    });

    const data = await createRes.json();

    if (!createRes.ok) {
      return res.status(400).json({ error: data.message || 'Failed to create repo' });
    }

    return res.status(200).json({
      success: true,
      repo: data.full_name,
      url: data.html_url,
      clone_url: data.clone_url
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
