'use client';
import { NavigationAction } from './navigation-action';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { api, type Track } from '@/lib/api';
import {
  emptyMusicChoices,
  readVisitorPreferences,
  saveVisitorPreferences,
  visitorPreferencesKey,
  type MusicChoices,
  type MusicPreferences,
} from '@/lib/music-preferences';
import { useAuth } from './providers';
import { useI18n } from './locale-provider';
import { Empty, ErrorState, Loading, TrackCards } from './common';
import { MusicPreferenceSurvey } from './music-preference-survey';
import { Icon } from './icons';
import { useRecommendationTelemetry } from './recommendation-telemetry';

type Recommendations = {
  items: Track[];
  reason: 'MATCHED' | 'POPULAR' | 'NO_MATCHES';
  source: 'PREFERENCES' | 'LIKES' | 'POPULAR' | 'HYBRID';
  /** Hybrid responses only; null/absent for the rule-based fallback and visitor preview. */
  requestId?: string | null;
  /** Server-signed; required by impression/click logging. Absent ⇒ telemetry disabled. */
  impressionToken?: string | null;
  modelVersion?: string | null;
};
type Telemetry = ReturnType<typeof useRecommendationTelemetry>;
function RecommendationHeading({
  source,
  onEdit,
  editRef,
  disabled = false,
  more = false,
}: {
  source?: Recommendations['source'];
  onEdit?: () => void;
  editRef?: RefObject<HTMLButtonElement | null>;
  disabled?: boolean;
  /** Authenticated accounts only: link to the /recommendations shelves page. */
  more?: boolean;
}) {
  const { t: tr } = useI18n();
  return (
    <div className="section-heading recommendation-heading">
      <div>
        <h2 id="home-recommendations-title">
          {tr('Giai điệu đề xuất')}
          <span className="heading-dot">.</span>
        </h2>
        <p className="muted">
          {tr(
            source === 'HYBRID'
              ? 'Kết hợp lịch sử nghe, nội dung bài hát và nghệ sĩ bạn theo dõi.'
              : source === 'PREFERENCES'
                ? 'Dựa trên thể loại và nghệ sĩ bạn đã chọn.'
                : source === 'LIKES'
                  ? 'Dựa trên thể loại của những bài hát bạn đã thích.'
                  : 'Những bài hát có lượt nghe cao nhất.',
          )}
        </p>
      </div>
      {(onEdit || more) && (
        <div className="recommendation-heading-actions">
          {onEdit && (
            <button
              ref={editRef}
              type="button"
              className="text-action"
              disabled={disabled}
              onClick={onEdit}
            >
              {tr('Chỉnh sửa sở thích')}
            </button>
          )}
          {more && (
            <NavigationAction
              href="/recommendations"
              aria-labelledby="home-recommendations-more home-recommendations-title"
            >
              <span id="home-recommendations-more">{tr('Xem thêm')}</span>
            </NavigationAction>
          )}
        </div>
      )}
    </div>
  );
}
function RecommendationResults({
  result,
  telemetry,
}: {
  result: UseQueryResult<Recommendations, Error>;
  telemetry?: Telemetry;
}) {
  const { t: tr } = useI18n();
  if (result.isPending) return <Loading />;
  if (result.isError)
    return <ErrorState error={result.error} retry={() => void result.refetch()} />;
  if (result.data.items.length)
    return (
      <div ref={telemetry?.container}>
        <TrackCards tracks={result.data.items.slice(0, 5)} onPlay={telemetry?.onPlay} />
      </div>
    );
  return (
    <Empty
      title={tr(
        result.data.source === 'POPULAR' ? 'Chưa có bài hát công khai' : 'Chưa có gợi ý phù hợp',
      )}
      description={tr(
        result.data.source === 'PREFERENCES'
          ? 'Chưa có bài hát phù hợp với lựa chọn của bạn.'
          : result.data.source === 'LIKES'
            ? 'Chưa có bài hát mới phù hợp với thể loại bạn thích. Hãy khám phá thêm hoặc quay lại sau.'
            : result.data.source === 'HYBRID'
              ? 'Nghe, thích bài hát hoặc theo dõi nghệ sĩ để nhận thêm gợi ý.'
              : 'Bài hát sẽ xuất hiện sau khi nghệ sĩ hoàn tất xử lý và phát hành.',
      )}
      icon="music"
      action={<NavigationAction href="/new-releases">{tr('Mới phát hành')}</NavigationAction>}
    />
  );
}

