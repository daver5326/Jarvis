async function handleSelfModifyRequest(instruction) {
  const msgContainer = currentView === 'dashboard'
    ? document.getElementById('dashboard-messages')
    : document.getElementById('chat-messages');

  const status = document.createElement('div');
  status.className = 'message assistant';
  status.textContent = 'Reading my own code...';
  msgContainer.appendChild(status);
  msgContainer.scrollTop = 999999;

  try {
    const readRes = await fetch('/api/deploy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'read' })
    });
    const readData = await readRes.json();
    if (!readData.success) throw new Error('Could not read code: ' + readData.error);

    const currentCode = readData.content;
    status.textContent = 'Got it. Thinking through the change...';

    const proposeRes = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: `You are Jarvis's code modification engine. David wants to change app.js.
Return ONLY a JSON object with this structure:
{
  "summary": "One sentence describing the change.",
  "find": "the exact string to find in the current code",
  "replace": "the new string to replace it with"
}
Rules:
- "find" must be an exact unique substring from the current code
- "replace" is what it becomes after the change
- Keep find/replace as short as possible — just the changed portion
- No markdown, no explanation, ONLY the JSON object`,
        messages: [{
          role: 'user',
          content: `Instruction: ${instruction}\n\nCurrent app.js:\n${currentCode}`
        }]
      })
    });

    const proposeData = await proposeRes.json();
    const raw = proposeData.content[0].text.trim().replace(/```json|```/g, '');
    const proposal = JSON.parse(raw);

    if (!currentCode.includes(proposal.find)) {
      throw new Error('Could not locate the code section to change.');
    }

    const updatedCode = currentCode.replace(proposal.find, proposal.replace);

    status.remove();
    showStagedChange(proposal.summary, updatedCode, msgContainer);

  } catch(e) {
    status.textContent = 'Self-modify failed: ' + e.message;
  }
}
