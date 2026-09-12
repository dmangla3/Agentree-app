import type { ZodError, ZodType } from 'zod';

export type SchemaDiagnosticContext = Record<string, unknown> & {
  schemaName: string;
};

export type SchemaParseResult<T> =
  | { success: true; data: T }
  | { success: false; error: ZodError };

export const recordSchemaDiagnostic = (
  context: SchemaDiagnosticContext,
  error: ZodError,
) => {
  console.warn('[schemaDiagnostics] Invalid agent ingress payload', {
    ...context,
    issues: error.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      path: issue.path.join('.'),
    })),
  });
};

export const safeParseWithDiagnostics = <T>(
  schema: ZodType<T>,
  value: unknown,
  context: SchemaDiagnosticContext,
): SchemaParseResult<T> => {
  const result = schema.safeParse(value);
  if (result.success) return { success: true, data: result.data };
  recordSchemaDiagnostic(context, result.error);
  return { success: false, error: result.error };
};
