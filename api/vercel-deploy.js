export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { repo, projectName } = req.body;
  if (!repo || !projectName) return res.status(400).json({ error: 'repo and projectName required' });

  const token = process.env.VERCEL_TOKEN;

  try {
    const response = await fetch('https://api.vercel.com/v1/projects', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: projectName,
        gitRepository: {
          type: 'github',
          repo: repo,
        },
        framework: null,
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(400).json({ error: data.error?.message || 'Vercel deploy failed' });
    }

    return res.status(200).json({
      success: true,
      projectId: data.id,
      url: `https://${data.name}.vercel.app`
    });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
