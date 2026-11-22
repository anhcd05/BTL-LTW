/**
 * Aggregate view of the catalogue + behaviour, exactly at the granularity stored in the database
 * (likes, track_listens, track_engagement counters, playlist_tracks, follows, music_preferences,
 * impressions). Training, evaluation and the in-memory recommender all read this shape, whether it
 * was loaded from the demo database or produced by the synthetic generator.
 */
export type SnapTrack = {
  id: string;
  authorId: string;
  title: string;
  genres: string[];
  publishedAt: Date;
  playCount: number;
};

export type Snapshot = {
  now: Date;
  /** Public (READY + PUBLISHED + not deleted + active author) tracks only. */
  tracks: SnapTrack[];
  /** Account users whose behaviour is modelled (listeners). */
  users: string[];
  likes: { userId: string; trackId: string; at: Date }[];
  listens: { userId: string; trackId: string; qualifiedPlays: number; lastListenedAt: Date }[];
  engagement: {
    userId: string;
    trackId: string;
    starts: number;
    skips: number;
    completes: number;
    lastEventAt: Date;
  }[];
  playlistTracks: { userId: string; trackId: string; at: Date }[];
  follows: { userId: string; authorId: string }[];
  preferences: { userId: string; genreIds: string[]; artistIds: string[] }[];
  impressions: { userId: string; trackId: string; shownAt: Date; clicked: boolean }[];
  embeddings: Map<string, Float32Array>;
};

export type PairStat = {
  liked: boolean;
  likedAt: number | null;
  plays: number;
  lastListenedAt: number | null;
  starts: number;
  skips: number;
  completes: number;
  lastEventAt: number | null;
  inPlaylist: boolean;
  playlistAt: number | null;
  impressedNotClicked: boolean;
};

export const DAY_MS = 86_400_000;

export function emptyPair(): PairStat {
  return {
    liked: false,
    likedAt: null,
    plays: 0,
    lastListenedAt: null,
    starts: 0,
    skips: 0,
    completes: 0,
    lastEventAt: null,
    inPlaylist: false,
    playlistAt: null,
    impressedNotClicked: false,
  };
}

/** DESIGN §2 label: positive = like OR completes >= 1 OR qualified_plays >= 2. */
export function isLabelPositive(p: PairStat): boolean {
  return p.liked || p.completes >= 1 || p.plays >= 2;
}

/** DESIGN §1 CF positive set: likes ∪ track_listens ∪ completes>0 ∪ playlist_tracks. */
export function isCfPositive(p: PairStat): boolean {
  return p.liked || p.plays >= 1 || p.completes > 0 || p.inPlaylist;
}

/** Negative evidence: skipped (or impressed and not clicked) without any positive signal. */
export function isObservedNegative(p: PairStat): boolean {
  return !isLabelPositive(p) && !p.inPlaylist && (p.skips > 0 || p.impressedNotClicked);
}

/** Latest timestamp of any interaction stored for the pair (ms). */
export function pairTime(p: PairStat): number {
  return Math.max(p.likedAt ?? -Infinity, p.lastListenedAt ?? -Infinity, p.lastEventAt ?? -Infinity, p.playlistAt ?? -Infinity);
}

export function pairKey(userId: string, trackId: string): string {
  return `${userId}|${trackId}`;
}

/** user -> track -> aggregated pair statistics. */
export function pairIndex(s: Snapshot): Map<string, Map<string, PairStat>> {
  const out = new Map<string, Map<string, PairStat>>();
  const get = (u: string, t: string): PairStat => {
    let m = out.get(u);
    if (!m) out.set(u, (m = new Map()));
    let p = m.get(t);
    if (!p) m.set(t, (p = emptyPair()));
    return p;
  };
  for (const r of s.likes) {
    const p = get(r.userId, r.trackId);
    p.liked = true;
    p.likedAt = r.at.getTime();
  }
  for (const r of s.listens) {
    const p = get(r.userId, r.trackId);
    p.plays += r.qualifiedPlays;
    p.lastListenedAt = r.lastListenedAt.getTime();
  }
  for (const r of s.engagement) {
    const p = get(r.userId, r.trackId);
    p.starts += r.starts;
    p.skips += r.skips;
    p.completes += r.completes;
    p.lastEventAt = r.lastEventAt.getTime();
  }
  for (const r of s.playlistTracks) {
    const p = get(r.userId, r.trackId);
    p.inPlaylist = true;
    p.playlistAt = Math.max(p.playlistAt ?? -Infinity, r.at.getTime());
  }
  const clicked = new Set(s.impressions.filter((r) => r.clicked).map((r) => pairKey(r.userId, r.trackId)));
  for (const r of s.impressions)
    if (!clicked.has(pairKey(r.userId, r.trackId))) get(r.userId, r.trackId).impressedNotClicked = true;
  return out;
}

/** Copy of the snapshot without the given (user, track) pairs; play counts are reduced consistently. */
export function withoutPairs(s: Snapshot, removed: Set<string>): Snapshot {
  const keep = (r: { userId: string; trackId: string }) => !removed.has(pairKey(r.userId, r.trackId));
  const playsRemoved = new Map<string, number>();
  for (const r of s.listens)
    if (!keep(r)) playsRemoved.set(r.trackId, (playsRemoved.get(r.trackId) ?? 0) + r.qualifiedPlays);
  return {
    ...s,
    tracks: s.tracks.map((t) => ({ ...t, playCount: Math.max(0, t.playCount - (playsRemoved.get(t.id) ?? 0)) })),
    likes: s.likes.filter(keep),
    listens: s.listens.filter(keep),
    engagement: s.engagement.filter(keep),
    playlistTracks: s.playlistTracks.filter(keep),
    impressions: s.impressions.filter(keep),
  };
}
