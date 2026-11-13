import { Router, type Request, type Response } from 'express';
import { KeyError } from '../services/keys.js';
import {
  getDeliveryStatus, saveEmailConfig, clearEmailConfig, savePushConfig, clearPushConfig, savePublicUrl,
  setLevel, emailConfig, pushConfig, sendTest, runWeeklyDelivery, CHANNELS, type Channel, type Level,
} from '../services/delivery.js';
import { dueWeek } from '../util/weekWindow.js';

// Weekly report delivery (services/delivery.ts). Settings answers never include
// a password or token, only whether one is saved.
const router = Router();

const status = () => ({ ...getDeliveryStatus(), dueWeek: dueWeek().key });

// Run a handler; a KeyError (bad input) is a 422 with its message.
function handle(res: Response, label: string, fn: () => Promise<unknown> | unknown) {
  Promise.resolve().then(fn).then(
    out => res.json(out ?? status()),
    (e: unknown) => {
      if (e instanceof KeyError) return res.status(422).json({ error: e.message });
      console.error(`[delivery] ${label} failed:`, e);
      res.status(502).json({ error: e instanceof Error ? e.message : `${label} failed` });
    },
  );
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

router.get('/', (_req: Request, res: Response) => { res.json(status()); });

router.put('/email', (req: Request, res: Response) => handle(res, 'saving email settings', () => {
  const b = req.body ?? {};
  saveEmailConfig({ host: str(b.host), port: b.port, user: str(b.user), pass: str(b.pass), to: str(b.to), from: str(b.from) });
}));
router.delete('/email', (_req: Request, res: Response) => handle(res, 'removing email settings', () => clearEmailConfig()));

router.put('/push', (req: Request, res: Response) => handle(res, 'saving push settings', () => {
  const b = req.body ?? {};
  savePushConfig({ url: str(b.url), token: str(b.token), clearToken: b.clearToken === true });
}));
router.delete('/push', (_req: Request, res: Response) => handle(res, 'removing push settings', () => clearPushConfig()));

router.put('/public-url', (req: Request, res: Response) => handle(res, 'saving the app address', () => savePublicUrl(str(req.body?.url) ?? '')));

// Body: { email?: 'off'|'full'|'totals'|'notice', push?: … }. A channel can be
// turned on only once its settings are saved.
router.put('/levels', (req: Request, res: Response) => handle(res, 'saving privacy levels', () => {
  for (const ch of CHANNELS) {
    const level = req.body?.[ch] as Level | undefined;
    if (level === undefined) continue;
    if (level !== 'off' && !(ch === 'email' ? emailConfig() : pushConfig())) throw new KeyError(`Save the ${ch} settings first.`);
    setLevel(ch, level);
  }
}));

router.post('/test/:channel', (req: Request, res: Response) => {
  const ch = req.params.channel as Channel;
  if (!CHANNELS.includes(ch)) return res.status(404).json({ error: 'unknown channel' });
  handle(res, `test ${ch}`, async () => { await sendTest(ch); return { ok: true }; });
});

// Send the due week's report now. Body: { week?: Monday, force?: true to send
// again on channels that already sent it }.
router.post('/send', (req: Request, res: Response) => handle(res, 'sending the weekly report', () =>
  runWeeklyDelivery({ build: true, week: str(req.body?.week), force: req.body?.force === true })));

export default router;