function VisitorRecommendations() {
  const { t: tr } = useI18n();
  const [preferences, setPreferences] = useState<MusicPreferences | null>(null),
    [editorOpen, setEditorOpen] = useState<boolean | null>(null),
    [manual, setManual] = useState(false),
    [storageWarning, setStorageWarning] = useState(false);
  const editRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setPreferences(readVisitorPreferences());
    const update = (event: StorageEvent) => {
      if (event.key === visitorPreferencesKey || event.key === null) {
        setPreferences(readVisitorPreferences());
        setEditorOpen(null);
      }
    };
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, []);
  const result = useQuery({
    queryKey: [
      'recommendations',
      'visitor',
      preferences?.status,
      preferences?.genreIds,
      preferences?.artistIds,
    ],
    queryFn: ({ signal }) =>
      api<Recommendations>('/recommendations/preview', {
        method: 'POST',
        auth: false,
        signal,
        body: preferences
          ? { genreIds: preferences.genreIds, artistIds: preferences.artistIds }
          : emptyMusicChoices,
      }),
    enabled: !!preferences,
  });
  const initialSurvey = preferences?.status === 'NEW';
  const open = editorOpen ?? initialSurvey;
  const closeFocus = () =>
    requestAnimationFrame(() => editRef.current?.focus({ preventScroll: true }));
  const apply = (choices: MusicChoices) => {
    const saved = saveVisitorPreferences(choices);
    setPreferences(saved.preferences);
    setStorageWarning(!saved.persisted);
    setEditorOpen(false);
    closeFocus();
  };
  return (
    <>
      <RecommendationHeading
        source={result.data?.source}
        editRef={editRef}
        disabled={!preferences}
        onEdit={() => {
          setManual(true);
          setEditorOpen(true);
        }}
      />
      {preferences && open && (
        <MusicPreferenceSurvey
          initial={preferences}
          initialSurvey={initialSurvey}
          visitor
          manual={manual}
          onSave={async (choices) => apply(choices)}
          onClose={() => {
            if (initialSurvey) apply(emptyMusicChoices);
            else {
              setEditorOpen(false);
              closeFocus();
            }
          }}
        />
      )}{' '}
      {storageWarning && (
        <p className="music-survey-note" role="status">
          {tr('Trình duyệt chưa thể lưu sở thích. Lựa chọn vẫn áp dụng trong lần truy cập này.')}
        </p>
      )}
      <RecommendationResults result={result} />
    </>
  );
}

function AccountRecommendations({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const [editorOpen, setEditorOpen] = useState<boolean | null>(null),
    [manual, setManual] = useState(false),
    [dismissError, setDismissError] = useState<Error | null>(null),
    [saving, setSaving] = useState(false);
  const editRef = useRef<HTMLButtonElement>(null),
    request = useRef<AbortController | null>(null),
    alive = useRef(true),
    returnFocus = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);
  const profile = useQuery({
    queryKey: ['music-preferences', userId],
    queryFn: ({ signal }) => api<MusicPreferences>('/me/music-preferences', { signal }),
  });
  const result = useQuery({
    queryKey: ['recommendations', userId],
    queryFn: ({ signal }) => api<Recommendations>('/recommendations', { signal }),
  });
  const telemetry = useRecommendationTelemetry({
    requestId: result.data?.requestId,
    impressionToken: result.data?.impressionToken,
    surface: 'home',
    tracks: result.data?.items.slice(0, 5) ?? [],
    enabled: true,
  });
  const initialSurvey = profile.data?.status === 'NEW' && !profile.data.hasLikedPreferences;
  const open = editorOpen ?? initialSurvey;
  useEffect(() => {
    if (profile.data) setEditorOpen((previous) => previous ?? initialSurvey);
  }, [profile.data, initialSurvey]);
  useEffect(() => {
    if (!open && !saving && returnFocus.current) {
      returnFocus.current = false;
      editRef.current?.focus({ preventScroll: true });
    }
  }, [open, saving]);
  const closeFocus = () => {
    returnFocus.current = true;
  };
  const apply = async (choices: MusicChoices) => {
    request.current?.abort();
    const abort = new AbortController();
    request.current = abort;
    setDismissError(null);
    setSaving(true);
    try {
      const saved = await api<MusicPreferences>('/me/music-preferences', {
        method: 'PUT',
        body: choices,
        signal: abort.signal,
      });
      if (!alive.current || abort.signal.aborted) return;
      queryClient.setQueryData(['music-preferences', userId], saved);
      setEditorOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['recommendations', userId] });
      closeFocus();
    } finally {
      if (request.current === abort) {
        request.current = null;
        if (alive.current) setSaving(false);
      }
    }
  };
  const close = () => {
    setEditorOpen(false);
    closeFocus();
    if (initialSurvey)
      void apply(emptyMusicChoices).catch((error) => {
        if (alive.current && !(error instanceof DOMException && error.name === 'AbortError'))
          setDismissError(
            error instanceof Error
              ? error
              : new Error('Không thể hoàn tất yêu cầu. Kiểm tra thông tin và thử lại.'),
          );
      });
  };
  return (
    <>
      <RecommendationHeading
        source={result.data?.source}
        editRef={editRef}
        disabled={!profile.data || saving}
        more
        onEdit={() => {
          setManual(true);
          setEditorOpen(true);
        }}
      />
      {profile.isError && <ErrorState error={profile.error} retry={() => void profile.refetch()} />}{' '}
      {dismissError && (
        <ErrorState
          error={dismissError}
          retry={() =>
            void apply(emptyMusicChoices).catch((error) => setDismissError(error as Error))
          }
        />
      )}{' '}
      {profile.data && open && (
        <MusicPreferenceSurvey
          initial={profile.data}
          initialSurvey={initialSurvey}
          manual={manual}
          onSave={apply}
          onClose={close}
        />
      )}
      <RecommendationResults result={result} telemetry={telemetry} />
    </>
  );
}

export function RecommendationsSection() {
  const { user, loading } = useAuth();
  return (
    <section
      className="catalog-section recommendation-section"
      aria-labelledby="home-recommendations-title"
    >
      {loading ? (
        <>
          <RecommendationHeading />
          <Loading />
        </>
      ) : user ? (
        <AccountRecommendations key={user.id} userId={user.id} />
      ) : (
        <VisitorRecommendations />
      )}
    </section>
  );
}
