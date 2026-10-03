"""Seed the THROWAWAY Hermes home (.cache/hm) with sessions that stress the mobile layout.

Never run against a real Hermes home: it refuses any HERMES_HOME that is not inside a
`.cache` directory. Pure stdlib (plain sqlite3 against the schema `hermes serve` created on
a previous start, so it needs no Hermes Python environment):

    HERMES_HOME=<repo>/.cache/hm python seed.py <mock-llm-base-url>

The server must be STOPPED while seeding. Idempotent: it restores a pristine schema-only
template (state.db.template, made once by run.mjs) and inserts the fixtures into it.
"""

from __future__ import annotations

import base64
import json
import os
import struct
import sys
import time
import zlib
from pathlib import Path

HOME = Path(os.environ["HERMES_HOME"]).resolve()
if ".cache" not in HOME.parts:
    sys.exit(f"refusing to seed {HOME}: not a throwaway .cache home")

MOCK_URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:47831/v1"

import shutil  # noqa: E402

DB_PATH = HOME / "state.db"
TEMPLATE = HOME / "state.db.template"
if not TEMPLATE.exists():
    sys.exit("state.db.template missing: run through ui-audit/run.mjs (it creates the schema template once)")
for suffix in ("", "-wal", "-shm"):
    try:
        (HOME / f"state.db{suffix}").unlink()
    except FileNotFoundError:
        pass
shutil.copyfile(TEMPLATE, DB_PATH)

(HOME / "config.yaml").write_text(
    f"""onboarding:
  seen:
    profile_build_offered: true
model:
  provider: custom
  default: audit-model
  base_url: {MOCK_URL}
  api_key: sk-audit-not-a-real-key
  context_length: 128000
agent:
  max_turns: 6
display:
  streaming: true
""",
    encoding="utf-8",
)

import sqlite3  # noqa: E402
import uuid  # noqa: E402

db = sqlite3.connect(DB_PATH)
NOW = time.time()
DAY = 86400.0


def png_data_url(w: int, h: int) -> str:
    rows = b""
    for y in range(h):
        rows += b"\x00" + b"".join(
            bytes((int(255 * x / w), int(255 * y / h), 180)) for x in range(w)
        )

    def chunk(tag: bytes, data: bytes) -> bytes:
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )
    return "data:image/png;base64," + base64.b64encode(raw).decode()


IMG = png_data_url(900, 420)


def session(sid, title, msgs, *, age=0.0, cwd=None, branch=None, pinned=0, archived=0, model="audit-model", source="tui"):
    started = NOW - age
    t = started
    n_tools = 0
    for m in msgs:
        t += 7.0
        role = m["role"]
        tcs = m.get("tool_calls")
        if tcs:
            n_tools += len(tcs)
        db.execute(
            "INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, finish_reason, reasoning, reasoning_content, message_uid) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (sid, role, m.get("content"), m.get("tool_call_id"), json.dumps(tcs) if tcs else None, m.get("tool_name"), t,
             m.get("finish_reason"), m.get("reasoning"), m.get("reasoning_content"), uuid.uuid4().hex),
        )
    db.execute(
        "INSERT INTO sessions (id, source, model, cwd, started_at, last_activity_at, message_count, tool_call_count, title, title_source, pinned, archived, git_branch) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (sid, source, model, cwd, started, t, len(msgs), n_tools, title, "user", pinned, archived, branch),
    )


def user(text):
    return dict(role="user", content=text)


def asst(text, **kw):
    return dict(role="assistant", content=text, **kw)


def call(cid, name, args):
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}


def tool(cid, name, result):
    return dict(role="tool", tool_call_id=cid, tool_name=name, content=result if isinstance(result, str) else json.dumps(result, ensure_ascii=False))


# ------------------------------------------------------------------ content
LONG_URL = "https://example.com/" + "very-long-path-segment-with-no-break-opportunity/" * 4 + "?utm_source=audit&utm_medium=mobile&token=" + "A1b2C3d4E5f6" * 8
UNBROKEN = "SuperCalifragilisticoEspialidosoSuperCalifragilisticoEspialidosoSuperCalifragilistico" * 3

