import crypto from 'node:crypto';
function getPath(obj, path) {
    return path.split('.').reduce((acc, part) => acc?.[part], obj);
}
export function evaluateCondition(condition, payload, previousPayload) {
    const current = getPath(payload, condition.path);
    const previous = getPath(previousPayload, condition.path);
    switch (condition.op) {
        case 'eq': return current === condition.value;
        case 'neq': return current !== condition.value;
        case 'gt': return Number(current) > Number(condition.value);
        case 'gte': return Number(current) >= Number(condition.value);
        case 'lt': return Number(current) < Number(condition.value);
        case 'lte': return Number(current) <= Number(condition.value);
        case 'exists': return current !== undefined && current !== null;
        case 'absent': return current === undefined || current === null;
        case 'contains': return typeof current === 'string' ? current.includes(String(condition.value ?? '')) : Array.isArray(current) ? current.includes(condition.value) : false;
        case 'matches': return new RegExp(String(condition.value ?? '')).test(String(current ?? ''));
        case 'changed': return JSON.stringify(current) !== JSON.stringify(previous);
        default: return false;
    }
}
export function evaluateConditions(conditions, match, payload, previousPayload) {
    const results = conditions.map((c) => evaluateCondition(c, payload, previousPayload));
    return match === 'all' ? results.every(Boolean) : results.some(Boolean);
}
export function hashPayload(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
