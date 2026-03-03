const placeholderPattern = /^\$\{(watcher\.(id|skillId)|event\.(name)|payload\.[a-zA-Z0-9_.-]+|timestamp)\}$/;

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce((acc: any, part) => acc?.[part], obj as any);
}

export function renderTemplate(template: Record<string, string | number | boolean | null>, context: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(template)) {
    if (typeof value !== 'string') {
      out[key] = value;
      continue;
    }
    if (!value.startsWith('${')) {
      out[key] = value;
      continue;
    }
    if (!placeholderPattern.test(value)) {
      throw new Error(`Template placeholder not allowed: ${value}`);
    }
    const path = value.slice(2, -1);
    out[key] = getPath(context, path);
  }
  return out;
}
