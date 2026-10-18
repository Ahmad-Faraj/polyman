/**
 * Tiny GitLab REST client for CI jobs. Uses only the Node standard library.
 *
 * It authenticates with the job's own CI_JOB_TOKEN, which can read merge
 * requests and notes and manage releases, deployments and environments.
 * The engine never writes to merge requests: the Duo agents do that under
 * their own service accounts. AUTONOMY_BOT_TOKEN is only used if a project
 * sets it on purpose.
 */
export class GitLab {
  readonly baseUrl: string;
  readonly projectId: string;
  private readonly auth: Record<string, string>;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.baseUrl = required(env, 'CI_API_V4_URL');
    this.projectId = encodeURIComponent(required(env, 'CI_PROJECT_ID'));
    this.auth = env.AUTONOMY_BOT_TOKEN
      ? { 'PRIVATE-TOKEN': env.AUTONOMY_BOT_TOKEN }
      : env.CI_JOB_TOKEN
        ? { 'JOB-TOKEN': env.CI_JOB_TOKEN }
        : {};
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path.replace(':project', `projects/${this.projectId}`)}`;
    // a redirect would carry the token to another host: refuse it
    const res = await fetch(url, {
      redirect: 'error',
      method,
      headers: { ...this.auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // The job token only covers part of the API. Reads it can't do are public
    // on a public project, so retry those without credentials.
    if ((res.status === 401 || res.status === 403) && method === 'GET' && Object.keys(this.auth).length) {
      const refused = await res.text();
      const anon = await fetch(url);
      if (anon.ok) {
        // public data only: confidential notes and restricted fields are missing
        console.warn(`warning: ${path} isn't readable with the job token; used the public API instead`);
        return parseBody<T>(method, path, anon.status, await anon.text());
      }
      throw new GitLabError(method, path, res.status, refused);
    }
    const text = await res.text();
    if (!res.ok) throw new GitLabError(method, path, res.status, text);
    return parseBody<T>(method, path, res.status, text);
  }

  get<T = unknown>(path: string) {
    return this.request<T>('GET', path);
  }
  post<T = unknown>(path: string, body?: unknown) {
    return this.request<T>('POST', path, body);
  }
  put<T = unknown>(path: string, body?: unknown) {
    return this.request<T>('PUT', path, body);
  }
}

export interface PipelineJob {
  name: string;
  status: string;
  duration: number | null;
}

/** Finished jobs (with a runner duration) across the given pipelines. */
export async function finishedJobs(gl: GitLab, pipelineIds: number[]) {
  const jobs: { name: string; duration: number }[] = [];
  for (const id of pipelineIds) {
    const page = await gl.get<PipelineJob[]>(`/:project/pipelines/${id}/jobs?per_page=100&include_retried=true`);
    for (const j of page) if (j.duration) jobs.push({ name: j.name, duration: j.duration });
  }
  return jobs;
}

function parseBody<T>(method: string, path: string, status: number, text: string): T {
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GitLabError(method, path, status, `expected JSON, got: ${text.slice(0, 100)}`);
  }
}

export class GitLabError extends Error {
  readonly status: number;
  constructor(method: string, path: string, status: number, body: string) {
    super(`${method} ${path} -> ${status}: ${body.slice(0, 300)}`);
    this.status = status;
  }
}

export function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}
