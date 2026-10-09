import type { ResumeStructure } from '../resumes/resume-schema';

/**
 * Plain markdown for reading and copying. Contact details come from the source
 * resume — the model never saw them, so they are put back here by code.
 */
export function renderResumeMarkdown(resume: ResumeStructure): string {
  const lines: string[] = [];

  if (resume.name) lines.push(`# ${resume.name}`);
  if (resume.headline) lines.push(`**${resume.headline}**`);

  const contact = [resume.contacts.email, resume.contacts.phone, ...resume.contacts.links].filter(
    (part): part is string => Boolean(part),
  );
  if (contact.length) lines.push(contact.join(' · '));

  if (resume.summary) lines.push('', '## Summary', resume.summary);

  if (resume.experience.length) {
    lines.push('', '## Experience');
    for (const role of resume.experience) {
      const heading = [role.title, role.company].filter(Boolean).join(' — ');
      const dates = [role.start, role.end ?? 'present'].filter(Boolean).join(' – ');
      lines.push('', `### ${heading}${dates ? ` (${dates})` : ''}`);
      if (role.location) lines.push(role.location);
      for (const highlight of role.highlights) lines.push(`- ${highlight}`);
    }
  }

  if (resume.education.length) {
    lines.push('', '## Education');
    for (const entry of resume.education) {
      const dates = [entry.start, entry.end].filter(Boolean).join(' – ');
      const text = [entry.qualification, entry.institution].filter(Boolean).join(', ');
      lines.push(`- ${text}${dates ? ` (${dates})` : ''}`);
    }
  }

  if (resume.skills.length) lines.push('', '## Skills', resume.skills.join(', '));

  if (resume.languages.length) {
    lines.push(
      '',
      '## Languages',
      resume.languages.map((l) => (l.level ? `${l.language} (${l.level})` : l.language)).join(', '),
    );
  }

  return lines.join('\n') + '\n';
}
