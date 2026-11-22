'use client';
import { useQuery } from '@tanstack/react-query';
import Link from './app-navigation';
import { NavigationAction } from './navigation-action';
import { api, ApiError, type RecommendationReason, type Track } from '@/lib/api';
import { getLanguage } from '@/lib/languages';
import { useAuth } from './providers';
import { useI18n } from './locale-provider';
import { Empty, ErrorState, Loading, PageTitle, TrackCards } from './common';
import { Icon } from './icons';
import { useRecommendationTelemetry } from './recommendation-telemetry';

/** Contract: recommendation-ai/docs/DESIGN.md §4. Public shelves carry no scores. */
type ShelfKind = 'LISTENED' | 'FOLLOW' | 'TRENDING' | 'FOR_YOU';
type Shelf = { kind: ShelfKind; seedTitle?: string | null; items: Track[] };
type Shelves = {
  requestId: string | null;
  /** Server-signed; required by impression/click logging. Absent ⇒ telemetry disabled. */
  impressionToken?: string | null;
  modelVersion: string | null;
  shelves: Shelf[];
};
type ExplainCandidate = {
  trackId: string;
  title: string;
  artistName: string;
  sources: string[];
  features: Record<string, number>;
  score: number;
  decision: 'SELECTED' | 'DROPPED';
  dropReason?: 'LIKED' | 'RECENT' | 'SKIPPED' | 'OWN' | 'ARTIST_CAP' | 'BELOW_CUTOFF';
  position?: number;
};
type Explain = {
  requestId: string | null;
  modelVersion: string | null;
  featureNames: string[];
  weights: number[];
  bias: number;
  fallback: boolean;
  candidates: ExplainCandidate[];
};

const shelfReason: Record<ShelfKind, RecommendationReason> = {
  LISTENED: 'LISTENED',
  FOLLOW: 'FOLLOW',
  TRENDING: 'TRENDING',
  FOR_YOU: 'SIMILAR',
};
const sourceLabels: Record<string, string> = {
  CF: 'Lọc cộng tác',
  CONTENT: 'Nội dung tương tự',
  FOLLOW: 'Nghệ sĩ bạn theo dõi',
  TRENDING: 'Đang thịnh hành',
  EXPLORE: 'Khám phá',
};
const dropLabels: Record<NonNullable<ExplainCandidate['dropReason']>, string> = {
  LIKED: 'Đã thích',
  RECENT: 'Nghe gần đây',
  SKIPPED: 'Bạn vừa bỏ qua',
  OWN: 'Bài hát do bạn đăng',
  ARTIST_CAP: 'Giới hạn một bài mỗi nghệ sĩ',
  BELOW_CUTOFF: 'Ngoài 5 vị trí đầu',
};

export function RecommendationsPage() {
  const { user } = useAuth();
  // Keyed by account so a new identity never sees the previous account's shelves or explain data.
  return user ? <RecommendationShelves key={user.id} userId={user.id} /> : null;
}

function RecommendationShelves({ userId }: { userId: string }) {
  const { t: tr } = useI18n();
  const result = useQuery({
    queryKey: ['recommendations', userId, 'shelves'],
    queryFn: ({ signal }) => api<Shelves>('/recommendations/shelves', { signal }),
  });
  const shelves = result.data?.shelves.filter((shelf) => shelf.items.length) ?? [];
  return (
    <div className="recommendations-page">
      <PageTitle
        eyebrow={tr('DÀNH RIÊNG CHO BẠN')}
        title={tr('Gợi ý dành cho bạn.')}
        description={tr('Kết hợp lịch sử nghe, nội dung bài hát và nghệ sĩ bạn theo dõi.')}
      />
      {result.isPending ? (
        <Loading />
      ) : result.isError ? (
        <ErrorState error={result.error} retry={() => void result.refetch()} />
      ) : shelves.length ? (
        shelves.map((shelf, index) => (
          <RecommendationShelf
            key={shelf.kind + index}
            id={'recommendations-shelf-' + index}
            shelf={shelf}
            requestId={result.data.requestId}
            impressionToken={result.data.impressionToken}
          />
        ))
      ) : (
        <Empty
          title={tr('Chưa có gợi ý phù hợp')}
          description={tr('Nghe, thích bài hát hoặc theo dõi nghệ sĩ để nhận thêm gợi ý.')}
          icon="music"
          action={<NavigationAction href="/new-releases">{tr('Mới phát hành')}</NavigationAction>}
        />
      )}
      <RecommendationExplain userId={userId} />
    </div>
  );
}

