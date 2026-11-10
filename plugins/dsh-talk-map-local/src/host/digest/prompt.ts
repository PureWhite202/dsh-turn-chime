/**
 * Digest prompt: two fields (summary + key findings), strict JSON, the
 * conversation's own language. The old "nextStep" field was removed — the
 * card no longer shows a next step and the model is asked for the summary
 * only (and the findings that belong to it).
 */

export const DIGEST_SYSTEM_PROMPT = [
  'You are a conversation digester for a visual conversation map.',
  'Read the conversation transcript and output STRICT JSON, nothing else:',
  '{"summary": string, "keyFindings": string[]}',
  '',
  'Rules:',
  '- Use the language the conversation itself is in (Chinese conversation → Chinese output).',
  '- summary: what this conversation is about and where it stands, ≤120 characters.',
  '- keyFindings: at most 5 short bullet strings — decisions made, facts established, artifacts produced.',
  '- Output raw JSON only: no markdown fences, no commentary.',
].join('\n')

export function digestUserPrompt(transcript: string): string {
  return `Conversation transcript (oldest first):\n\n${transcript}\n\nOutput the JSON digest now.`
}

export interface ParsedDigest {
  summary: string
  keyFindings: string[]
}

/** Tolerant parse: strips fences, grabs the outermost object, validates shape. */
export function parseDigestOutput(raw: string): ParsedDigest {
  let text = raw.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim()
  }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('digest output contains no JSON object')
  const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<ParsedDigest>
  if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.keyFindings)) {
    throw new Error('digest output missing required fields')
  }
  return {
    summary: parsed.summary.slice(0, 300),
    keyFindings: parsed.keyFindings
      .filter((finding): finding is string => typeof finding === 'string')
      .slice(0, 5)
      .map(finding => finding.slice(0, 200)),
  }
}
