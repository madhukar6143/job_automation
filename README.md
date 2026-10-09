# Tsenta Auto-Judge

A Tampermonkey / Violentmonkey userscript for [tsenta.com](https://tsenta.com) that uses an LLM to screen every recommended job against your resume and tells you whether to **APPLY** or **PASS**. It can run in two modes:

- **MANUAL** (default): you open jobs yourself. The script judges each job you open and shows a colored verdict badge inside the details panel. It never clicks anything.
- **AUTO**: the script goes through the recommendations feed itself. It opens each job, judges it, clicks **Apply** or **Save + Not interested**, closes the panel and moves on. Delays are randomized so it paces like a person.

Current version: `6.9-tier2lowfit`

---

## Table of contents

1. [Features](#features)
2. [How it works](#how-it-works)
3. [Installation](#installation)
4. [Configuration](#configuration)
5. [Decision rules](#decision-rules)
6. [Duplicate detection (shared persistent store)](#duplicate-detection-shared-persistent-store)
7. [Google Sheets logging (tier-2/3 low-fit passes)](#google-sheets-logging-tier-23-low-fit-passes)
8. [On-screen UI](#on-screen-ui)
9. [Console helpers](#console-helpers)
10. [Timers and self-healing](#timers-and-self-healing)
11. [Code map](#code-map)
12. [Security notes](#security-notes)
13. [Troubleshooting](#troubleshooting)

---

## Features

- **LLM screening** through a rotating pool of Groq (`openai/gpt-oss-120b`) and Gemini (`gemini-3.1-flash-lite`) keys, using their OpenAI-compatible chat endpoints.
- **Hard filters that run before the LLM**, with no API call:
  - Security clearance, TS/SCI, ITAR/EAR, export control, "US persons" or "US citizens only" postings → PASS
  - Senior-level titles (Senior, Sr, Staff, Principal, Lead, Architect, Manager, Director, Head, VP…) → PASS
- **Post-LLM checks**: clearance claims are only accepted if the JD text really mentions them, years over 2 → PASS, fit ≤ 80 → PASS.
- **Structured output**: gpt-oss models use a strict JSON schema, other models use JSON mode. A forgiving `extractJSON` parser handles code fences, smart quotes and trailing commas.
- **Persistent dedup across reloads** with `GM_setValue`, a 7-day TTL and a 3000-entry cap. The store is shared with a companion CSV-export script.
- **Human-like pacing**: smooth scroll before clicks, jittered sleeps, random 10–15 s gaps between jobs, and a longer break every 4–6 jobs.
- **Self-healing**: auto-reloads when the feed is empty, on a 15–20 min interval, or after 8 min with no activity.
- **Optional Google Sheet log** of borderline low-fit passes so you can review them by hand.

---

## How it works

```
┌────────────── tsenta.com/dashboard/recommendations ──────────────┐
│                                                                   │
│  getCards()  ──► pick first job not seen (session + GM store)     │
│      │                                                            │
│      ▼                                                            │
│  click "Details" ──► openPanel() ──► verify panel title matches   │
│      │                                                            │
│      ▼                                                            │
│  extract jobText, company, external jobLink                       │
│      │                                                            │
│      ▼                                                            │
│  already persisted? ──yes──► close panel, skip                    │
│      │ no                                                         │
│      ▼                                                            │
│  markPersisted() ──► judge(jobText, title)                        │
│                         │                                         │
│      ┌──────────────────┼────────────────────────┐                │
│      ▼                  ▼                        ▼                │
│  regex hard-block   senior title           LLM call (random key)  │
│   → PASS             → PASS                 → post-checks          │
│                                               → APPLY / PASS       │
│      │                                                            │
│      ▼                                                            │
│  low-fit PASS on fallback key? ──► POST to Google Sheet webhook   │
│      │                                                            │
│      ▼                                                            │
│  APPLY → click Apply         PASS → click Save, then Not interested│
│      │                                                            │
│      ▼                                                            │
│  close panel (Close btn / aria-label / Escape), human wait, loop  │
└───────────────────────────────────────────────────────────────────┘
```

In MANUAL mode a `MutationObserver` watches the page instead. When a job details panel opens with a new title, it calls the same `judge()` and draws the badge under the panel heading.

---

## Installation

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/) or Violentmonkey.
2. Create a new script and paste in the contents of [`tsenta-auto-judge.user.js`](tsenta-auto-judge.user.js).
3. Fill in your API keys and, if you want logging, the webhook URL. See [Configuration](#configuration).
4. Open `https://<sub>.tsenta.com/dashboard/recommendations`. Two buttons appear at the bottom left.
5. The first time a request goes out, Tampermonkey asks you to allow cross-origin requests to `api.groq.com`, `generativelanguage.googleapis.com` and `script.google.com`. Allow them.

### Required grants

| Grant | Why |
|---|---|
| `GM_xmlhttpRequest` | Calls the LLM APIs and the Sheets webhook without hitting CORS limits |
| `GM_setValue` / `GM_getValue` | Persistent "seen jobs" map shared across reloads and scripts |
| `unsafeWindow` | Puts the console helpers on the page's `window` |

---

## Configuration

Everything you can change sits at the top of the script.

| Variable | Default | Meaning |
|---|---|---|
| `SCRIPT_VERSION` | `"6.9-tier2lowfit"` | Shown on the start button |
| `AUTO_ACTION_MODE` | `false` | `false` = MANUAL badge-only mode, `true` = AUTO clicking mode. Can also be toggled with the on-screen button. |
| `PASS_LOG_WEBHOOK` | placeholder | Google Apps Script `/exec` URL. Any value starting with `PASTE_` turns logging off. |
| `API_POOL` | 3 Groq + 2 Gemini | Array of `{provider, key, url, model}`. One entry is picked at random for each job. |
| `RESUME` | one-paragraph summary | Resume text sent to the LLM. Keep it short and full of keywords. |
| `BASE_DELAY_SEC` | `10` | Base pacing unit. The gap between jobs is `BASE..1.5×BASE` s, and breaks add `2×BASE`. |
| `TTL_MS` | 7 days | How long a job stays "seen" |
| `SEEN_KEY` | `"sr_seen_map"` | GM storage key. **Must match the companion CSV script** if you use one. |

### Adding API keys

```js
var API_POOL = [
  { provider: "groq",   key: "gsk_...",  url: "https://api.groq.com/openai/v1/chat/completions", model: "openai/gpt-oss-120b" },
  { provider: "gemini", key: "AIza...",  url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", model: "gemini-3.1-flash-lite" }
];
```

More keys spread the load and make 429 rate limits less likely. Groq requests cut the JD at 10,000 chars and Gemini requests at 12,000.

---

## Decision rules

`judge(jd, jobTitle)` returns `{decision, fit, reason, yearsRequired, citizenshipOrClearance}`. The checks run in this order:

| # | Check | Result |
|---|---|---|
| 1 | JD matches the **hard regex**: security/secret/government/top secret clearance, TS/SCI, ITAR, EAR regulations, export control, US person(s), "must be a US citizen", "US citizenship required", "US citizens only" | `PASS`, fit 0, *"Defense/export-restricted posting"* |
| 2 | Title matches the **senior regex** `senior|sr|staff|principal|lead|architect|advisor|manager|director|head|vp|distinguished` | `PASS`, fit 0, *"Senior-level title — auto-passed"* |
| 3 | LLM call: random key from `API_POOL`, `temperature: 0`, `max_tokens: 1200` | see below |
| 3a | LLM says clearance `required` **and** the JD text really matches a clearance regex | `PASS`: *"Citizenship/clearance restriction stated"* |
| 3b | LLM `yearsRequired > 2` **and** the JD contains an "N years" pattern | `PASS`: *"Requires N+ yrs (limit 2)"* |
| 3c | `fit <= 80` | `PASS`: *"Fit N% below cutoff"* |
| 3d | otherwise | `APPLY` |
| — | HTTP 429 | waits 10 s and retries, up to 3 times |
| — | Network error / bad JSON | `PASS` with reason *"API request failed"* / *"JSON parse error"* |

Guardrails against LLM hallucination:
- A clearance verdict only counts if the regex also finds it in the JD (`isClear = llm=="required" && jdClear`).
- If the JD never mentions clearance but the LLM's reason does, the reason is wiped so the badge doesn't show a fake blocker.
- The years rule only applies when the JD really contains a years pattern.

### The prompt

The system prompt forces JSON-only output. The user prompt tells the model:
1. Mark clearance `required` only for explicit US citizen / US person / clearance demands. EEO, veteran, ADA, GDPR and work-authorization text does **not** count.
2. `yearsRequired` is the minimum integer ("3-5 years" → 3) or `null`.
3. Ignore visa sponsorship.
4. Score `fit` strictly on skills **and** domain alignment.
5. Give a one-sentence reason that agrees with the decision.

---

## Duplicate detection (shared persistent store)

Two layers stop the same job from being judged twice:

1. **Session set** (`sessionDone`): titles handled since the last page load. Cleared on reload.
2. **Persistent map** (`GM_setValue("sr_seen_map")`): `{ key: firstSeenTimestamp }`, kept across reloads.
   - Entries older than **7 days** are pruned on every load.
   - Capped at **3000** entries; the oldest are removed first.
   - An existing timestamp is never overwritten, so the first-seen time is kept.

### Tiered keys (`seenKeyFor`)

| Tier | When | Key format |
|---|---|---|
| **1** | External link with a real path or query | normalized URL (tracking params like `utm_*`, `ref`, `gclid`, `fbclid` stripped, trailing `/` removed) |
| **2** | External link that is only a bare domain | `co+title::<origin>::<normalized title>` |
| **3** | No usable external link (tsenta URL only) | `title::<normalized title>` |

`normTitle` lowercases the title and strips parentheses, anything after `- – — | ,`, words like remote/hybrid/onsite/contract/full-time/part-time/intern, and punctuation. That way "Software Engineer (Remote) - Acme" and "Software Engineer, Hybrid" collapse to the same key.

> The store is designed to be **identical to a companion CSV script**. If you run both, keep `SEEN_KEY`, `TTL_MS`, `normalizeUrl`, `normTitle` and `seenKeyFor` in sync.

---

## Google Sheets logging (tier-2/3 low-fit passes)

Only one kind of job is logged: a job that

- was **PASSED**,
- for **low fit** (reason matches `Fit N% below cutoff`),
- and has a **tier-2 or tier-3 fallback key** (no unique deep link).

These are the borderline cases worth a human look. Clearance, seniority, export, years and error passes are never logged.

Payload POSTed to `PASS_LOG_WEBHOOK`:

```json
{ "title": "...", "company": "...", "jobLink": "...", "fit": 72, "reason": "Fit 72% below cutoff — ..." }
```

### Example Apps Script receiver

```js
function doPost(e) {
  var d = JSON.parse(e.postData.contents);
  SpreadsheetApp.getActive().getSheetByName("Sheet1")
    .appendRow([new Date(), d.title, d.company, d.jobLink, d.fit, d.reason]);
  return ContentService.createTextOutput("ok");
}
```

Deploy it as a **Web app** (Execute as: Me, Access: Anyone) and paste the `/exec` URL into `PASS_LOG_WEBHOOK`.

---

## On-screen UI

| Element | Position | Purpose |
|---|---|---|
| **▶ Auto-judge vX** | bottom left | Starts or stops the AUTO loop. Shows `⏳ Running… (stop)` while running. In MANUAL mode it just shows a hint. |
| **Mode button** | bottom left, next to start | Switches between `✋ MANUAL` and `⚙️ AUTO`. Switching to MANUAL stops a running loop right away. |
| **Status box** | above the buttons | Live progress: current job, verdict, counters (`Applied | Saved | Passed`), wait and break timers. |
| **Verdict badge** (MANUAL) | under the job panel heading | Green ✅ APPLY or red ❌ PASS with fit % and reason. Reminds you that you make the final call. |

---

## Console helpers

Run these in the browser DevTools console on a tsenta.com tab:

| Function | What it does |
|---|---|
| `resetAutoJudgeHistory()` | Clears the session set **and** the persistent seen map, so every job is judged again |
| `getJrStorage()` | Returns the full `{key: timestamp}` seen map |
| `jrLast(n)` | Prints a `console.table` of the `n` most recent seen keys (default 5) |

The script also logs a heartbeat every 5 s:
```
AUTO STATUS: running=true cards=12 hidden=false focus=true 10:42:13 AM
```

> A comment mentions `jrTestLog()`, but it is not defined in this version.

---

## Timers and self-healing

| Timer | Condition | Action |
|---|---|---|
| `autoStart` (1 s after load, and after every `history.pushState`) | AUTO mode and on `/dashboard/recommendations` | Clicks ▶ after a random 1.5–3 s delay |
| Feed exhausted | "No more jobs to show", or more than 3 empty polls | Reloads after 10 s (or 2 min if nothing was processed) |
| Periodic refresh | every random 15–20 min, AUTO mode, on recommendations | `location.reload()` |
| Watchdog | every 60 s; AUTO, running and idle over 8 min | `location.reload()` |
| Heartbeat | every 5 s | `console.log` status line |

---

## Code map

| Section | Key functions |
|---|---|
| Config | `SCRIPT_VERSION`, `AUTO_ACTION_MODE`, `PASS_LOG_WEBHOOK`, `API_POOL`, `RESUME`, `BASE_DELAY_SEC` |
| Session guard | `getProcessedJobs`, `markJobProcessed` |
| Persistent store | `normalizeUrl`, `normTitle`, `getSeenMap`, `saveSeenMap`, `pruneOldLogs`, `seenKeyFor`, `isFallbackKey`, `isPersisted`, `markPersisted` |
| Console API | `resetAutoJudgeHistory`, `getJrStorage`, `jrLast` |
| Logging | `logToGoogleSheet` |
| UI | `startBtn`, `modeBtn`, `status`, `say` |
| Human pacing | `sleep`, `randomBetween`, `jitterSleep`, `humanScrollTo`, `clickReact` |
| DOM scraping | `findBtn`, `getCards`, `openPanel`, `extractCompany`, `extractJobLink` |
| LLM | `SCH` (JSON schema), `payload`, `extractJSON`, `parseYears`, `judge` |
| AUTO loop | `runLoop` |
| MANUAL mode | `renderManualBadge`, `manualObserver` |
| Lifecycle | `autoStart`, `history.pushState` hook, reload/watchdog intervals |

### DOM heuristics (fragile; update these if tsenta changes its UI)

- **Job card**: a `div` with an `h3`, containing the words "Details", "Apply" and "Pass", 50–2500 chars of text, and not a "quick apply" or "add link" card.
- **Details panel**: a `div[class*="fixed"]` whose class contains `right-0` or `inset-y` and that has an `h1` or `h2`. The one with the most text wins.
- **Pass button**: `button[aria-label^="not interested in <title>"]`, falling back to a button labelled `Pass` or `Not interested`.
- **Close**: a button with text `Close`, `aria-label="Close"` or `×`, falling back to an `Escape` keydown.

---

## Security notes

- **Never commit real API keys or webhook URLs.** This repo ships placeholders only. Keep your filled-in copy in Tampermonkey only.
- A key that ever ended up in git history, chat logs or screenshots should be **rotated** at the provider ([Groq console](https://console.groq.com/keys), [Google AI Studio](https://aistudio.google.com/apikey)).
- The webhook is unauthenticated (Anyone access). Treat its URL like a secret.
- AUTO mode clicks **Apply** for you. Check that you're happy with the fit cutoff and resume summary before you turn it on, and make sure automation fits tsenta's terms of use.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Every job shows `API request failed` | Keys are missing or invalid, or the `@connect` permission was denied in Tampermonkey |
| Every job shows `JSON parse error` | The model returned non-JSON. Check the model name, or try a different provider |
| Loop says "Waiting for feed…" and then reloads | Every visible card is already in the seen map. Run `resetAutoJudgeHistory()` if you want them judged again |
| Panel opens but the job gets skipped | The panel title didn't match the card title (first 15 chars). tsenta may have changed the markup |
| Buttons aren't clicked | The DOM heuristics no longer match. Update `getCards`, `openPanel` or `findBtn` regexes |
| Nothing logged to the Sheet | Only tier-2/3 low-fit passes are logged by design. Also check that the webhook URL doesn't start with `PASTE_` |
