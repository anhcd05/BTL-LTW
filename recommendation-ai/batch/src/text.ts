import { type Rng, pick } from './rng';

/**
 * Vietnamese synthetic copy. Templates are shared pools; each genre draws >= 10 templates from
 * every pool with heavy overlap between genres, and the slot words come from a mood vocabulary
 * driven by the track's latent mood. Text therefore carries mood signal and a weak genre signal,
 * but embeddings cannot separate genres purely by template.
 */
export const MOOD_DIMS = ['energy', 'valence', 'acoustic', 'nostalgia'] as const;

const MOOD_WORDS: Record<(typeof MOOD_DIMS)[number], { pos: string[]; neg: string[] }> = {
  energy: {
    pos: ['sôi động', 'cuồng nhiệt', 'bùng cháy', 'rộn ràng', 'hối hả', 'mãnh liệt'],
    neg: ['chậm rãi', 'lặng lẽ', 'êm đềm', 'dịu dàng', 'thong thả', 'bình yên'],
  },
  valence: {
    pos: ['rạng rỡ', 'hạnh phúc', 'tươi vui', 'ấm áp', 'lấp lánh', 'yêu đời'],
    neg: ['buồn', 'cô đơn', 'xa vắng', 'tan vỡ', 'u sầu', 'chơi vơi'],
  },
  acoustic: {
    pos: ['mộc mạc', 'giản dị', 'trong trẻo', 'thủ thỉ', 'mềm mại', 'nhẹ tênh'],
    neg: ['rực rỡ', 'neon', 'mạnh mẽ', 'dồn dập', 'lạnh lùng', 'chói lòa'],
  },
  nostalgia: {
    pos: ['hoài niệm', 'xưa cũ', 'phai màu', 'da diết', 'man mác', 'bồi hồi'],
    neg: ['mới mẻ', 'hiện đại', 'trẻ trung', 'bất tận', 'tự do', 'táo bạo'],
  },
};

const NOUNS = [
  'mưa', 'nắng', 'phố', 'con đường', 'giấc mơ', 'ánh đèn', 'biển', 'ngày xưa', 'trái tim', 'lá thư',
  'cơn gió', 'ánh trăng', 'bến đỗ', 'chuyến xe', 'mùa thu', 'góc phố', 'căn phòng', 'bầu trời',
  'dòng sông', 'ký ức', 'tiếng đàn', 'cánh diều', 'hạt bụi', 'vì sao',
];
const PLACES = ['Sài Gòn', 'Hà Nội', 'Đà Lạt', 'Huế', 'Hội An', 'phố cổ', 'ven sông', 'quê nhà', 'sân ga', 'ban công', 'Nha Trang', 'Cần Thơ'];
const TIMES = ['đêm nay', 'chiều nay', 'sáng mai', 'nửa đêm', 'cuối tuần', 'mùa hè', 'mùa đông', 'năm ấy', 'hoàng hôn', 'bình minh'];

type Slots = { N: string; N2: string; A: string; A2: string; P: string; T: string };
type Template = (s: Slots) => string;

const TITLE_POOL: Template[] = [
  (s) => `${cap(s.N)} ${s.A}`,
  (s) => `${cap(s.N)} ${s.P}`,
  (s) => `${cap(s.T)} ở ${s.P}`,
  (s) => `Chuyện ${s.N} ${s.T}`,
  (s) => `${cap(s.A)} như ${s.N}`,
  (s) => `Gửi ${s.N} ${s.T}`,
  (s) => `Một chút ${s.N}`,
  (s) => `${cap(s.N)} và ${s.N2}`,
  (s) => `Về ${s.P} ${s.T}`,
  (s) => `Khi ${s.N} ${s.A}`,
  (s) => `Đợi ${s.N}`,
  (s) => `${cap(s.N)} cuối cùng`,
  (s) => `Bản tình ca ${s.A}`,
  (s) => `Lời hứa ${s.T}`,
  (s) => `${s.P} ${s.A}`,
  (s) => `Theo ${s.N} về ${s.P}`,
  (s) => `Đừng quên ${s.N}`,
  (s) => `${cap(s.N)} không tên`,
  (s) => `Ngày ${s.N} ${s.A}`,
  (s) => `Đi qua ${s.N}`,
  (s) => `Hẹn ${s.T}`,
  (s) => `${cap(s.A)} ${s.T}`,
  (s) => `Mãi là ${s.N}`,
  (s) => `Cho ${s.N} ${s.A}`,
];

