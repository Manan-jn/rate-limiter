import { z } from 'zod';

export const AlgorithmSchema = z.enum([
  'fixed_window',
  'sliding_window_counter',
  'token_bucket',
  'sliding_window_log',
  'leaky_bucket',
]);

export const KeyExtractorSchema = z.enum([
  'ip',
  'api_key_header',
  'jwt_sub',
  'composite',
]);

export const RuleSchema = z.object({
  ruleId: z.string().uuid().optional(),
  tenantId: z.string().min(1).max(64),
  route: z.string().regex(/^(GET|POST|PUT|PATCH|DELETE|\*):\/.*$/),
  algorithm: AlgorithmSchema,
  limit: z.number().int().positive(),
  windowSec: z.number().int().positive(),
  burst: z.number().int().positive().optional(),
  failOpen: z.boolean().default(true),
  dryRun: z.boolean().default(false),
  keyExtractor: KeyExtractorSchema.default('ip'),
  keyHeader: z.string().optional(),
});

export const TenantSchema = z.object({
  tenantId: z.string().min(1).max(64),
  defaultAlgorithm: AlgorithmSchema,
  defaultLimit: z.number().int().positive(),
  windowSec: z.number().int().positive(),
});

export const CheckRequestSchema = z.object({
  tenantId: z.string().min(1).max(64),
  clientKey: z.string().min(1),
  route: z.string().regex(/^(GET|POST|PUT|PATCH|DELETE|\*):\/.*$/),
});

export type RuleInput = z.input<typeof RuleSchema>;
export type TenantInput = z.input<typeof TenantSchema>;
