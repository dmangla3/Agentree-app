import { z } from 'zod';
import { safeParseWithDiagnostics, type SchemaDiagnosticContext } from './schemaDiagnostics';

const agentStructuredMetaFieldSchemas = {
  commit_subject: z.string().trim().max(72).optional(),
  commit_body: z.string().trim().max(2000).optional(),
  ai_label: z.string().trim().max(80).optional(),
  thread_title: z.string().trim().max(80).optional(),
};

export const AgentStructuredMetaSchema = z.object(agentStructuredMetaFieldSchemas).passthrough();
export const ProviderMetaRecordSchema = z.record(z.string(), z.unknown());

export type AgentStructuredMeta = z.infer<typeof AgentStructuredMetaSchema>;

const structuredMetaKeys = Object.keys(agentStructuredMetaFieldSchemas) as Array<keyof typeof agentStructuredMetaFieldSchemas>;

export const sanitizeAgentStructuredMeta = (
  value: unknown,
  context: Omit<SchemaDiagnosticContext, 'schemaName'> = {},
): AgentStructuredMeta | null => {
  const metaResult = safeParseWithDiagnostics(ProviderMetaRecordSchema, value, {
    ...context,
    schemaName: 'provider_meta.meta',
  });
  if (!metaResult.success) return null;

  const sanitized: Record<string, unknown> = { ...metaResult.data };
  for (const key of structuredMetaKeys) {
    if (!Object.prototype.hasOwnProperty.call(sanitized, key)) continue;
    const fieldResult = safeParseWithDiagnostics(agentStructuredMetaFieldSchemas[key], sanitized[key], {
      ...context,
      schemaName: `provider_meta.meta.${key}`,
      field: key,
    });
    if (fieldResult.success && fieldResult.data !== undefined) {
      sanitized[key] = fieldResult.data;
    } else {
      delete sanitized[key];
    }
  }

  return sanitized as AgentStructuredMeta;
};
