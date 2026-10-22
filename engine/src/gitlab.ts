import { tokenFetch } from './project.ts';

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
    const init = {
      method,
      headers: { ...this.auth, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    // a read is sent again after a server error or a dropped connection; a write never is
    const send = () => (method === 'GET' ? readRetrying(() => tokenFetch(url, init)) : tokenFetch(url, init));
    let res = await send();
    // GitLab.com limits requests per minute (per IP address without a token):
    // a 429 was not served, so wait as long as it asks and send it again
    for (let tries = 1; res.status === 429 && tries <= RATE_LIMIT_RETRIES; tries++) {
      await backOff(res);
      res = await send();
    }
    // The job token only covers part of the API. Reads it can't do are public
    // on a public project, so retry those without credentials.
    if ((res.status === 401 || res.status === 403) && method === 'GET' && Object.keys(this.auth).length) {
      const refused = await res.text();
      let anon = await readRetrying(() => fetch(url));
      for (let tries = 1; anon.status === 429 && tries <= RATE_LIMIT_RETRIES; tries++) {
        await backOff(anon);
        anon = await readRetrying(() => fetch(url));
      }
      if (anon.ok) {
        // public data only: confidential notes and restricted fields are missing
        console.warn(`warning: ${path} isn't readable with the job token; used the public API instead`);
        return parseBody<T>(method, path, anon.status, await anon.text());
      }
      // still limited: say that, not that the token was refused
      if (anon.status === 429) throw new GitLabError(method, path, 429, await anon.text());
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
  id: number;
  name: string;
  status: string;
  duration: number | null;
}

/** Every job of one pipeline, retried ones included, every page of them. */
export async function pipelineJobs(gl: Pick<GitLab, 'get'>, pipelineId: number) {
  const jobs: PipelineJob[] = [];
  for (let n = 1; ; n++) {
    const path = `/:project/pipelines/${pipelineId}/jobs?per_page=100&include_retried=true&page=${n}`;
    const page = await gl.get<PipelineJob[]>(path);
    if (!Array.isArray(page)) throw new Error(`GET ${path} did not return a list: ${JSON.stringify(page).slice(0, 100)}`);
    jobs.push(...page);
    if (page.length < 100) break;
  }
  return jobs;
}

/** Finished jobs (with a runner duration) across the given pipelines, every page of them. */
export async function finishedJobs(gl: Pick<GitLab, 'get'>, pipelineIds: number[]) {
  const jobs: { name: string; duration: number }[] = [];
  for (const id of pipelineIds) for (const j of await pipelineJobs(gl, id)) if (j.duration) jobs.push({ name: j.name, duration: j.duration });
  return jobs;
}

export const RATE_LIMIT_RETRIES = 3;

/**
 * How often a read is tried again after a server error, and the wait before
 * try n (n × ms). GITLAB_RETRY_MS overrides the wait (tests set 0).
 */
export const SERVER_RETRIES = { times: 3, ms: 5_000 };

const retryStepMs = () => {
  const set = process.env.GITLAB_RETRY_MS;
  return set === undefined || set === '' ? SERVER_RETRIES.ms : Number(set);
};

/**
 * A read, sent again when GitLab answers 5xx or the connection drops (#98: a
 * 500 on an old job's artifact, then "fetch failed", each turned main red).
 * Reads only: a write that failed halfway may still have happened, so it is
 * never sent twice. After the last try the 5xx or the error goes to the caller.
 */
export async function readRetrying(send: () => Promise<Response>): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const last = attempt > SERVER_RETRIES.times;
    try {
      const res = await send();
      if (res.status < 500 || last) return res;
      await res.body?.cancel();
      console.warn(`warning: GitLab answered ${res.status}; trying again (${attempt} of ${SERVER_RETRIES.times})`);
    } catch (err) {
      if (last) throw err;
      console.warn(`warning: ${(err as Error).message}; trying again (${attempt} of ${SERVER_RETRIES.times})`);
    }
    await new Promise((done) => setTimeout(done, attempt * retryStepMs()));
  }
}

/** Waits as long as a 429 answer's Retry-After asks (10 s if it doesn't say, at most a minute). */
export async function backOff(res: Response) {
  await res.body?.cancel();
  const asked = Number(res.headers.get('retry-after') ?? NaN);
  const seconds = Math.min(Number.isFinite(asked) && asked >= 0 ? asked : 10, 60);
  console.warn(`warning: GitLab's rate limit; trying again in ${seconds} s`);
  await new Promise((done) => setTimeout(done, seconds * 1000));
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
