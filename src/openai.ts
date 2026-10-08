// Конвертация между контрактами Ollama и OpenAI (§18 п.1 ТЗ).
//
// Раньше /v1/chat/completions всегда отдавал симулированный ответ. Теперь
// запрос конвертируется в формат Ollama /api/chat, проксируется на выбранный
// узел, а ответ конвертируется обратно — в стриминге (SSE chat.completion.chunk)
// и в обычном режиме (chat.completion с usage).

export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; text?: string }>;
  tool_calls?: any[];
}

export interface OpenAiChatRequest {
  model: string;
  messages: OpenAiMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  seed?: number;
  user?: string;
}

function flattenContent(content: OpenAiMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && part.type === 'text' ? part.text || '' : ''))
      .join('');
  }
  return '';
}

// OpenAI-сообщение → Ollama-сообщение. system-промпты Ollama передаёт
// отдельным полем, но /api/chat принимает и role: 'system' — оставляем
// совместимый вид.
export function toOllamaChatRequest(req: OpenAiChatRequest): Record<string, any> {
  const messages = (req.messages || []).map((m) => ({
    role: m.role,
    content: flattenContent(m.content),
  }));

  const options: Record<string, any> = {};
  if (typeof req.temperature === 'number') options.temperature = req.temperature;
  if (typeof req.top_p === 'number') options.top_p = req.top_p;
  if (typeof req.frequency_penalty === 'number') options.repeat_penalty = req.frequency_penalty;
  if (typeof req.presence_penalty === 'number') options.presence_penalty = req.presence_penalty;
  if (typeof req.seed === 'number') options.seed = req.seed;
  if (typeof req.max_tokens === 'number') options.num_predict = req.max_tokens;
  if (typeof req.max_completion_tokens === 'number') options.num_predict = req.max_completion_tokens;
  if (typeof req.stop === 'string') options.stop = [req.stop];
  else if (Array.isArray(req.stop)) options.stop = req.stop;

  return {
    model: req.model,
    messages,
    stream: req.stream === true,
    options,
  };
}

// Ollama NDJSON-чанк стрима → SSE-чанк chat.completion.chunk.
export function ollamaChunkToOpenAiChunk(
  chunk: any,
  model: string,
  id: string
): Record<string, any> | null {
  if (!chunk || typeof chunk !== 'object') return null;

  const delta: Record<string, any> = {};
  if (chunk.message && typeof chunk.message.content === 'string') {
    delta.content = chunk.message.content;
  }
  if (chunk.done) {
    return {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: chunk.done_reason || 'stop',
        },
      ],
      usage: buildUsage(chunk),
    };
  }

  if (!delta.content) return null;

  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: null,
      },
    ],
  };
}

function buildUsage(chunk: any): Record<string, number> | undefined {
  const prompt = chunk.prompt_eval_count;
  const completion = chunk.eval_count;
  if (typeof prompt !== 'number' && typeof completion !== 'number') return undefined;
  return {
    prompt_tokens: prompt || 0,
    completion_tokens: completion || 0,
    total_tokens: (prompt || 0) + (completion || 0),
  };
}

// Финальный агрегированный ответ для не-стримингового режима: накапливает
// содержимое из NDJSON-чанков и строит один chat.completion объект.
export interface AggregatedChat {
  content: string;
  model: string;
  finishReason: string;
  usage?: Record<string, number>;
}

export function aggregateOllamaChat(chunks: any[], model: string): AggregatedChat {
  let content = '';
  let finishReason = 'stop';
  let usage: Record<string, number> | undefined;
  let lastModel = model;

  for (const chunk of chunks) {
    if (!chunk) continue;
    if (chunk.model) lastModel = chunk.model;
    if (chunk.message && typeof chunk.message.content === 'string') {
      content += chunk.message.content;
    }
    if (chunk.done) {
      finishReason = chunk.done_reason || 'stop';
      const u = buildUsage(chunk);
      if (u) usage = u;
    }
  }

  return { content, model: lastModel, finishReason, usage };
}

// Конвертация ответа Ollama /api/generate (не-стрим) в формат OpenAI.
export function ollamaGenerateToOpenAiCompletion(generate: any, model: string, id: string): Record<string, any> {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor((generate.created_at ? Date.parse(generate.created_at) : Date.now()) / 1000),
    model: generate.model || model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: generate.response || '' },
        finish_reason: generate.done ? 'stop' : 'length',
      },
    ],
    usage: {
      prompt_tokens: generate.prompt_eval_count || 0,
      completion_tokens: generate.eval_count || 0,
      total_tokens: (generate.prompt_eval_count || 0) + (generate.eval_count || 0),
    },
  };
}
