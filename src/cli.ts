#!/usr/bin/env node
import { createSentinelPlugin } from './index.js';

const [cmd, arg] = process.argv.slice(2);

const plugin = createSentinelPlugin();
await plugin.init();

switch (cmd) {
  case 'list':
    console.log(JSON.stringify(plugin.manager.list(), null, 2));
    break;
  case 'status':
    console.log(JSON.stringify(plugin.manager.status(arg || ''), null, 2));
    break;
  case 'enable':
    await plugin.manager.enable(arg || '');
    console.log('ok');
    break;
  case 'disable':
    await plugin.manager.disable(arg || '');
    console.log('ok');
    break;
  case 'audit':
    console.log(JSON.stringify(await plugin.manager.audit(), null, 2));
    break;
  default:
    console.log('Usage: openclaw-sentinel <list|status <id>|enable <id>|disable <id>|audit>');
}
