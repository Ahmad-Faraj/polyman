/**
 * Checks a Duo flow file the way GitLab does when you save it, so a broken
 * flow is caught in the MR instead of in the UI:
 *   - the JSON schema GitLab validates against (schemas/flow_v2.json, copied
 *     from gitlab-org/gitlab app/validators/json_schemas/ai_catalog/flow_v2.json)
 *   - the prompt safety checks from the Duo Workflow Service (no HTML comments,
 *     hidden markdown comments, reserved tags or invisible unicode)
 *   - every {{variable}} a prompt uses is an input of the component using it
 *   - every tool in a toolset is a tool the Duo Workflow Service knows about
 */
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import { parse } from 'yaml';

const schema = JSON.parse(readFileSync(new URL('../schemas/flow_v2.json', import.meta.url), 'utf8'));
const validateSchema = new Ajv({ allErrors: true, strict: false }).compile(schema);

// Tool names from the Duo Workflow Service (duo_workflow_service/tools in
// gitlab-org/modelops/applied-ml/code-suggestions/ai-assist). GitLab saves a
// flow with a misspelled tool without complaint, so check it here.
export const KNOWN_TOOLS = new Set([
  'add_merge_request_reviewers', 'confirm_vulnerability', 'create_branch', 'create_commit',
  'create_file_with_contents', 'create_issue', 'create_issue_note', 'create_merge_request',
  'create_merge_request_diff_note', 'create_merge_request_note', 'create_vulnerability_issue',
  'dismiss_vulnerability', 'edit_file', 'find_files', 'get_commit', 'get_commit_comments',
  'get_commit_diff', 'get_downstream_pipelines', 'get_failing_bridge_jobs', 'get_issue',
  'get_issue_note', 'get_job_logs', 'get_merge_request', 'get_pipeline_failing_jobs', 'get_project',
  'get_repository_file', 'get_repository_files', 'get_security_finding_details', 'gitlab_api_get',
  'gitlab_graphql', 'gitlab_merge_request_search', 'link_vulnerability_to_issue',
  'link_vulnerability_to_merge_request', 'list_all_merge_request_notes', 'list_commits', 'list_dir',
  'list_group_audit_events', 'list_instance_audit_events', 'list_issue_notes', 'list_issues',
  'list_merge_request_diffs', 'list_mr_discussions', 'list_project_audit_events',
  'list_repository_tree', 'list_security_findings', 'list_vulnerabilities', 'mkdir',
  'post_suggested_reviewers', 'read_file', 'read_files', 'reply_to_discussion',
  'revert_to_detected_vulnerability', 'run_command', 'run_git_command', 'run_tests',
  'set_discussion_resolved', 'start_flow', 'update_issue', 'update_merge_request',
]);

const RESERVED_TAGS = ['goal', 'system', 'truncated_tool_output', 'truncation_notice'];
const PROMPT_ROLES = ['system', 'user'];

interface Component {
  name: string;
  prompt_id?: string;
  toolset?: (string | Record<string, unknown>)[];
  inputs?: (string | { from: string; as: string })[];
}

interface Prompt {
  prompt_id: string;
  prompt_template: Record<string, string>;
}

export function promptProblems(text: string): string[] {
  const problems: string[] = [];
  if (/<!--|<!\[CDATA\[|<\?/.test(text)) problems.push('contains an HTML comment, CDATA or processing instruction');
  for (const tag of RESERVED_TAGS) {
    if (new RegExp(`<\\s*/?\\s*${tag}\\s*>`, 'i').test(text)) problems.push(`contains the reserved tag <${tag}>`);
  }
  if (/(^|\n)\s*\[(?:\/\/|comment)\]:\s*(?:<[^>]*>|#|\S*)\s*\((?:[^)\\]|\\.)*\)/i.test(text)) {
    problems.push('contains a hidden markdown comment');
  }
  if ([...text].some((c) => (c.codePointAt(0)! >= 0xe0000 && c.codePointAt(0)! <= 0xe007f) || (c.codePointAt(0)! >= 0xe0100 && c.codePointAt(0)! <= 0xe01ef))) {
    problems.push('contains invisible unicode tag characters');
  }
  return problems;
}

export function checkFlow(source: string): string[] {
  const flow = parse(source);
  const problems: string[] = [];

  // GitLab stores the raw YAML alongside the parsed config
  if (!validateSchema({ ...flow, yaml_definition: source })) {
    for (const e of validateSchema.errors ?? []) problems.push(`schema: ${e.instancePath || '/'} ${e.message}`);
  }

  const prompts = new Map<string, Prompt>((flow.prompts ?? []).map((p: Prompt) => [p.prompt_id, p]));
  for (const c of (flow.components ?? []) as Component[]) {
    for (const t of c.toolset ?? []) {
      const name = typeof t === 'string' ? t : Object.keys(t)[0];
      if (!KNOWN_TOOLS.has(name)) problems.push(`component ${c.name}: unknown tool "${name}"`);
    }
    const prompt = c.prompt_id ? prompts.get(c.prompt_id) : undefined;
    if (!prompt) continue;
    const inputs = new Set(
      (c.inputs ?? ['context:goal']).map((i) => (typeof i === 'string' ? i.split(':').pop()!.split('.').pop()! : i.as)),
    );
    for (const role of PROMPT_ROLES) {
      const text = prompt.prompt_template[role];
      if (typeof text !== 'string') continue;
      for (const p of promptProblems(text)) problems.push(`prompt ${prompt.prompt_id} (${role}): ${p}`);
      for (const [, name] of text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
        if (!inputs.has(name)) problems.push(`component ${c.name}: prompt uses {{${name}}} but it isn't one of its inputs`);
      }
    }
  }
  return problems;
}
