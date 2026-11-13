import { Router, type Request, type Response } from 'express';
import { takeSnapshot } from '../services/netWorth.js';
import { CATEGORIES, type Category } from '../util/categorize.js';
import { getDb } from '../db/schema.js';

const router = Router();

// Override an account's category, display name, and/or hidden state. Works for
// every account (Plaid-linked or manual), whatever its source.
// name: a string sets a custom name; null resets to the institution's name.
// hidden: when true, the account drops out of the list and net-worth totals.
router.patch('/:id', (req: Request, res: Response) => {
  const { category, name, hidden } = req.body as {
    category?: Category;
    name?: string | null;
    hidden?: boolean;
  };
  const db = getDb();

  if (category !== undefined) {
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'valid category required' });
    }
    db.prepare('UPDATE accounts SET category = ? WHERE id = ?').run(category, req.params.id);
  }

  if (name !== undefined) {
    const custom = name && name.trim() ? name.trim() : null;
    db.prepare('UPDATE accounts SET custom_name = ? WHERE id = ?').run(custom, req.params.id);
  }

  if (hidden !== undefined) {
    db.prepare('UPDATE accounts SET hidden = ? WHERE id = ?').run(hidden ? 1 : 0, req.params.id);
  }

  // Hiding changes the totals, so re-snapshot today.
  takeSnapshot();
  res.json({ success: true });
});

export default router;
