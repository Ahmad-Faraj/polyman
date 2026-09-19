import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Keeps template/Config.schema.json and template/Config.json in lockstep.
 * The schema is hand-written from ConfigFile in src/types.d.ts; these checks
 * catch the cheap drifts (a key added to one side but not the other, an enum
 * the template no longer satisfies) without pulling in a validator library.
 */

const templateDir = path.resolve(__dirname, '..', 'template');
const schemaPath = path.join(templateDir, 'Config.schema.json');
const configPath = path.join(templateDir, 'Config.json');

interface JsonSchema {
  $schema?: string;
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
  definitions?: Record<string, { enum?: string[] }>;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

describe('template/Config.schema.json', () => {
  const schema = readJson<JsonSchema>(schemaPath);
  const config = readJson<Record<string, unknown>>(configPath);

  it('is a draft-07 object schema with a properties map', () => {
    expect(schema.$schema).toContain('draft-07');
    expect(schema.type).toBe('object');
    expect(typeof schema.properties).toBe('object');
    expect(Array.isArray(schema.required)).toBe(true);
  });

  it('template Config.json declares every required key', () => {
    for (const key of schema.required ?? []) {
      expect(config, `missing required key "${key}"`).toHaveProperty(key);
    }
  });

  it('schema declares every top-level key used by template Config.json', () => {
    const declared = new Set(Object.keys(schema.properties ?? {}));
    for (const key of Object.keys(config)) {
      expect(declared.has(key), `undeclared key "${key}"`).toBe(true);
    }
  });

  it('template Config.json points at the schema file that ships with it', () => {
    expect(config['$schema']).toBe('./Config.schema.json');
    expect(fs.existsSync(schemaPath)).toBe(true);
  });

  it('template solutions use tags and sourceTypes the schema allows', () => {
    const tags = schema.definitions?.['SolutionTag']?.enum ?? [];
    const sourceTypes = schema.definitions?.['SolutionSourceType']?.enum ?? [];
    expect(tags).toEqual(
      expect.arrayContaining([
        'MA',
        'OK',
        'WA',
        'TL',
        'TO',
        'ML',
        'RE',
        'PE',
        'RJ',
      ])
    );
    const solutions = config['solutions'] as {
      tag: string;
      sourceType?: string;
    }[];
    expect(solutions.length).toBeGreaterThan(0);
    for (const solution of solutions) {
      expect(tags).toContain(solution.tag);
      if (solution.sourceType !== undefined) {
        expect(sourceTypes).toContain(solution.sourceType);
      }
    }
  });
});
