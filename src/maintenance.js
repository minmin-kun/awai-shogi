// Index-backed, bounded cleanup keeps each hourly run small on the free plan.
export const CLEANUP_SQL='DELETE FROM rooms WHERE code IN (SELECT code FROM rooms WHERE expires <= ? ORDER BY expires LIMIT 500)';
export async function cleanupExpired(db,now=Date.now()){
 return db.prepare(CLEANUP_SQL).bind(now).run();
}
