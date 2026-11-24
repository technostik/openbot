export interface LocalSkill {
    /** Skill name as the model invokes it. */
    name: string;
    description?: string;
    /** Absolute path of the SKILL.md file. */
    path: string;
    content: string;
}
/** Minimal frontmatter reader: only `name:` and `description:` are needed. */
export declare function parseSkillFile(file: string, raw: string): LocalSkill | undefined;
/** Skills that ship inside a bot: `<botdir>/skills/<id>/SKILL.md`. */
export declare function loadLocalSkills(skillsDir: string): LocalSkill[];
