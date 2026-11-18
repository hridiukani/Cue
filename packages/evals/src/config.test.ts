import { describe, expect, it } from 'vitest';
import { loadEvalConfig, useColor } from './config';

describe('loadEvalConfig', () => {
  it('defaults to the production model and a different judge', () => {
    expect(loadEvalConfig({})).toEqual({
      groqApiKey: undefined,
      groqBaseUrl: 'https://api.groq.com/openai/v1',
      defaultModel: 'openai/gpt-oss-20b',
      judgeModel: 'openai/gpt-oss-120b',
      databaseUrl: undefined,
      invocationDir: process.cwd(),
    });
  });

  it('resolves output paths from where pnpm was invoked (INIT_CWD)', () => {
    expect(loadEvalConfig({ INIT_CWD: '/repo' }).invocationDir).toBe('/repo');
  });

  it('treats empty values as unset and reads overrides', () => {
    const c = loadEvalConfig({
      GROQ_API_KEY: ' gsk_x ',
      DATABASE_URL: '',
      EVAL_JUDGE_MODEL: 'qwen/qwen3.8-27b',
    });
    expect(c).toMatchObject({
      groqApiKey: 'gsk_x',
      databaseUrl: undefined,
      judgeModel: 'qwen/qwen3.8-27b',
    });
  });

  it('rejects a malformed base URL', () => {
    expect(() => loadEvalConfig({ GROQ_BASE_URL: 'not a url' })).toThrow(/GROQ_BASE_URL/);
  });
});

describe('useColor', () => {
  it('only colours a TTY without NO_COLOR', () => {
    expect(useColor(true, {})).toBe(true);
    expect(useColor(false, {})).toBe(false);
    expect(useColor(true, { NO_COLOR: '1' })).toBe(false);
  });
});
