# Verification record — October 13, 2026

The running app uses http://127.0.0.1:8010/. An unrelated Support Ticket Classifier already occupied port 8000 and was preserved.

| Proof class | Result | Evidence / boundary |
| --- | --- | --- |
| Configured OpenAI key and model | Passed | A real `gpt-6-luna` Responses request returned the requested verification phrase; credential values were not printed |
| Live transcription | Passed | Chrome submitted a synthetic WAV and displayed: “Tell me a short story about a brave girl named Maya and a robot on Mars.” |
| Live reply generation | Passed | The generated story followed that request; configured model `gpt-6-luna` |
| Live speech generation and browser playback | Passed | `gpt-4o-mini-tts`, voice `onyx`; browser media duration and final current time both 35.352 seconds, readyState 4, no media error |
| Backend regressions | Passed | 17 pytest tests with mocked OpenAI; pipeline input, API contract, session isolation/history, upload rejection, missing key, rate/quota/auth/model/network/timeout errors, and failed TTS rollback |
| Frontend regressions | Passed | 7 Node checks with browser API doubles; recorder final chunk and track release, permission denial, demo, upload, HTTP errors, autoplay fallback, and fresh session reset |
| Syntax and dependencies | Passed | Node syntax check, Python compileall, pip check |
| Desktop browser | Passed | Visible transcript, story, native audio player, controls, and ready state; `.runtime/browser-desktop.png` |
| Mobile layout | Passed | Width 390; document width 390, no horizontal overflow; `.runtime/mobile-evidence.json` and `.runtime/browser-mobile.png` |
| Browser console during successful demo | Passed | No observed errors or warnings |
| Physical microphone and local speaker hardware | Not tested | Live end-to-end test used synthetic speech. Recording lifecycle was checked with browser API doubles; physical device capture and audible speaker output require the user's browser permission and hardware |
| Chrome automated local-file upload | Tool limitation | Extension disallowed file URL access. Full browser workflow was tested using the built-in demo instead. Upload handling passed the frontend regression, and the live demo submitted the same multipart endpoint |
| Persistence / public deployment | Outside current implementation | Sessions are in-memory; Upstash configuration is unused; app runs locally with one worker |

## Evidence inventory

- `.runtime/browser-evidence.json` — actual displayed transcript/story and media playback measurements.
- `.runtime/mobile-evidence.json` — measured viewport and document widths.
- `docs/images/voice-assistant-desktop.png` — shareable screenshot of the completed synthetic demo.
- `docs/images/voice-assistant-mobile.png` — shareable screenshot under a mobile viewport override, reset after testing.
- `.runtime/server.stdout.log` / `.runtime/server.stderr.log` — local server logs.
- `assets/demo-prompt.wav` — non-personal synthetic input generated locally with Windows speech synthesis.

The live demo is distinct from regression tests: it called all three OpenAI model stages with the user's configured credential. Regression tests mocked the provider and incurred no API usage. Screenshots and transcript evidence contain only the synthetic test prompt and generated story.

## Repository publication verification — October 14, 2026

Before publication, the backend and frontend regression suites, syntax/compilation checks, dependency consistency, staged-file review, and credential scan are rerun. The live OpenAI results above are from October 13 and are not a claim of another paid API run on October 14.

The repository includes source, test files, the synthetic demo, documentation, and the shareable screenshots in docs/images. Detailed runtime evidence and server logs remain local and are excluded by .gitignore.

## Vercel production verification — October 20, 2026

Public URL: https://ai-voice-assistant-steel.vercel.app

Vercel reported the initial deployment `dpl_2rM94k3uc7CuhSHJGGW6iTd4gjks` as READY using Python 3.14. Its production domain was checked over unauthenticated HTTPS.

- `/`, `/script.js`, and `/demo.wav` returned HTTP 200. The home page contained the Voice Chat Assistant interface and the demo was a valid RIFF/WAV file.
- `/.env`, `/.env.local`, and `/.vercel/project.json` returned HTTP 404.
- `/health` reported the key configured, `gpt-6-luna`, `whisper-1`, `gpt-4o-mini-tts`, `onyx`, and a 4,194,304-byte hosted audio upload limit.
- A real multipart request to the hosted `/assistant` endpoint returned HTTP 200 in 13.21 seconds. It correctly transcribed: “Tell me a short story about a brave girl named Maya and a robot on Mars.”
- The response contained a matching story and 573,696 bytes of base64-decoded MP3 data (`audio/mpeg`, valid MP3 signature). This verifies a real hosted transcription -> reply generation -> speech generation request, not a mocked provider response.
- Empty audio returned HTTP 400.
- All 19 backend tests and 9 frontend checks passed, including hosted upload-limit handling and platform non-JSON errors. Python compilation, JavaScript syntax, dependency consistency, and diff whitespace checks passed.

Browser automation was disabled in Work settings during the hosted check. Hosted browser rendering, playback, and physical microphone/speaker behavior were not tested; the October 13 browser playback evidence is a separate local result. Serverless conversation history is instance-local and can reset across instances.

The hosted request measurements and returned synthetic story are retained locally in `.runtime/hosted-verification.json`; the returned MP3 is `.runtime/hosted-reply.mp3`. These files and all local environment settings are excluded from Git and the deployment upload.
