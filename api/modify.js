export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { file, startLine, endLine, replacement, sha } = req.body;

  if (!file || startLine == null || endLine == null || !replacement || !sha) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const fileRes = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${file}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!fileRes.ok) throw new Error(`GitHub fetch failed: ${fileRes.status}`);
    const fileData = await fileRes.json();

    const currentContent = Buffer.from(fileData.content, 'base64').toString('utf8');
    const lines = currentContent.split('\n');

    if (startLine < 1 || endLine > lines.length || startLine > endLine) {
      return res.status(400).json({
        error: `Invalid line range: ${startLine}-${endLine} (file has ${lines.length} lines)`
      });
    }

    const replacementLines = replacement.split('\n');
    const patched = [
      ...lines.slice(0, startLine - 1),
      ...replacementLines,
      ...lines.slice(endLine),
    ];

    const newContent = patched.join('\n');
    const encoded = Buffer.from(newContent).toString('base64');

    const writeRes = await fetch(
      `https://api.github.com/repos/${process.env.GITHUB_REPO}/contents/${file}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: `Self-modify: patch ${file} lines ${startLine}-${endLine}`,
          content: encoded,
          sha: fileData.sha,
          branch: process.env.GITHUB_BRANCH || 'main',
        }),
      }
    );

    if (!writeRes.ok) {
      const err = await writeRes.json();
      throw new Error(err.message || 'GitHub write failed');
    }

    const writeData = await writeRes.json();
    res.status(200).json({
      success: true,
      sha: writeData.content.sha,
      linesChanged: endLine - startLine + 1,
      linesNew: replacementLines.length
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
