import { Router, type Request, type Response } from 'express';
import { getQuarterlyReport, getStoredReport } from '../services/reportCache.js';
import { getReportWindow } from '../util/reportWindow.js';
import {
  generateWeeklyReport, listWeeklyReports, getStoredWeeklyReport, getWeeklyAiSummary, setWeeklyAiSummary,
} from '../services/weeklyReport.js';
import { reportWeek, weekFromKey } from '../util/weekWindow.js';

const router = Router();

// Whether the quarterly-report button should be shown right now, and for what
// period. The client polls this to decide whether to surface the (ephemeral)
// button — it's only "available" for a few days after each quarter closes.
// `generatedAt` is when the stored copy was built (null until first generated).
router.get('/quarterly/status', (_req: Request, res: Response) => {
  const w = getReportWindow(new Date());
  res.json({
    generatedAt: getStoredReport()?.generatedAt ?? null,
    available: w.open,
    quarterLabel: w.quarterLabel,
    periodStart: w.periodStart,
    periodEnd: w.periodEnd,
    windowEndsAt: w.windowEndsAt,
  });
});

// Serve the stored report as a full HTML page (opened in a new tab by the
// client), generating it on first use. Everything is rendered locally.
router.get('/quarterly', async (_req: Request, res: Response) => {
  try {
    const { html } = await getQuarterlyReport();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  } catch (err) {
    console.error('[report] quarterly generation failed:', err);
    res.status(500).json({ error: 'Report generation failed.' });
  }
});

// Rebuild the report with the latest data and commentary, replacing the stored
// copy. Can take up to ~90 s; concurrent calls share one generation.
router.post('/quarterly/regenerate', async (_req: Request, res: Response) => {
  try {
    const { generatedAt } = await getQuarterlyReport({ fresh: true });
    res.json({ generatedAt });
  } catch (err) {
    console.error('[report] quarterly regeneration failed:', err);
    res.status(500).json({ error: 'Report generation failed.' });
  }
});

// --- weekly spending report (services/weeklyReport.ts) -------------------------
// Past reports (newest first), the week a new report would cover, and whether
// the optional AI summary is on.
router.get('/weekly', (_req: Request, res: Response) => {
  res.json({ reports: listWeeklyReports(), currentWeek: reportWeek().key, aiSummary: getWeeklyAiSummary() });
});
// Build (or rebuild) one week's report and store it. Body: { week?: 'YYYY-MM-DD' (a Monday) }.
router.post('/weekly/generate', async (req: Request, res: Response) => {
  const week = typeof req.body?.week === 'string' ? req.body.week : undefined;
  if (week && !weekFromKey(week)) return res.status(400).json({ error: 'week must be a Monday (YYYY-MM-DD)' });
  try {
    const m = await generateWeeklyReport({ week });
    res.json({ key: m.week.key, start: m.week.start, end: m.week.end, total: m.total });
  } catch (err) {
    console.error('[report] weekly failed:', err);
    res.status(500).json({ error: 'weekly report failed' });
  }
});
router.put('/weekly/settings', (req: Request, res: Response) => {
  if (typeof req.body?.aiSummary === 'boolean') setWeeklyAiSummary(req.body.aiSummary);
  res.json({ aiSummary: getWeeklyAiSummary() });
});
// A stored report: the email HTML (default) or ?format=text.
router.get('/weekly/:key', (req: Request, res: Response) => {
  const r = getStoredWeeklyReport(req.params.key);
  if (!r) return res.status(404).json({ error: 'no report for that week' });
  if (req.query.format === 'text') return res.type('text/plain').send(r.text);
  res.type('html').send(r.html);
});

export default router;
