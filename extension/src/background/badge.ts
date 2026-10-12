// Toolbar badge: "!" when BookSync needs the user, nothing otherwise.
import type { StatusView } from './messages';

const NEEDS_USER = new Set(['error', 'needs_confirmation', 'rollback_detected', 'roots_changed', 'native_sync_detected', 'signed_out']);

export function badgeFor(s: StatusView): { text: string; color: string } {
  if (!s.signedIn) return s.needsReLogin ? { text: '!', color: '#c63d3d' } : { text: '', color: '#6b6b73' };
  if (s.paused) return { text: '‖', color: '#6b6b73' };
  if (NEEDS_USER.has(s.status)) return { text: '!', color: s.status === 'error' ? '#c63d3d' : '#b26a00' };
  return { text: '', color: '#2f6fde' };
}