const DESCRIPTION_POOL: Template[] = [
  (s) => `Một bản nhạc ${s.A} về ${s.N} ${s.T}.`,
  (s) => `Viết trong một ${s.T} ở ${s.P}, ca khúc mang cảm giác ${s.A} và ${s.A2}.`,
  (s) => `${cap(s.N)} ${s.A}, dành cho những ai từng đi qua ${s.N2}.`,
  (s) => `Bài hát kể chuyện ${s.N} ở ${s.P}, giai điệu ${s.A}.`,
  (s) => `Thu âm tại ${s.P}, không khí ${s.A}.`,
  (s) => `Nghe vào ${s.T} để thấy ${s.N} ${s.A2}.`,
  (s) => `Một chút ${s.A}, một chút ${s.A2}, và rất nhiều ${s.N}.`,
  (s) => `Lấy cảm hứng từ ${s.N} và ${s.N2} của ${s.P}.`,
  (s) => `Ca khúc mới, ${s.A} từ đầu đến cuối.`,
  (s) => `Dành tặng ${s.N}: ${s.A}, ${s.A2}.`,
  (s) => `Giai điệu ${s.A} hợp để nghe lúc ${s.T}.`,
  (s) => `Câu chuyện về ${s.N2} trong ${s.T}, ${s.A}.`,
  (s) => `Phối khí ${s.A}, lời ca ${s.A2}.`,
  (s) => `Từ ${s.P} gửi đến bạn một ${s.N} ${s.A}.`,
];

const LYRIC_POOL: Template[] = [
  (s) => `Em đi qua ${s.N} ${s.T}`,
  (s) => `Anh vẫn nhớ ${s.N} ở ${s.P}`,
  (s) => `Trời ${s.A} như lòng ta`,
  (s) => `Ta hẹn nhau ${s.T}`,
  (s) => `${cap(s.N)} rơi trên vai áo`,
  (s) => `Có ai còn nhớ ${s.N2}`,
  (s) => `Lòng ${s.A} giữa ${s.P}`,
  (s) => `Bước chân về ${s.P}`,
  (s) => `Ngày mai ${s.N} sẽ ${s.A2}`,
  (s) => `Mình cứ hát thôi, ${s.A}`,
  (s) => `Thành phố ${s.A} đêm nay`,
  (s) => `Một mình với ${s.N}`,
  (s) => `Gió mang ${s.N} đi xa`,
  (s) => `Còn lại ${s.N2} và ta`,
  (s) => `Đêm ${s.A2}, ánh đèn ${s.P}`,
  (s) => `Nghe ${s.N} gọi tên`,
  (s) => `Cho ta thêm một ${s.T}`,
  (s) => `Mãi mãi là ${s.N}`,
];

/** A light genre "flavour" phrase; appears in only part of the descriptions. */
export const GENRE_FLAVOUR: Record<string, string> = {
  pop: 'giai điệu bắt tai',
  'v-pop': 'chất nhạc trẻ',
  ballad: 'tình ca sâu lắng',
  bolero: 'chất trữ tình',
  'r-and-b': 'groove mượt mà',
  'hip-hop': 'beat chắc nịch',
  rap: 'flow dồn dập',
  rock: 'guitar điện',
  indie: 'tự sáng tác',
  edm: 'những cú drop',
  'lo-fi': 'tiếng rè băng cassette',
  acoustic: 'guitar mộc',
  jazz: 'kèn saxophone',
  folk: 'âm hưởng dân ca',
  'k-pop': 'vũ đạo bắt mắt',
};