function RecommendationShelf({
  id,
  shelf,
  requestId,
  impressionToken,
}: {
  id: string;
  shelf: Shelf;
  requestId: string | null;
  impressionToken?: string | null;
}) {
  const { t: tr } = useI18n();
  const seedTitle = shelf.seedTitle?.trim() || undefined;
  // Shelf membership is itself the reason; keep any per-item reason the API already supplied.
  const tracks = shelf.items.slice(0, 10).map((track) => ({
    ...track,
    recommendation: track.recommendation ?? {
      reason: shelfReason[shelf.kind] ?? 'SIMILAR',
      ...(shelf.kind === 'LISTENED' && seedTitle ? { seedTitle } : {}),
    },
  }));
  const telemetry = useRecommendationTelemetry({
    requestId,
    impressionToken,
    surface: 'shelf_' + shelf.kind.toLowerCase(),
    tracks,
    enabled: true,
    fallbackReason: shelfReason[shelf.kind] ?? 'SIMILAR',
  });
  const title =
    shelf.kind === 'LISTENED'
      ? seedTitle
        ? tr('Vì bạn đã nghe {title}', { title: seedTitle })
        : tr('Dựa trên lịch sử nghe của bạn')
      : shelf.kind === 'FOLLOW'
        ? tr('Từ nghệ sĩ bạn theo dõi')
        : shelf.kind === 'TRENDING'
          ? tr('Đang thịnh hành')
          : tr('Dành riêng cho bạn');
  return (
    <section className="catalog-section recommendation-shelf" aria-labelledby={id}>
      <div className="section-heading">
        <h2 id={id}>
          {title}
          <span className="heading-dot">.</span>
        </h2>
      </div>
      <div ref={telemetry.container}>
        <TrackCards tracks={tracks} onPlay={telemetry.onPlay} />
      </div>
    </section>
  );
}

