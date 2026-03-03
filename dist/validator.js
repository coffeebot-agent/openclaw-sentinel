import { z } from 'zod';
const codeyKeyPattern = /(script|code|eval|handler|function|import|require)/i;
const codeyValuePattern = /(=>|\bfunction\b|\bimport\s+|\brequire\s*\(|\beval\s*\()/i;
const conditionSchema = z.object({
    path: z.string().min(1),
    op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists', 'absent', 'contains', 'matches', 'changed']),
    value: z.any().optional()
}).strict();
const watcherSchema = z.object({
    id: z.string().min(1),
    skillId: z.string().min(1),
    enabled: z.boolean().default(true),
    strategy: z.enum(['http-poll', 'websocket', 'sse', 'http-long-poll']),
    endpoint: z.string().url(),
    method: z.enum(['GET', 'POST']).optional(),
    headers: z.record(z.string()).optional(),
    body: z.string().optional(),
    intervalMs: z.number().int().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    match: z.enum(['all', 'any']),
    conditions: z.array(conditionSchema).min(1),
    fire: z.object({
        webhookPath: z.string().regex(/^\//),
        eventName: z.string().min(1),
        payloadTemplate: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    }).strict(),
    retry: z.object({
        maxRetries: z.number().int().min(0).max(20),
        baseMs: z.number().int().min(50).max(60000),
        maxMs: z.number().int().min(100).max(300000)
    }).strict(),
    metadata: z.record(z.string()).optional()
}).strict();
function scanNoCodeLike(input, parentKey = '') {
    if (input === null || input === undefined)
        return;
    if (typeof input === 'string') {
        if (codeyValuePattern.test(input))
            throw new Error(`Code-like value rejected at ${parentKey || '<root>'}`);
        return;
    }
    if (Array.isArray(input)) {
        input.forEach((v, i) => scanNoCodeLike(v, `${parentKey}[${i}]`));
        return;
    }
    if (typeof input === 'object') {
        for (const [key, value] of Object.entries(input)) {
            if (codeyKeyPattern.test(key))
                throw new Error(`Code-like field rejected: ${parentKey ? `${parentKey}.` : ''}${key}`);
            scanNoCodeLike(value, parentKey ? `${parentKey}.${key}` : key);
        }
    }
}
export function validateWatcherDefinition(input) {
    scanNoCodeLike(input);
    return watcherSchema.parse(input);
}