MARKDOWN = f"""# Mobile layout showcase

This reply exercises **every markdown construct** the renderer supports: *emphasis*, ~~strike~~, `inline code`, [links]({LONG_URL}), and a long unbroken token: `{UNBROKEN}`.

## Lists

1. First ordered item with a fairly long sentence that has to wrap across several lines on a narrow phone cover screen.
2. Second item
   - nested bullet one
   - nested bullet two with `code` and **bold**
     - third level nesting that eats horizontal space

- [x] done task
- [ ] open task

> A block quote that is long enough to wrap onto multiple lines, to check that its left border and padding do not squeeze the text into a one-character column.

## Table

| Id | Name | Description | Status | Owner | Created | Updated | Score |
|----|------|-------------|--------|-------|---------|---------|-------|
| 1 | alpha | The first row has a rather long description cell | open | ana | 2026-01-01 | 2026-02-03 | 0.91 |
| 2 | beta | Short | closed | bob | 2026-01-02 | 2026-02-04 | 0.12 |
| 3 | gamma | Another description {UNBROKEN} | wip | carla | 2026-01-03 | 2026-02-05 | 0.55 |

## Code

```python
def fibonacci(n: int) -> list[int]:
    \"\"\"Return the first n Fibonacci numbers -- this line is intentionally very long so that it overflows a phone screen horizontally and must scroll.\"\"\"
    a, b = 0, 1
    out = []
    for _ in range(n):
        out.append(a)
        a, b = b, a + b
    return out
```

```bash
curl -fsSL https://example.com/install.sh | bash -s -- --prefix "$HOME/.local" --channel nightly --verbose --no-modify-path --yes
```

```json
{{"name": "hermes-mobile", "version": "0.1.0", "scripts": {{"build": "vite build", "test": "vitest run"}}}}
```

```diff
- const old = 1
+ const next = 2
```

```
plain fenced block without a language
```

## Math

Inline $E = mc^2$ and a block:

$$
\\int_0^\\infty e^{{-x^2}}\\,dx = \\frac{{\\sqrt{{\\pi}}}}{{2}}
$$

## Diagram

```mermaid
graph TD
  A[Phone] --> B{{Tailscale}}
  B --> C[hermes serve]
  C --> D[(state.db)]
  C --> E[Model provider]
```

## Image

![A generated gradient]({IMG})

---

Final paragraph with a footnote-like trailing sentence.
"""

I18N = """## Texto internacional

Español con acentos: ¿Qué tal estás? Ñandú, canción, pingüino, óptimo, árbol, café.

日本語のテキスト：これは長い日本語の文章で、スマートフォンの狭い画面でも正しく折り返されるかどうかを確認するためのものです。
中文文本：这是一段很长的中文文字，用来检查在狭窄的手机屏幕上是否能够正确换行而不会被截断。
한국어 텍스트: 이 문장은 좁은 휴대폰 화면에서 줄바꿈이 올바르게 되는지 확인하기 위한 것입니다.

العربية: هذا نص طويل باللغة العربية لاختبار الاتجاه من اليمين إلى اليسار وكيفية التفاف النص على شاشة الهاتف الضيقة.
עברית: זהו טקסט ארוך בעברית לבדיקת כיוון מימין לשמאל.

Emoji: 🚀🔥✨ 👨‍👩‍👧‍👦 🏳️‍🌈 ❤️ 👍🏽 — mixed with text 😀 in the middle of a sentence.

Mixed direction: the word مرحبا appears inside an English sentence, and 123 numbers.

URL: """ + LONG_URL + """

Unbroken: """ + UNBROKEN + """

`inline-code-that-is-extremely-long-and-has-no-spaces-so-it-must-wrap-or-scroll-without-breaking-the-layout-of-the-message-bubble`
"""

