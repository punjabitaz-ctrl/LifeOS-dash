# AI setup

LifeOS never needs an AI. With "None (rules only)" it still proposes insights from your numbers. If you want an AI to help, pick one of the three set-ups below in Settings, then AI provider. The AI receives the numeric weekly digest, your current targets (workouts per week, days between contacts, savings rate, study minutes, backup reminder days), the text of up to 8 insights you approved, and counts of rejected insights (by area, and by the fixed reason you chose, over the last 12 weeks). It never receives entries, titles, names, notes, wellbeing, body measurements or targets, private vault items, or the reasons you type (those stay on this device as lessons and are never sent). You always approve or reject what it proposes.

## 1. Anthropic API key (calls go straight from this page to api.anthropic.com)
1. Create an API key in your Anthropic console. Give it its own workspace or key name for LifeOS.
2. Set a spend limit on that workspace before you use it, so a mistake cannot cost more than you decide.
3. In Settings, AI provider: Mode "Anthropic API", Model (the default is claude-haiku-4-5; type another model name if you prefer), paste the key, Save provider. The key is stored only inside your encrypted vault and is shown back as its last 4 characters.
4. Press Test connection. It sends one fixed message ("Reply with OK.") that holds no data from your vault, and reports either that it works or a code: AI_TIMEOUT (no answer in 20 seconds), AI_NETWORK (could not reach the provider), AI_HTTP (the provider refused: check the key, the model name and the spend limit), AI_BAD_REPLY (an answer that could not be read), AI_FAIL (the test could not run: check the mode, key and model). No error text is kept; the code goes into the local diagnostics list.

## 2. Manual mode with Claude (no key, nothing sent by LifeOS)
1. In Settings, AI provider: Mode "Manual copy and paste", Save provider.
2. In a weekly review press Suggest with AI. LifeOS shows the prompt; press Copy, paste it into a Claude chat, and copy Claude's reply (a JSON list).
3. Paste the reply into the box and press Add suggestions. Each one still waits for your Approve or Reject.
Test connection has nothing to test in this mode and says so.

## 3. A local model on the same machine (Ollama)
1. Install Ollama and pull a model, for example `ollama pull llama3.2`.
2. The hosted copy is a web page, so Ollama must be told to accept calls from its address. Set the allowed origin to the exact address you open LifeOS at (scheme and host, no path), then restart Ollama. For example, with the live copy at `https://example.workers.dev`: on macOS `launchctl setenv OLLAMA_ORIGINS "https://example.workers.dev"`, on Linux add `Environment="OLLAMA_ORIGINS=https://example.workers.dev"` to the service, on Windows set the user environment variable `OLLAMA_ORIGINS`. Some browsers still block a page on https from calling plain http on the same machine (mixed content, or a local network permission prompt you must allow); then Test connection reports AI_NETWORK. A copy opened as a local file (file://) sends no web address as its origin, so Ollama may refuse it too. Neither case has been tested with a real Ollama yet.
3. In Settings, AI provider: Mode "Local model", Base URL `http://localhost:11434/v1`, Model the name you pulled, Save provider. Only `http://localhost` and `http://127.0.0.1` with a port are accepted.
4. Press Test connection.

## 4. Models on your home machines: the NAS model and the PC model (v2.0.0)
LifeOS can call Ollama on your NAS (a small model) and on your PC (a stronger one). Each sits behind Caddy at a fixed name from `config/hosts.json` (`ai-nas.lifeos.tazabbas.com`, `ai-pc.lifeos.tazabbas.com`) and answers only on your tailnet. You type only a model name in Settings; the address is fixed in the build and the page's policy allows exactly those names. Setup of DNS and Caddy is the same as the sync service (docs/NAS-SETUP.md, sections 4 and 5).

Pick models yourself. Model names change often, so check the current options in the Ollama library and what your hardware runs well before you choose. Names such as `llama3.2:3b` or `qwen3:8b` are only examples of how a name looks. Use the exact name `ollama list` shows on that machine.

On each machine (NAS and PC):
1. Install Ollama and pull a model (`ollama pull <model name>`).
2. Allow calls from the app address only: set `OLLAMA_ORIGINS` to the exact app origin (scheme and host, no path), for example `OLLAMA_ORIGINS=https://lifeos.tazabbas.com`. Do not use `*`. Add the workers.dev origin, comma separated, only while you still use it. Restart Ollama. Keep Ollama listening on the machine's own address (`127.0.0.1:11434`) and let Caddy be the only way in.
3. Caddy: the `ai-nas` block in `server/Caddyfile.example` shows the shape (Cloudflare DNS challenge, token from the environment). On the PC use the `ai-pc` name and the PC's own Tailscale address in Cloudflare DNS (DNS only, never proxied).
4. In LifeOS, Settings, AI provider: choose Mode "NAS model" or "PC model", type the model name, Save provider, then press Test connection. Each host also has its own Test button under "Home model hosts".
5. Optional fallback: choose "Try the NAS model if the first one cannot be reached" (or the PC one). It is used only when the first host cannot be reached or times out (for example the PC is off), never after an error reply, and it needs that host's model name filled in.

What is sent is unchanged for every provider: the numeric weekly digest, your targets, approved insights and counts of rejected insights. No entries, titles, notes or names. Test connection sends a fixed message with nothing from your vault. If a host cannot be reached the page says "Connect Tailscale and try again". A first call can be slow while a model loads; the page waits up to 90 seconds for a home host.

## A model on another machine on your home network (not on the tailnet)
Not supported. The page is https, so browsers block plain http calls to another machine, and the fixed Content Security Policy lists only the names in `config/hosts.json`.
