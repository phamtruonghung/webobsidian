# Install the WebObsidian Agent skill (copy-paste, no local clone needed)

You do **not** need to clone this repo. Copy *everything* inside the box below and paste it
into your coding agent (Claude Code, Codex, OpenCode, Cursor…). The agent will **download**
the skill from GitHub into its own skills folder, ask you for your WebObsidian URL + API key,
save them, and from then on be able to operate your vault remotely.

> One-time per machine. Afterwards just say "use my WebObsidian vault to …".
>
> Prerequisite: create an API key first in your WebObsidian at **Settings → API Keys**
> (scopes `read` / `write` / `search`; it looks like `wok_…`).

---

```text
SYSTEM / TASK — Install the "webobsidian" agent skill from GitHub, then set up credentials.
Do every step in order; do not skip the credential step.

STEP 1 — Download the skill into your runtime's skills directory:
  - Claude Code: ~/.claude/skills/webobsidian/
  - Codex:       ~/.codex/skills/webobsidian/
  - OpenCode:    ~/.opencode/skills/webobsidian/
  - Otherwise use this runtime's documented skills directory.
  Run (substitute your SKILLS_DIR):
      SKILLS_DIR=~/.claude/skills        # change for your runtime
      mkdir -p "$SKILLS_DIR/webobsidian"
      curl -fsSL https://raw.githubusercontent.com/phamtruonghung/webobsidian/main/docs/agent-skill/webobsidian/SKILL.md \
        -o "$SKILLS_DIR/webobsidian/SKILL.md"
  Confirm the file exists and starts with the YAML frontmatter "name: webobsidian".

STEP 2 — Set up credentials (ASK ME; never echo the key back):
  Ask me for:
    (a) my WebObsidian base URL  (e.g. https://notes.example.com or http://host:8787)
    (b) my API key               (Settings -> API Keys; looks like wok_...)
  Then save them:
      mkdir -p ~/.webobsidian && chmod 700 ~/.webobsidian
      printf '{ "baseUrl": "%s", "apiKey": "%s" }\n' "<BASE_URL>" "<API_KEY>" > ~/.webobsidian/credentials.json
      chmod 600 ~/.webobsidian/credentials.json

STEP 3 — Verify (do NOT print the API key) and confirm:
      BASE=$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.webobsidian/credentials.json")))["baseUrl"].rstrip("/"))')
      KEY=$(python3 -c 'import json,os;print(json.load(open(os.path.expanduser("~/.webobsidian/credentials.json")))["apiKey"])')
      curl -s "$BASE/api/v1/health"
      curl -s -H "X-API-Key: $KEY" "$BASE/api/v1/tags" | head
  If health is ok and tags load, tell me the skill is installed and ready (say how many tags
  you saw, WITHOUT printing the key). From now on, whenever I ask you to work with my
  WebObsidian / Obsidian vault, load and follow the webobsidian skill.
```

---

## Notes

- The skill file the agent downloads is the canonical
  [`webobsidian/SKILL.md`](webobsidian/SKILL.md) — it contains the full Agent API reference
  and the Obsidian Flavored Markdown guide (wikilinks, embeds, callouts, properties, tags,
  tasks, math, mermaid).
- Credentials are stored at `~/.webobsidian/credentials.json` (chmod 600), **outside** any
  repo. The key is never printed, logged, or written into notes.
- To **update** the skill later, re-run the `curl` from STEP 1 (it overwrites SKILL.md).
- Re-running the bootstrap with credentials already present skips STEP 2.

## Alternative: skills installer

If your runtime supports the [Agent Skills](https://github.com/obsidianmd/obsidian-skills)
installer:

```bash
npx skills add https://github.com/xnohat/webobsidian --path docs/agent-skill/webobsidian
```