REASONING = "The user wants a comparison. First I should consider the trade-offs between a local WebView and a remote renderer. The WebView approach keeps the UI identical, which matters because the desktop app is the source of truth. Then consider latency over Tailscale, which is typically 20-60 ms. Finally compare the maintenance cost: every upstream bump requires re-auditing the layout."

TERMINAL_OUT = "\n".join(f"drwxr-xr-x  2 user user 4096 Oct  2 10:{i:02d} directory-with-a-long-name-number-{i}" for i in range(40))

sessions = []

# 1. Markdown showcase
session("aud-md", "Markdown showcase: tables, code, math, mermaid, images", [
    user("Show me every markdown feature you support, including a very wide table and a diagram."),
    asst(MARKDOWN),
    user("Thanks! Now a short reply please."),
    asst("Sure -- here is a short reply."),
], age=300, cwd="C:\\Users\\demo\\code\\hermes-mobile", branch="main")

# 2. International text
session("aud-i18n", "Texto internacional 日本語 中文 العربية 🚀 emoji", [
    user("¿Puedes escribir texto en varios idiomas? 日本語、中文、العربية y emoji 🚀"),
    asst(I18N),
    user("שלום, מה שלומך? " + UNBROKEN),
    asst("Muy bien, gracias. 😀 " + LONG_URL),
], age=900, cwd="C:\\Users\\demo\\code\\i18n")

# 3. Tool calls zoo
tc = [
    ("t1", "terminal", {"command": "ls -la /very/long/path/to/some/directory/with/many/nested/segments && echo done", "timeout": 30}, {"output": TERMINAL_OUT, "exit_code": 0, "error": None}),
    ("t2", "read_file", {"path": "/home/user/project/src/components/very/deeply/nested/directory/structure/Component.tsx", "offset": 1, "limit": 40}, {"content": "\n".join(f"{i:6d}|const line{i} = {i} // a long comment line to test wrapping in tool output cards on narrow screens" for i in range(1, 41)), "total_lines": 120, "file_size": 5120}),
    ("t3", "write_file", {"path": "/home/user/project/README.md", "content": "# Title\n\nSome content\n" * 20}, {"bytes_written": 440, "dirs_created": False}),
    ("t4", "patch", {"path": "/home/user/project/src/app.ts", "old_string": "const a = 1", "new_string": "const a = 2"}, {"success": True, "diff": "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,3 +1,3 @@\n-const a = 1\n+const a = 2\n const b = 3\n"}),
    ("t5", "search_files", {"pattern": "TODO", "path": "/home/user/project", "target": "content"}, {"matches": [{"path": f"/home/user/project/src/file{i}.ts", "line": i * 3, "content": f"// TODO: handle edge case number {i} with a long explanatory comment"} for i in range(1, 12)], "total_count": 11}),
    ("t6", "web_search", {"query": "capacitor android webview safe area insets samsung fold"}, {"data": {"web": [{"title": f"Result {i}: A very long result title about Capacitor and Android foldable layouts", "url": f"https://example.com/articles/{i}", "description": "Description text that goes on for a while to check wrapping inside cards."} for i in range(1, 6)]}}),
    ("t7", "web_extract", {"urls": [LONG_URL]}, {"results": [{"url": LONG_URL, "title": "Extracted page", "content": "Lorem ipsum dolor sit amet " * 40}]}),
    ("t8", "todo", {"todos": [{"id": "1", "content": "Audit cover screen layout", "status": "completed"}, {"id": "2", "content": "Fix settings modal at phone width with a deliberately long todo description that wraps", "status": "in_progress"}, {"id": "3", "content": "Rebuild APK", "status": "pending"}]}, {"todos": [{"id": "1", "content": "Audit cover screen layout", "status": "completed"}, {"id": "2", "content": "Fix settings modal", "status": "in_progress"}, {"id": "3", "content": "Rebuild APK", "status": "pending"}], "summary": {"total": 3}}),
    ("t9", "execute_code", {"code": "import json\nprint(json.dumps({'a': 1}))\n" * 6}, {"output": "{\"a\": 1}\n" * 6, "exit_code": 0}),
    ("t10", "delegate_task", {"goal": "Research foldable display APIs and summarize", "context": "Samsung Galaxy Z Fold4"}, {"results": [{"status": "completed", "summary": "Fold4 reports 344x882 CSS px folded and 829x690 unfolded."}]}),
    ("t11", "memory", {"action": "add", "target": "memory", "content": "User prefers terse answers"}, {"success": True, "message": "Saved"}),
    ("t12", "skill_view", {"name": "systematic-debugging"}, {"success": True, "name": "systematic-debugging", "description": "Debugging methodology", "content": "# Systematic debugging\n\nStep 1..."}),
    ("t13", "browser_navigate", {"url": LONG_URL}, {"success": True, "url": LONG_URL, "title": "Example"}),
    ("t14", "vision_analyze", {"image_url": "https://example.com/a.png", "question": "What is in this image?"}, {"analysis": "A gradient from purple to blue."}),
    ("t15", "image_generate", {"prompt": "a gradient", "aspect_ratio": "landscape"}, {"success": True, "image": "https://example.com/generated/gradient.png"}),
    ("t16", "terminal", {"command": "false"}, {"output": "bash: error: command failed with a long error message that wraps", "exit_code": 1, "error": "exit status 1"}),
    ("t17", "some_unknown_mcp_tool", {"query": "x", "options": {"deep": True, "list": [1, 2, 3]}}, {"ok": True, "items": list(range(30))}),
    ("t18", "cronjob", {"action": "create", "schedule": "0 9 * * *", "prompt": "Daily summary"}, {"success": True, "job_id": "abc123"}),
    ("t19", "process", {"action": "list"}, {"processes": []}),
    ("t20", "clarify", {"question": "Which option?", "choices": ["A", "B"]}, {"answer": "A"}),
]
msgs = [user("Run a bunch of tools so I can see how each tool card looks.")]
msgs.append(asst("I'll run a sequence of tools now.", tool_calls=[call(c[0], c[1], c[2]) for c in tc], finish_reason="tool_calls", reasoning=REASONING))
for c in tc:
    msgs.append(tool(c[0], c[1], c[3]))
