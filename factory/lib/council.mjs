// Multi-agent discussion. Members speak in rounds and see each other's positions. Then the chair decides.
import { runAgent, verdictSchema } from './worker.mjs';
import { saveThread, record } from './memory.mjs';

const POSITION = {
  type: 'object',
  properties: {
    position: { type: 'string', description: 'Your analysis from your domain, with evidence.' },
    proposal: { type: 'string', description: 'What you think the org should do.' },
    concerns: { type: 'array', items: { type: 'string' } },
    recommended_next: { type: 'string' },
    agree_with: { type: 'array', items: { type: 'string' }, description: 'Roles whose proposal you now support.' },
  },
  required: ['position', 'proposal', 'concerns'],
};

export async function council({ cfg, name, topic, context, chair, members, rounds = 2, nextOptions, issue = null, cwd, extraSchema = {} }) {
  const transcript = [];
  const render = () => transcript.map((t) =>
    `### Round ${t.round}: ${t.role}\n**Position:** ${t.position}\n\n**Proposal:** ${t.proposal}\n\n` +
    (t.concerns?.length ? `**Concerns:**\n${t.concerns.map((c) => `- ${c}`).join('\n')}\n` : '') +
    (t.recommended_next ? `\n**Recommends:** ${t.recommended_next}\n` : '')).join('\n');

  record('council_opened', { name, topic, chair, members }, { issue });
  for (let round = 1; members.length && round <= rounds; round++) {
    const results = await Promise.all(members.map((role) => runAgent({
      cfg, role, cwd, issue, label: `council-${role}`, schema: nextOptions ? { ...POSITION, properties: { ...POSITION.properties, recommended_next: { enum: nextOptions } } } : POSITION,
      prompt: `# Council: ${topic}\nYou are the ${role} on this council. Chair: ${chair}.\n` +
        (cwd ? `To check evidence yourself, run read-only git commands directly in your working directory (${cwd}): git log, git diff, git show, git status, git branch -r. Don't use git -C or cd; those forms are denied.\n` : '') +
        `\n## Context\n${context}\n\n` +
        (transcript.length ? `## Discussion so far\n${render()}\n\nThis is round ${round}. Respond to the others. Converge where you can, and hold firm where your domain requires it.\n`
          : 'This is round 1. Give your independent position from your domain.\n') +
        (nextOptions ? `\nThe routes the council can choose: ${nextOptions.join(', ')}.\n` : ''),
    })));
    results.forEach((r, i) => transcript.push({ round, role: members[i], ...(r.out ?? { position: `(no response: ${r.error})`, proposal: '', concerns: [] }) }));
    // Another round only while members disagree on the route; once they agree, more rounds just restate it.
    const routes = new Set(transcript.filter((t) => t.round === round).map((t) => String(t.recommended_next ?? '').trim().toLowerCase()));
    const agreed = routes.size === 1 ? [...routes][0] : '';
    if (nextOptions && agreed && round < rounds) { record('council_converged', { name, round, route: agreed }, { issue }); break; }
  }

  const decision = await runAgent({
    cfg, role: chair, cwd, issue, label: `council-chair`,
    schema: nextOptions ? verdictSchema(nextOptions, extraSchema) : { type: 'object', properties: { summary: { type: 'string' }, ...extraSchema }, required: ['summary'] },
    prompt: members.length
      ? `# Council decision: ${topic}\nYou chair this council. Weigh every member's position and decide.\n` +
        `Record the decision, the dissent, and why you overruled any member in \`decisions\`.\n\n## Context\n${context}\n\n## Discussion\n${render()}`
      // A lean council: the role that asked has already given its account (in the context); re-running it as a member repeats it.
      : `# Decision: ${topic}\nYou decide this alone, as ${chair}, from the account in the context. Check the evidence it cites ` +
        `before you rely on it. Record the decision and why in \`decisions\`. If it truly needs a person, choose \`blocked\`.\n\n## Context\n${context}`,
  });
  const thread = saveThread(name, `# Council: ${topic}\nChair: ${chair} · Members: ${members.join(', ')}\n\n${render()}\n\n## Chair decision\n${decision.out?.summary ?? decision.error}\n`);
  record('council_closed', { name, thread, outcome: decision.out?.outcome, to: decision.out?.next_stage }, { actor: chair, issue });
  return { ...decision, thread, transcript };
}
