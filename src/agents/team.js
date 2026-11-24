// Names of the AIs on the team, and the "🤝 Claude + Codex + Gemini" line shown in approval previews
// when more than one AI worked on a plan, poster or video (see teamwork() in runner.js).
export const AI_NAMES = { anthropic: 'Claude', openai: 'Codex', google: 'Gemini', mock: 'Mock' };
export const aiName = p => AI_NAMES[p] || p;
export const teamLine = res => (res?.team?.length > 1 ? `🤝 ${res.team.map(t => aiName(t.provider)).join(' + ')}` : '');