msgs.append(asst("All tools finished. Summary: the **terminal** listing succeeded, `read_file` returned 40 lines, the patch applied, and one command failed intentionally."))
session("aud-tools", "Tool cards: terminal, files, web, todo, delegate, unknown MCP", msgs, age=1800, cwd="C:\\Users\\demo\\code\\hermes-mobile", branch="feat/ui-audit")

# 3b. Realistic agent turns: thinking + several tool groups (commands, TTS, file tools), settled
act = [user("Read me the changelog out loud and save the summary.")]
act.append(asst("", tool_calls=[call("a1", "terminal", {"command": "git log --oneline -n 5"}), call("a2", "terminal", {"command": "cat CHANGELOG.md | head -40"}), call("a3", "text_to_speech", {"text": "Changelog summary: three fixes and one feature.", "output_path": "/home/user/project/changelog.mp3"})], finish_reason="tool_calls", reasoning=REASONING, reasoning_content=REASONING))
act.append(tool("a1", "terminal", {"output": TERMINAL_OUT, "exit_code": 0, "error": None}))
act.append(tool("a2", "terminal", {"output": TERMINAL_OUT, "exit_code": 0, "error": None}))
act.append(tool("a3", "text_to_speech", {"success": True, "file_path": "/home/user/project/changelog.mp3", "media_tag": "MEDIA:/home/user/project/changelog.mp3"}))
act.append(asst("Done. I read the changelog and saved the audio.", reasoning="Short second thought about whether to also write the file.", reasoning_content="Short second thought about whether to also write the file."))
act.append(user("Now patch the README and read two files."))
act.append(asst("Working on it.", tool_calls=[call("b1", "read_file", {"path": "/home/user/project/README.md"}), call("b2", "read_file", {"path": "/home/user/project/src/app.ts"}), call("b3", "patch", {"path": "/home/user/project/README.md", "old_string": "a", "new_string": "b"}), call("b4", "terminal", {"command": "npm test"})], finish_reason="tool_calls", reasoning=REASONING, reasoning_content=REASONING))
act.append(tool("b1", "read_file", {"content": "     1|# Title\n     2|text", "total_lines": 2, "file_size": 20}))
act.append(tool("b2", "read_file", {"content": "     1|const a = 1", "total_lines": 1, "file_size": 12}))
act.append(tool("b3", "patch", {"success": True, "diff": "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n"}))
act.append(tool("b4", "terminal", {"output": "ok\n", "exit_code": 0, "error": None}))
act.append(asst("Patched the README; tests pass."))
session("aud-activity", "Activity groups: thinking, commands, TTS, files", act, age=1500, cwd=str(__import__("pathlib").Path(__file__).resolve().parents[2]), branch="main")