function useNumberFormat() {
  const { locale } = useI18n();
  const tag = getLanguage(locale).tag;
  const formatter = new Intl.NumberFormat(
    Intl.NumberFormat.supportedLocalesOf([tag]).length ? tag : 'en-US',
    { minimumFractionDigits: 3, maximumFractionDigits: 3 },
  );
  return (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? formatter.format(value) : '—';
}

/** Flag-gated diagnostics for the signed-in user's own request; hidden when the API returns 404. */
function RecommendationExplain({ userId }: { userId: string }) {
  const { t: tr } = useI18n();
  const format = useNumberFormat();
  const result = useQuery({
    queryKey: ['recommendations', userId, 'explain'],
    queryFn: ({ signal }) => api<Explain>('/recommendations/explain', { signal }),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 2,
  });
  if (result.isPending) return null;
  if (result.isError && result.error instanceof ApiError && result.error.status === 404)
    return null;
  const data = result.data;
  const featureNames = data
    ? [
        ...data.featureNames,
        ...Array.from(
          new Set(data.candidates.flatMap((item) => Object.keys(item.features))),
        ).filter((name) => !data.featureNames.includes(name)),
      ]
    : [];
  const candidatesCaption = tr('Ứng viên ({count})', { count: data?.candidates.length ?? 0 });
  return (
    <section className="catalog-section" aria-labelledby="recommendation-explain-title">
      <details className="recommendation-explain">
        <summary>
          <Icon name="settings" size={18} />
          <span id="recommendation-explain-title">{tr('Giải thích gợi ý')}</span>
          <span className="recommendation-explain-chevron" aria-hidden="true">
            <Icon name="down" size={18} />
          </span>
        </summary>
        <div className="recommendation-explain-body">
          <p className="muted">
            {tr(
              'Cách mô hình chọn từng bài: nguồn ứng viên, đặc trưng và điểm xếp hạng, rồi quyết định cuối cùng.',
            )}
          </p>
          {result.isError ? (
            <ErrorState error={result.error} retry={() => void result.refetch()} />
          ) : data ? (
            <>
              <dl className="recommendation-explain-meta">
                <div>
                  <dt>{tr('Phiên bản mô hình')}</dt>
                  <dd>
                    <code>{data.modelVersion || '—'}</code>
                  </dd>
                </div>
                <div>
                  <dt>{tr('Chế độ')}</dt>
                  <dd>{tr(data.fallback ? 'Dự phòng theo quy tắc' : 'Mô hình lai')}</dd>
                </div>
                <div>
                  <dt>{tr('Hệ số chặn')}</dt>
                  <dd>{format(data.bias)}</dd>
                </div>
              </dl>
              {data.featureNames.length > 0 && (
                <div
                  className="recommendation-explain-scroll"
                  role="region"
                  aria-label={tr('Trọng số mô hình')}
                  tabIndex={0}
                >
                  <table className="recommendation-explain-table compact">
                    <caption>{tr('Trọng số mô hình')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{tr('Đặc trưng')}</th>
                        <th scope="col">{tr('Trọng số')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.featureNames.map((name, index) => (
                        <tr key={name}>
                          <th scope="row">
                            <code>{name}</code>
                          </th>
                          <td>{format(data.weights[index])}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div
                className="recommendation-explain-scroll"
                role="region"
                aria-label={candidatesCaption}
                tabIndex={0}
              >
                <table className="recommendation-explain-table">
                  <caption>{candidatesCaption}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{tr('Bài hát')}</th>
                      <th scope="col">{tr('Tầng 1 · Nguồn')}</th>
                      <th scope="col">{tr('Tầng 2 · Đặc trưng')}</th>
                      <th scope="col">{tr('Tầng 2 · Điểm LR')}</th>
                      <th scope="col">{tr('Tầng 3 · Quyết định')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.candidates.length ? (
                      data.candidates.map((item) => (
                        <tr key={item.trackId} data-decision={item.decision}>
                          <th scope="row">
                            <Link href={'/tracks/' + item.trackId}>{item.title}</Link>
                            <span className="muted">{item.artistName}</span>
                          </th>
                          <td>
                            <ul className="recommendation-explain-sources">
                              {item.sources.map((source) => (
                                <li key={source}>
                                  {sourceLabels[source] ? tr(sourceLabels[source]) : source}
                                </li>
                              ))}
                            </ul>
                          </td>
                          <td>
                            <dl className="recommendation-explain-features">
                              {featureNames.map((name) => (
                                <div key={name}>
                                  <dt>
                                    <code>{name}</code>
                                  </dt>
                                  <dd>{format(item.features[name])}</dd>
                                </div>
                              ))}
                            </dl>
                          </td>
                          <td className="recommendation-explain-score">{format(item.score)}</td>
                          <td>
                            {item.decision === 'SELECTED' ? (
                              <strong className="recommendation-explain-selected">
                                {item.position
                                  ? tr('Được chọn · vị trí {position}', { position: item.position })
                                  : tr('Được chọn')}
                              </strong>
                            ) : (
                              <span className="recommendation-explain-dropped">
                                {tr('Bị loại')}
                                {item.dropReason && dropLabels[item.dropReason]
                                  ? ' · ' + tr(dropLabels[item.dropReason])
                                  : ''}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={5}>{tr('Không có ứng viên nào.')}</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <p className="small muted">
                {tr('Điểm chỉ hiển thị cho chính bạn khi chế độ giải thích được bật.')}
              </p>
            </>
          ) : null}
        </div>
      </details>
    </section>
  );
}
