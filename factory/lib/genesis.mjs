// Founding of the organisation. Team leads draft charters, review each other, revise,
// and the chief of staff synthesises the operating model. Every decision becomes an ADR.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { p } from './config.mjs';
import { runAgent, DECISION } from './worker.mjs';
import { decide, learn, record, saveThread } from './memory.mjs';

const CHARTER = {
  type: 'object',
  properties: {
    charter_markdown: { type: 'string' },
    decisions: { type: 'array', items: DECISION },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['charter_markdown', 'decisions'],
};
const REVIEW = {
  type: 'object',
  properties: {
    feedback: {
      type: 'array',
      items: { type: 'object', properties: { team: { type: 'string' }, issue: { type: 'string' }, proposal: { type: 'string' } }, required: ['team', 'issue', 'proposal'] },
    },
  },
  required: ['feedback'],
};
const OPMODEL = {
  type: 'object',
  properties: {
    operating_model_markdown: { type: 'string' },
    decisions: { type: 'array', items: DECISION },
    org_yaml_proposals: { type: 'string', description: 'Suggested changes to org/org.yaml (headcount, gates, stages) with reasons. The governance council decides them.' },
    learnings: { type: 'array', items: { type: 'string' } },
  },
  required: ['operating_model_markdown', 'decisions', 'org_yaml_proposals'],
};

const orgContext = (cfg) =>
  `## The organisation (org/org.yaml)\n\`\`\`yaml\n${readFileSync(p('org/org.yaml'), 'utf8')}\n\`\`\`\n` +
  `The product (${cfg.product.name}) spans these repos: ${cfg.product.repos.map((r) => `${r.name}=${r.repo}`).join(', ')}.\n` +
  `Your roles' definitions are in .claude/agents/. Read the ones on your team.\n` +
  (existsSync(p('memory/product/overview.md'))
    ? `\n## The product you are founding this org around (from discovery)\n${readFileSync(p('memory/product/overview.md'), 'utf8')}\n\n## Product owner's answers\n${existsSync(p('memory/product/answers.md')) ? readFileSync(p('memory/product/answers.md'), 'utf8') : '(none)'}\n` +
      `Per-repo docs: ${p('memory/product/repos')}. Tailor the charter to THIS product's stack, domain, risks and AWS setup, not a generic one.\n`
    : '\n(No product discovery yet. Run `sf discover` first for a product-specific org.)\n');

const charterPath = (team) => p('org/charters', `${team}.md`);
const readCharters = (cfg) => Object.keys(cfg.teams).filter((t) => existsSync(charterPath(t)))
  .map((t) => `\n---\n# Charter: ${t}\n${readFileSync(charterPath(t), 'utf8')}`).join('\n');

function keep(results, kind, cfg) {
  for (const { team, lead, r } of results) {
    if (!r.ok) { console.error(`  ✗ ${team}: ${r.error}`); continue; }
    for (const d of r.out.decisions ?? []) decide(d, { actor: lead, scope: `org/${team}` });
    for (const l of r.out.learnings ?? []) learn(l, { actor: lead });
    console.log(`  ✓ ${team} (${kind}, $${r.cost.toFixed(2)})`);
  }
}

export async function genesis(cfg, { only } = {}) {
  mkdirSync(p('org/charters'), { recursive: true });
  const teams = Object.entries(cfg.teams).filter(([t]) => !only || only.includes(t) || t === 'office');
  const work = teams.filter(([t]) => t !== 'office');
  record('genesis_started', { teams: teams.map(([t]) => t) });

  console.log('Round 1: each team lead drafts its charter');
  const r1 = await Promise.all(work.map(async ([team, t]) => ({ team, lead: t.lead, r: await runAgent({
    cfg, role: t.lead, label: `genesis-charter-${team}`, schema: CHARTER,
    prompt: `# Genesis: found the ${team} team\nYou lead the ${team} team (roles: ${t.roles.join(', ')}).\n${orgContext(cfg)}\n` +
      `Write the team charter as the best FAANG team in your domain would run it. Include:\n` +
      `1. Mission and scope, and what you explicitly do NOT own.\n2. Each role's responsibilities, and the pipeline stages you own.\n` +
      `3. For every stage you own: inputs (Definition of Ready), outputs and artifact template (Definition of Done), and the quality bar.\n` +
      `4. Standards and practices (cite the real-world practice, e.g. Google design docs, Amazon PR/FAQ, STRIDE, SRE error budgets).\n` +
      `5. When you loop work back, and to whom. What you need from each upstream team.\n6. Your team's metrics and SLAs per priority.\n` +
      `7. Decision rights. What your roles decide alone, when you call a council, and what you need from a vendor (only what agents can't do).\n` +
      `People: roles listed under \`people\` in org.yaml are performed by those people. Everything else is decided by agents, never by asking a person.\nRecord each foundational choice as a decision.`,
  }) })));
  for (const x of r1) if (x.r.ok) writeFileSync(charterPath(x.team), x.r.out.charter_markdown);
  keep(r1, 'charter', cfg);

  console.log('Round 2: every lead reviews every other charter for gaps and handoff conflicts');
  const r2 = await Promise.all(work.map(async ([team, t]) => ({ team, lead: t.lead, r: await runAgent({
    cfg, role: t.lead, label: `genesis-review-${team}`, schema: REVIEW,
    prompt: `# Genesis review\nYou lead ${team}. Here are all the draft charters:\n${readCharters(cfg)}\n\n` +
      `Review the OTHER teams' charters from your team's point of view. Look for handoff mismatches (what they output and what you need), ` +
      `gaps nobody owns, duplicated ownership, and quality bars that conflict. Be specific, and propose the fix.`,
  }) })));
  const feedback = r2.flatMap((x) => (x.r.out?.feedback ?? []).map((f) => ({ ...f, from: x.team })));
  saveThread('genesis/round-2-reviews', '# Genesis: cross-team charter reviews\n\n' +
    feedback.map((f) => `- **${f.from} → ${f.team}:** ${f.issue}\n  - _Proposal:_ ${f.proposal}`).join('\n'));
  console.log(`  ${feedback.length} pieces of feedback`);

  console.log('Round 3: leads revise their charters');
  const r3 = await Promise.all(work.map(async ([team, t]) => {
    const mine = feedback.filter((f) => f.team.toLowerCase().includes(team));
    return { team, lead: t.lead, r: await runAgent({
      cfg, role: t.lead, label: `genesis-revise-${team}`, schema: CHARTER,
      prompt: `# Genesis revision\nYou lead ${team}. Your current charter:\n${readFileSync(charterPath(team), 'utf8')}\n\n` +
        `Feedback from other teams:\n${mine.map((f) => `- from ${f.from}: ${f.issue}. Proposal: ${f.proposal}`).join('\n') || '(none)'}\n\n` +
        `Revise the charter. Accept the feedback, or reject it with a reason. Record each acceptance or rejection as a decision. Return the full revised charter.`,
    }) };
  }));
  for (const x of r3) if (x.r.ok) writeFileSync(charterPath(x.team), x.r.out.charter_markdown);
  keep(r3, 'revision', cfg);

  console.log('Round 4: chief of staff writes the operating model');
  const cos = cfg.teams.office?.lead ?? 'chief-of-staff';
  const r4 = await runAgent({
    cfg, role: cos, label: 'genesis-operating-model', schema: OPMODEL,
    prompt: `# Genesis: operating model\n${orgContext(cfg)}\n## Final team charters\n${readCharters(cfg)}\n\n` +
      `## Cross-team feedback\n${feedback.map((f) => `- ${f.from} → ${f.team}: ${f.issue}`).join('\n')}\n\n` +
      `Write org/operating-model.md, the single source of truth every agent reads before acting. Include:\n` +
      `- A RACI table per pipeline stage.\n- The handoff contract per stage: Definition of Ready, Definition of Done, and the required artifact sections.\n` +
      `- The loop-back protocol (which defect goes back to which stage, and what the receiving agent gets).\n` +
      `- Decision rights: what an agent decides alone, what needs a council, and what needs a human.\n` +
      `- SLAs per priority. Org metrics: DORA, loop-back rate, cost per issue, with targets.\n` +
      `- How the org changes itself: how the audit, ADR, proposal, and human approval cycle works.\n` +
      `Resolve any remaining conflicts between charters and record each resolution as a decision.`,
  });
  if (r4.ok) {
    writeFileSync(p('org/operating-model.md'), r4.out.operating_model_markdown);
    writeFileSync(p('org/proposals', `genesis-org-yaml.md`), `# Proposed org.yaml changes (from genesis)\n\n${r4.out.org_yaml_proposals}\n`);
  }
  keep([{ team: 'office', lead: cos, r: r4 }], 'operating model', cfg);

  const cost = [...r1, ...r2, ...r3].reduce((s, x) => s + x.r.cost, r4.cost);
  record('genesis_finished', { cost_usd: cost, ok: r4.ok });
  console.log(`\nGenesis complete, $${cost.toFixed(2)}. Read org/operating-model.md and org/proposals/genesis-org-yaml.md`);
  return r4.ok;
}
