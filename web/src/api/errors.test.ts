import { describe, expect, test } from 'vitest';
import { errorFromResponse, parseServerErrorDetail } from './errors';

describe('browser error contract', () => {
  test('accepts bounded Unicode-safe reviewed error details', () => {
    const detail = parseServerErrorDetail({
      code: 'invalid_input',
      category: 'validation',
      message: 'Invalid value — café 雪',
      remediation: 'Correct the highlighted field and retry.',
      retryable: false,
      field: 'values.query',
    });
    expect(detail).toEqual({
      code: 'invalid_input',
      category: 'validation',
      message: 'Invalid value — café 雪',
      remediation: 'Correct the highlighted field and retry.',
      retryable: false,
      field: 'values.query',
    });
  });

  test('rejects unknown codes, control characters, unsafe fields, and oversized detail', () => {
    expect(
      parseServerErrorDetail({
        code: 'future_failure',
        category: 'internal',
        message: 'Unknown',
        retryable: false,
      }),
    ).toBeNull();
    expect(
      parseServerErrorDetail({
        code: 'internal_error',
        category: 'internal',
        message: 'bad\u0000text',
        retryable: false,
      }),
    ).toBeNull();
    expect(
      parseServerErrorDetail({
        code: 'invalid_input',
        category: 'validation',
        message: 'Invalid',
        retryable: false,
        field: 'commands.inspect.argv[0]',
      }),
    ).toBeNull();
    expect(
      parseServerErrorDetail({
        code: 'internal_error',
        category: 'internal',
        message: 'x'.repeat(513),
        retryable: false,
      }),
    ).toBeNull();
  });

  test('unknown response payload becomes a generic bounded client error', async () => {
    const response = new Response(
      JSON.stringify({
        error: {
          code: 'future_failure',
          category: 'internal',
          message: 'PRIVATE_INTERNAL_MARKER',
          retryable: false,
        },
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
    const error = await errorFromResponse(response);
    expect(error.detail.code).toBe('invalid_response');
    expect(error.message).not.toContain('PRIVATE_INTERNAL_MARKER');
  });
});