# 4. Reasoning
session("aud-think", "Thinking blocks and reasoning", [
    user("Compare a local WebView against a remote renderer."),
    asst("Here is the comparison.\n\n- **Local WebView**: offline, low latency.\n- **Remote renderer**: always up to date.", reasoning=REASONING, reasoning_content=REASONING),
    user("And the short answer?"),
    asst("Remote renderer.", reasoning="Brief."),
], age=3600)

# 5. Very long conversation
long_msgs = []
for i in range(1, 61):
    long_msgs.append(user(f"Question number {i}: tell me something about topic {i}, with enough words to make this message wrap over a couple of lines on a phone."))
    long_msgs.append(asst(f"Answer {i}. " + "This is a filler sentence that makes the answer a bit longer. " * (1 + i % 4) + (f"\n\n```py\nprint({i})\n```" if i % 5 == 0 else "")))
session("aud-long", "Very long conversation (120 messages)", long_msgs, age=7200, cwd="C:\\Users\\demo\\code\\long")

# 6. Extremely long title
session("aud-title", "Extremely long session title that keeps going and going and going without end to test sidebar truncation " + UNBROKEN, [
    user("Short question"), asst("Short answer"),
], age=10000)

# 7. Edge messages: empty assistant, error-ish, system-ish, huge single line, huge code
session("aud-edge", "Edge cases", [
    user(UNBROKEN * 3),
    asst(""),
    user(LONG_URL),
    asst("```\n" + "x" * 400 + "\n```\n\n" + "y" * 400),
    user("Multi\nline\nuser\nmessage\n\nwith blank lines\n\n    indented code-looking line"),
    asst("| a | b |\n|---|---|\n| " + "z" * 200 + " | " + "w" * 200 + " |"),
], age=20000)

# 8. Pinned & archived & various ages for the sidebar
TITLES = [
    "Fix the failing CI pipeline", "Plan weekend trip", "Refactor auth module", "Explain Tailscale ACLs",
    "Write release notes", "Debug memory leak in worker", "Translate README to Spanish", "Design database schema",
    "Optimize SQL query", "Draft email to landlord", "Summarize research paper", "Set up Docker compose",
    "Review pull request 142", "Brainstorm product names", "Convert CSV to JSON", "Regex for log parsing",
]
for i, t in enumerate(TITLES):
    session(f"aud-f{i:02d}", t, [user(f"Help me with: {t}"), asst(f"Of course. Here is how I would approach **{t}**.")],
            age=(i + 1) * 0.9 * DAY, pinned=1 if i in (1, 2) else 0, archived=1 if i == 15 else 0,
            cwd=["C:\\Users\\demo\\code\\alpha", "C:\\Users\\demo\\code\\beta", None, "C:\\Users\\demo\\notes"][i % 4])

db.commit()
db.close()
print("seeded", len(TITLES) + 7, "sessions into", HOME)
