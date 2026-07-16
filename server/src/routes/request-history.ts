import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import type { RequestLog } from '@freellmapi/shared/types';

export const requestHistoryRouter = Router();

// Cache: whether the new history columns exist in the requests table.
let _hasHistoryColumns: boolean | null = null;

function hasHistoryColumns(): boolean {
  if (_hasHistoryColumns !== null) return _hasHistoryColumns;
  try {
    const db = getDb();
    const cols = db.prepare("PRAGMA table_info(requests)").all() as { name: string }[];
    const names = new Set(cols.map(c => c.name));
    _hasHistoryColumns = names.has('request_body') && names.has('response_body') && names.has('provider');
  } catch {
    _hasHistoryColumns = false;
  }
  return _hasHistoryColumns;
}

// Query parameters schema
const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  provider: z.string().optional(),
  model: z.string().optional(),
  status: z.enum(['success', 'error']).optional(),
});

// GET /api/request-history - Get paginated request history with optional filters
requestHistoryRouter.get('/', (req: Request, res: Response) => {
  try {
    const { page, limit, provider, model, status } = querySchema.parse(req.query);
    const offset = (page - 1) * limit;
    
    const db = getDb();
    const useHistoryCols = hasHistoryColumns();
    // Use COALESCE(provider, platform) so old records (provider is NULL) still match.
    const providerExpr = useHistoryCols ? 'COALESCE(provider, platform)' : 'platform';
    
    // Build the WHERE clause dynamically based on filters
    const conditions: string[] = [];
    const params: any[] = [];
    
    if (provider) {
      conditions.push(`${providerExpr} = ?`);
      params.push(provider);
    }
    
    if (model) {
      conditions.push('model_id = ?');
      params.push(model);
    }
    
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    
    // Get total count for pagination
    const countQuery = `SELECT COUNT(*) as total FROM requests ${whereClause}`;
    const countResult = db.prepare(countQuery).get(...params) as { total: number };
    const totalCount = countResult.total;
    
    // Keep only the most recent 500 records (database level cleanup)
    const cleanupQuery = `
      DELETE FROM requests 
      WHERE id NOT IN (
        SELECT id FROM requests 
        ORDER BY created_at DESC 
        LIMIT 500
      )
    `;
    db.prepare(cleanupQuery).run();
    
    // Build SELECT columns — list endpoint does NOT return request_body/response_body
    // to keep the payload small. Those are fetched on demand via GET /:id.
    const providerCol = useHistoryCols ? 'COALESCE(provider, platform)' : 'platform';
    
    const query = `
      SELECT 
        id,
        platform,
        model_id,
        ${providerCol} as provider,
        status,
        input_tokens,
        output_tokens,
        latency_ms,
        error,
        created_at
      FROM requests 
      ${whereClause}
      ORDER BY created_at DESC 
      LIMIT ? OFFSET ?
    `;
    
    const rows = db.prepare(query).all(...params, limit, offset) as any[];
    
    const requests: RequestLog[] = rows.map(row => ({
      id: row.id,
      platform: row.platform,
      modelId: row.model_id,
      provider: row.provider || row.platform,
      status: row.status,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      latencyMs: row.latency_ms,
      error: row.error,
      requestBody: null,
      responseBody: null,
      createdAt: row.created_at,
    }));
    
    res.json({
      requests,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching request history:', error);
    res.status(500).json({ error: 'Failed to fetch request history' });
  }
});

// GET /api/request-history/stats - Get basic statistics for request history
// IMPORTANT: This route must be defined BEFORE /:id, otherwise Express matches
// 'stats' as an id parameter and returns 404.
requestHistoryRouter.get('/stats', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const useHistoryCols = hasHistoryColumns();
    const providerExpr = useHistoryCols ? 'COALESCE(provider, platform)' : 'platform';
    
    // Get counts by provider (falls back to platform for old records)
    const providerStats = db.prepare(`
      SELECT COALESCE(provider, platform) as provider, COUNT(*) as count
      FROM requests 
      GROUP BY COALESCE(provider, platform)
      ORDER BY count DESC
    `).all() as { provider: string; count: number }[];
    
    // Get counts by status
    const statusStats = db.prepare(`
      SELECT status, COUNT(*) as count
      FROM requests 
      GROUP BY status
    `).all() as { status: string; count: number }[];
    
    // Get recent activity (last 24 hours)
    const recentCount = db.prepare(`
      SELECT COUNT(*) as count
      FROM requests 
      WHERE datetime(created_at) >= datetime('now', '-24 hours')
    `).get() as { count: number };
    
    res.json({
      totalRequests: providerStats.reduce((sum, p) => sum + p.count, 0),
      providerStats,
      statusStats,
      recentActivity: {
        last24Hours: recentCount.count,
      },
    });
  } catch (error) {
    console.error('Error fetching request history stats:', error);
    res.status(500).json({ error: 'Failed to fetch request history stats' });
  }
});

// GET /api/request-history/:id - Get a single request with full request/response bodies
requestHistoryRouter.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const useHistoryCols = hasHistoryColumns();
    const providerCol = useHistoryCols ? 'COALESCE(provider, platform)' : 'platform';
    const bodyCols = useHistoryCols 
      ? 'request_body, response_body' 
      : 'NULL as request_body, NULL as response_body';
    
    const row = db.prepare(`
      SELECT 
        id,
        platform,
        model_id,
        ${providerCol} as provider,
        status,
        input_tokens,
        output_tokens,
        latency_ms,
        error,
        ${bodyCols},
        created_at
      FROM requests 
      WHERE id = ?
    `).get(req.params.id) as any;
    
    if (!row) {
      res.status(404).json({ error: 'Request not found' });
      return;
    }
    
    const requestLog: RequestLog = {
      id: row.id,
      platform: row.platform,
      modelId: row.model_id,
      provider: row.provider || row.platform,
      status: row.status,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      latencyMs: row.latency_ms,
      error: row.error,
      requestBody: row.request_body,
      responseBody: row.response_body,
      createdAt: row.created_at,
    };
    
    res.json(requestLog);
  } catch (error) {
    console.error('Error fetching request detail:', error);
    res.status(500).json({ error: 'Failed to fetch request detail' });
  }
});

// DELETE /api/request-history - Clear all request history
requestHistoryRouter.delete('/', (req: Request, res: Response) => {
  try {
    const db = getDb();
    
    const result = db.prepare('DELETE FROM requests').run();
    
    res.json({ 
      message: 'Request history cleared successfully',
      deletedCount: result.changes,
    });
  } catch (error) {
    console.error('Error clearing request history:', error);
    res.status(500).json({ error: 'Failed to clear request history' });
  }
});
