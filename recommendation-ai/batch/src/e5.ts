import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { BATCH_SIZE, E5_DTYPE, E5_MODEL, E5_REVISION, type Embedder, MAX_TOKENS, e5ModelId } from './embedder';

/**
 * multilingual-e5-small via @huggingface/transformers (ONNX, CPU). Mean pooling + L2 normalisation;
 * the tokenizer truncates each text to 256 tokens. With RECO_MODEL_DIR set, weights are read from
 * `${RECO_MODEL_DIR}/Xenova/multilingual-e5-small/` and remote download is disabled.
 */
export async function loadE5(): Promise<Embedder> {
  // Dynamic import keeps the heavy dependency out of commands that do not need it.
  const hf = (await import('@huggingface/transformers')) as typeof import('@huggingface/transformers');
  const dir = process.env.RECO_MODEL_DIR;
  if (dir) {
    if (!existsSync(join(dir, E5_MODEL, 'config.json')))
      throw new Error(`RECO_MODEL_DIR is set but ${join(dir, E5_MODEL, 'config.json')} does not exist`);
    hf.env.localModelPath = dir;
    hf.env.allowLocalModels = true;
    hf.env.allowRemoteModels = false;
  }
  const options = {
    revision: E5_REVISION,
    local_files_only: !!dir,
  };
  const tokenizer = await hf.AutoTokenizer.from_pretrained(E5_MODEL, options);
  const model = await hf.AutoModel.from_pretrained(E5_MODEL, {
    ...options,
    dtype: E5_DTYPE as never,
    session_options: { intraOpNumThreads: Number(process.env.RECO_THREADS || 1), interOpNumThreads: 1 },
  });
  let dims = 0;
  const embed = async (texts: string[]): Promise<Float32Array[]> => {
    const out: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += BATCH_SIZE) {
      const batch = texts.slice(start, start + BATCH_SIZE);
      const inputs = tokenizer(batch, { padding: true, truncation: true, max_length: MAX_TOKENS });
      const result = await model(inputs);
      const pooled = hf.mean_pooling(result.last_hidden_state, inputs.attention_mask).normalize(2, -1);
      const [rows, cols] = pooled.dims as number[];
      const data = pooled.data as Float32Array;
      dims = cols;
      for (let r = 0; r < rows; r += 1) out.push(Float32Array.from(data.subarray(r * cols, (r + 1) * cols)));
    }
    return out;
  };
  const probe = await embed(['passage: kiểm tra']);
  dims = probe[0].length;
  return { modelId: e5ModelId(), dims, kind: 'e5', embed };
}
