import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * A small YAML reader for the GitHub workflow files, so the CI tests can pin
 * their rules without a YAML dependency (neither js-yaml nor yaml is a direct
 * one). It reads the subset the workflows use: block mappings and sequences,
 * flow sequences of scalars, quoted and plain scalars, `|` and `>` block
 * scalars, and comments. Anything else (anchors, flow mappings, tags) throws,
 * so a workflow that outgrows it fails the tests instead of being misread.
 * Every scalar stays a string: `true` is 'true', `8` is '8'.
 */
export type YamlNode = string | YamlNode[] | { [key: string]: YamlNode };

interface Line {
  no: number;
  indent: number;
  text: string;
}

const KEY =
  /^("[^"]*"|'[^']*'|[^\s"'#[\]{}&*!|>@`-][^:]*?|-[^\s:][^:]*?)\s*:(?:\s+(.*))?$/;

/** The text without a trailing comment (a `#` after a space, outside quotes). */
function stripComment(text: string): string {
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s[,:]/.test(text[i - 1])) quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

function unquote(value: string, no: number): string {
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2)
      throw new Error(`line ${no}: unterminated string ${value}`);
    return JSON.parse(value) as string;
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2)
      throw new Error(`line ${no}: unterminated string ${value}`);
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** Splits `a, 'b, c', d` on the commas outside quotes. */
function splitFlow(inner: string): string[] {
  const items: string[] = [];
  let quote = '';
  let current = '';
  for (const c of inner) {
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === ',') {
      items.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function scalar(raw: string, no: number): YamlNode {
  const value = raw.trim();
  if (/^[&*!]/.test(value) || value.startsWith('{'))
    throw new Error(`line ${no}: unsupported YAML: ${value}`);
  if (value.startsWith('[')) {
    if (!value.endsWith(']'))
      throw new Error(`line ${no}: unterminated flow sequence`);
    return splitFlow(value.slice(1, -1)).map(item => {
      if (/^[[{&*!]/.test(item))
        throw new Error(`line ${no}: unsupported YAML: ${item}`);
      return unquote(item, no);
    });
  }
  return unquote(value, no);
}

export function parseYaml(source: string): YamlNode {
  const raw = source.replace(/\r\n/g, '\n').split('\n');
  const lines: Line[] = raw.map((text, i) => ({
    no: i + 1,
    indent: text.length - text.trimStart().length,
    text: text.trim(),
  }));
  let at = 0;

  const significant = (i: number) =>
    lines[i].text !== '' && !lines[i].text.startsWith('#');
  const skip = () => {
    while (at < lines.length && !significant(at)) at++;
  };
  const isItem = (line: Line) =>
    line.text === '-' || line.text.startsWith('- ');

  function blockScalar(parentIndent: number, style: string): string {
    const body: string[] = [];
    let indent = -1;
    while (at < lines.length) {
      const line = raw[at];
      const blank = line.trim() === '';
      const lineIndent = line.length - line.trimStart().length;
      if (!blank && lineIndent <= parentIndent) break;
      if (!blank && indent < 0) indent = lineIndent;
      body.push(blank ? '' : line.slice(indent));
      at++;
    }
    while (body.length && body[body.length - 1] === '') body.pop();
    const text = style.startsWith('>') ? body.join(' ') : body.join('\n');
    return style.endsWith('-') ? text : `${text}\n`;
  }

  /** The value after `key:` or `- `: inline, a block scalar or a child block. */
  function value(rest: string | undefined, line: Line): YamlNode {
    const inline = stripComment(rest ?? '');
    if (/^[|>][-+]?$/.test(inline)) return blockScalar(line.indent, inline);
    if (inline !== '') return scalar(inline, line.no);
    skip();
    if (at >= lines.length) return '';
    const next = lines[at];
    if (next.indent > line.indent) return block(next.indent);
    // a sequence may sit at its key's own indent
    if (next.indent === line.indent && isItem(next) && !isItem(line))
      return sequence(next.indent);
    return '';
  }

  function mapping(indent: number): { [key: string]: YamlNode } {
    const map: { [key: string]: YamlNode } = {};
    for (skip(); at < lines.length; skip()) {
      const line = lines[at];
      if (line.indent < indent || isItem(line)) break;
      if (line.indent > indent)
        throw new Error(`line ${line.no}: unexpected indent`);
      const m = KEY.exec(stripComment(line.text));
      if (!m) throw new Error(`line ${line.no}: expected key: ${line.text}`);
      const key = unquote(m[1], line.no);
      if (Object.prototype.hasOwnProperty.call(map, key))
        throw new Error(`line ${line.no}: duplicate key ${key}`);
      at++;
      map[key] = value(m[2], line);
    }
    return map;
  }

  function sequence(indent: number): YamlNode[] {
    const list: YamlNode[] = [];
    for (skip(); at < lines.length; skip()) {
      const line = lines[at];
      if (line.indent !== indent || !isItem(line)) {
        if (line.indent > indent)
          throw new Error(`line ${line.no}: unexpected indent`);
        break;
      }
      const rest = line.text.slice(1).trimStart();
      const itemIndent = indent + (line.text.length - rest.length);
      if (rest !== '' && KEY.test(stripComment(rest))) {
        // `- key: value` starts a mapping whose keys sit after the dash
        lines[at] = { no: line.no, indent: itemIndent, text: rest };
        list.push(mapping(itemIndent));
      } else {
        at++;
        list.push(value(rest, { ...line, indent }));
      }
    }
    return list;
  }

  function block(indent: number): YamlNode {
    skip();
    return isItem(lines[at]) ? sequence(indent) : mapping(indent);
  }

  skip();
  if (at >= lines.length) return {};
  const root = block(lines[at].indent);
  skip();
  if (at < lines.length)
    throw new Error(`line ${lines[at].no}: unexpected content`);
  return root;
}

export type Workflow = { [key: string]: YamlNode };

/** One workflow file under .github/workflows, parsed. */
export function readWorkflow(file: string): Workflow {
  const text = readFileSync(
    resolve(__dirname, '../../.github/workflows', file),
    'utf8'
  );
  return asMap(parseYaml(text), file);
}

export function asMap(
  node: YamlNode | undefined,
  what = 'value'
): { [key: string]: YamlNode } {
  if (node === undefined || typeof node === 'string' || Array.isArray(node))
    throw new Error(`${what} is not a mapping`);
  return node;
}

export function asList(node: YamlNode | undefined, what = 'value'): YamlNode[] {
  if (!Array.isArray(node)) throw new Error(`${what} is not a list`);
  return node;
}

export function asString(node: YamlNode | undefined, what = 'value'): string {
  if (typeof node !== 'string') throw new Error(`${what} is not a string`);
  return node;
}

export function strings(node: YamlNode | undefined, what = 'value'): string[] {
  return asList(node, what).map((n, i) => asString(n, `${what}[${i}]`));
}

/** A job of the workflow, by id. */
export function jobOf(workflow: Workflow, id: string): Workflow {
  return asMap(asMap(workflow['jobs'], 'jobs')[id], `job ${id}`);
}

/** A job's steps. */
export function stepsOf(job: Workflow): Workflow[] {
  return asList(job['steps'], 'steps').map(step => asMap(step, 'step'));
}

/** The `run:` commands of a job's steps, in order. */
export function runsOf(job: Workflow): string[] {
  return stepsOf(job)
    .map(step => step['run'])
    .filter((run): run is string => typeof run === 'string')
    .map(run => run.trim());
}

/** A GitHub `paths` glob as a regular expression (`**` crosses folders). */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
