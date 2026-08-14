// Converts one raw JSONL line + its file context into a normalized RequestRecord, or a reason it was
// not one (corrupt JSON, non-assistant line, synthetic client-side error message, missing usage).
//
// Fields consciously kept minimal/small: this object is what corpus-wide dedupe (dedupe.js) holds one
// per distinct message.id in memory for the whole scan, so it must stay cheap even at hundreds of
// thousands of records.
export function parseLine(rawLine, context) {
  let obj;
  try {
    obj = JSON.parse(rawLine);
  } catch {
    return { kind: 'corrupt' };
  }

  if (obj.type !== 'assistant' || !obj.message || !obj.message.usage) {
    return { kind: 'other', obj };
  }

  const message = obj.message;
  if (message.model === '<synthetic>') {
    return { kind: 'synthetic' };
  }
  if (!message.id) {
    return { kind: 'other', obj };
  }

  const usage = message.usage;
  const meta = context.meta ?? null;

  const record = {
    messageId: message.id,
    timestamp: obj.timestamp ?? null,
    requestId: obj.requestId ?? null,
    sessionId: obj.sessionId ?? context.sessionId,
    project: context.project,
    tier: context.tier,
    agentId: obj.agentId ?? context.agentId ?? null,
    agentType: meta?.agentType ?? null,
    model: message.model ?? meta?.model ?? null,
    effort: obj.effort ?? null,
    isSidechain: obj.isSidechain ?? context.tier !== 'main',
    version: obj.version ?? null,
    usage: {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      serviceTier: usage.service_tier ?? null,
      speed: usage.speed ?? null,
      inferenceGeo: usage.inference_geo ?? null,
    },
  };

  return { kind: 'record', record, obj };
}

export function totalTokens(record) {
  const u = record.usage;
  return u.inputTokens + u.outputTokens + u.cacheCreationTokens + u.cacheReadTokens;
}