export const STUFFED_DESCRIPTION =
  'pop v-pop nhạc trẻ ballad k-pop edm hot trend top hit nhạc pop hay nhất bxh viral tiktok ' +
  'pop v-pop nhạc trẻ ballad k-pop edm hot trend top hit nhạc pop hay nhất bxh viral tiktok ' +
  'pop v-pop nhạc trẻ ballad k-pop edm hot hit trend';

function cap(text: string): string {
  return text.charAt(0).toLocaleUpperCase('vi-VN') + text.slice(1);
}

/** The template subset for a genre: >= 10 entries, overlapping heavily with other genres. */
export function genreTemplateIndices(genreIndex: number, poolSize: number, count: number): number[] {
  const out: number[] = [];
  for (let k = 0; out.length < count && k < poolSize * 3; k += 1) {
    const index = (genreIndex * 7 + k * 5) % poolSize; // step 5 is coprime with every pool size
    if (!out.includes(index)) out.push(index);
  }
  return out;
}

export const POOL_SIZES = { title: TITLE_POOL.length, description: DESCRIPTION_POOL.length, lyric: LYRIC_POOL.length };

function moodWord(rng: Rng, mood: readonly number[]): string {
  // Dominant mood dimensions are picked much more often (|m|^2), so the vocabulary tracks the latent mood.
  const weights = mood.map((m) => m * m + 0.02);
  const total = weights.reduce((a, b) => a + b, 0);
  let target = rng.next() * total;
  let dim = 0;
  for (; dim < weights.length - 1; dim += 1) {
    if (target < weights[dim]) break;
    target -= weights[dim];
  }
  const words = MOOD_WORDS[MOOD_DIMS[dim]];
  return pick(rng, mood[dim] >= 0 ? words.pos : words.neg);
}

function slots(rng: Rng, mood: readonly number[]): Slots {
  const N = pick(rng, NOUNS);
  let N2 = pick(rng, NOUNS);
  if (N2 === N) N2 = NOUNS[(NOUNS.indexOf(N) + 7) % NOUNS.length];
  const A = moodWord(rng, mood);
  let A2 = moodWord(rng, mood);
  if (A2 === A) A2 = moodWord(rng, mood);
  return { N, N2, A, A2, P: pick(rng, PLACES), T: pick(rng, TIMES) };
}

export type TrackCopy = { title: string; description: string; lyrics: string[] };

export function trackCopy(rng: Rng, genreIndex: number, genreId: string, mood: readonly number[]): TrackCopy {
  const titleIdx = genreTemplateIndices(genreIndex, TITLE_POOL.length, 11);
  const descIdx = genreTemplateIndices(genreIndex, DESCRIPTION_POOL.length, 10);
  const lyricIdx = genreTemplateIndices(genreIndex, LYRIC_POOL.length, 12);
  const title = TITLE_POOL[pick(rng, titleIdx)](slots(rng, mood));
  let description = DESCRIPTION_POOL[pick(rng, descIdx)](slots(rng, mood));
  // Mood leaks into the copy densely (as real lyrics carry mood); the genre flavour only rarely.
  description += ` Cảm giác ${moodWord(rng, mood)}, ${moodWord(rng, mood)} và ${moodWord(rng, mood)}.`;
  if (rng.next() < 0.3 && GENRE_FLAVOUR[genreId]) description += ` Điểm nhấn là ${GENRE_FLAVOUR[genreId]}.`;
  const lyrics: string[] = [];
  const shared = slots(rng, mood);
  for (let i = 0; i < 8; i += 1) {
    const s = rng.next() < 0.5 ? shared : slots(rng, mood);
    const line = LYRIC_POOL[pick(rng, lyricIdx)](s);
    lyrics.push(rng.next() < 0.6 ? `${line}, ${moodWord(rng, mood)}` : line);
  }
  return { title, description, lyrics };
}
