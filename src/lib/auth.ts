import { loadConfig } from '../trading/config.js';

export function isAuthorized(req: Request): boolean {
  const cfg = loadConfig();
  if (!cfg.BOT_TOKEN) return false;
  const provided = req.headers.get('x-bot-token');
  return provided !== null && provided === cfg.BOT_TOKEN;
}
