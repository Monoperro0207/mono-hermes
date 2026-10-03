/**
 * Minimal OpenAI-compatible chat-completions server used by the UI audit.
 *
 * The throwaway Hermes home is configured (seed.py) with a `custom` provider that points here,
 * so the real gateway runs real turns - streaming, reasoning, tool calls, approval and clarify
 * prompts, errors - without any real model or network. Behaviour is selected by a marker in
 * the LAST user message:
 *
 *   @@think     reasoning deltas then a markdown answer, slowly (screenshot the streaming state)
 *   @@slow      a long answer trickled very slowly (stays "running" for ~60 s)
 *   @@approval  tool call `terminal` with a dangerous command -> approval prompt (never approved)
 *   @@clarify   tool call `clarify` with choices -> clarify prompt
 *   @@activity  reasoning + parallel tool calls (2 terminal commands - one long-running - and text_to_speech), then an answer
 *   @@error     HTTP 500 -> error banner
 *   (none)      short markdown answer
 *
 * Nothing is executed on the host: approval/clarify turns block on the human, and the audit
 * never approves.
 */
import http from 'node:http'

const sleep = ms => new Promise(r => setTimeout(r, ms))

const LONG_MD = `Here is a **streaming** answer with \`inline code\`.

1. First point
2. Second point

\`\`\`ts
const answer: number = 42 // streamed code block that keeps growing while you look at it
\`\`\`

| col a | col b |
|-------|-------|
| 1 | 2 |
`

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user') {
      if (typeof m.content === 'string') return m.content
      if (Array.isArray(m.content)) return m.content.map(p => p.text || '').join('\n')
    }
  }
  return ''
}

function hasToolResult(messages) {
  return messages.length > 0 && messages[messages.length - 1].role === 'tool'
}

export function startMockLlm(port = 47831) {
  const aborted = new Set()
  const server = http.createServer(async (req, res) => {
    const url = req.url || ''
    if (req.method === 'GET' && url.includes('/models')) {
      res.setHeader('content-type', 'application/json')
      return void res.end(JSON.stringify({ object: 'list', data: [{ id: 'audit-model', object: 'model', owned_by: 'audit' }] }))
    }
    if (req.method !== 'POST' || !url.includes('/chat/completions')) {
      res.statusCode = 404
      return void res.end('{}')
    }
    let body = ''
    for await (const chunk of req) body += chunk
    let json = {}
    try {
      json = JSON.parse(body)
    } catch {}
    const messages = json.messages || []
    const marker = lastUserText(messages)
    const stream = !!json.stream
    const id = 'chatcmpl-' + Math.random().toString(36).slice(2)
    const tools = (json.tools || []).map(t => t.function?.name)

    const sse = chunk => res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    const base = delta => ({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'audit-model', choices: [{ index: 0, delta, finish_reason: null }] })
    const finish = reason => ({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'audit-model', choices: [{ index: 0, delta: {}, finish_reason: reason }], usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 } })

    let closed = false
    req.on('close', () => {
      closed = true
    })

    if (marker.includes('@@error') && !hasToolResult(messages)) {
      res.statusCode = 500
      res.setHeader('content-type', 'application/json')
      return void res.end(JSON.stringify({ error: { message: 'Audit mock: simulated upstream failure with a deliberately long error message that should wrap on narrow screens without breaking the layout.', type: 'server_error' } }))
    }

    const toolCall = (name, args) => ({ index: 0, id: 'call_' + Math.random().toString(36).slice(2, 10), type: 'function', function: { name, arguments: JSON.stringify(args) } })

    let plan // { reasoning?, text?, tool?, delay }
    if (!hasToolResult(messages) && marker.includes('@@approval') && tools.includes('terminal')) {
      plan = { text: 'I will remove the temporary directory.', tool: toolCall('terminal', { command: 'rm -rf ./audit-tmp-dir-that-does-not-exist' }), delay: 10 }
    } else if (!hasToolResult(messages) && marker.includes('@@clarify') && tools.includes('clarify')) {
      plan = {
        tool: toolCall('clarify', {
          questions: [
            { question: 'Which environment should I deploy to? Pick one of the options below or type your own answer.', choices: ['staging', 'production', 'a very long option label that keeps going to see how choice buttons wrap on a phone'] },
            { question: 'Which checks should run before the deploy?', choices: ['lint', 'unit tests', 'e2e'], multi_select: true }
          ]
        }),
        delay: 10
      }
    } else if (!hasToolResult(messages) && marker.includes('@@activity')) {
      plan = {
        reasoning: 'Let me plan the steps: list the changelog, run a slow check, then read the summary aloud with the text to speech tool. '.repeat(2),
        text: 'Running the commands and the speech tool now.',
        tools: [
          toolCall('terminal', { command: 'echo changelog' }),
          toolCall('terminal', { command: 'python -c "import time; time.sleep(40)"', timeout: 60 }),
          toolCall('text_to_speech', { text: 'Changelog summary: three fixes and one feature.' })
        ],
        delay: 20
      }
    } else if (marker.includes('@@think')) {
      plan = { reasoning: 'Let me think about this carefully. First I consider the constraints of a narrow viewport, then the trade offs between wrapping and truncating text, and finally how tool output cards should behave. '.repeat(2), text: LONG_MD, delay: 120 }
    } else if (marker.includes('@@slow')) {
      plan = { text: (LONG_MD + '\n').repeat(12), delay: 400 }
    } else {
      plan = { text: 'Understood. This is a short audit reply with **bold**, `code` and a [link](https://example.com).', delay: 5 }
    }

    if (!stream) {
      res.setHeader('content-type', 'application/json')
      const message = { role: 'assistant', content: plan.text ?? null }
      const allTools = plan.tools || (plan.tool ? [plan.tool] : [])
      if (allTools.length) message.tool_calls = allTools.map(t => ({ id: t.id, type: 'function', function: t.function }))
      return void res.end(JSON.stringify({ id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'audit-model', choices: [{ index: 0, message, finish_reason: (plan.tools || plan.tool) ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 } }))
    }

    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('cache-control', 'no-cache')
    sse(base({ role: 'assistant', content: '' }))
    const pieces = s => s.match(/.{1,24}/gs) || []
    if (plan.reasoning) {
      for (const p of pieces(plan.reasoning)) {
        if (closed) return
        sse(base({ reasoning_content: p }))
        await sleep(plan.delay)
      }
    }
    if (plan.text) {
      for (const p of pieces(plan.text)) {
        if (closed) return
        sse(base({ content: p }))
        await sleep(plan.delay)
      }
    }
    const streamTools = plan.tools || (plan.tool ? [plan.tool] : [])
    if (streamTools.length) sse(base({ tool_calls: streamTools.map((t, i) => ({ ...t, index: i })) }))
    sse(finish(streamTools.length ? 'tool_calls' : 'stop'))
    res.write('data: [DONE]\n\n')
    res.end()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve({ port, url: `http://127.0.0.1:${port}/v1`, close: () => new Promise(r => server.close(() => r())) }))
  })
}

if (process.argv[1] && process.argv[1].split('\\').join('/').endsWith('ui-audit/mock-llm.mjs')) {
  const s = await startMockLlm()
  console.log('mock llm on', s.url)
}
