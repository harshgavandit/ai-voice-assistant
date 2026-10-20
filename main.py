"""Local voice assistant: recorded audio -> transcript -> reply -> spoken audio."""

import base64
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from openai import (
    APIConnectionError, APIStatusError, APITimeoutError, AsyncOpenAI,
    AuthenticationError, PermissionDeniedError, RateLimitError,
)

from prompt import SYSTEM_PROMPT

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / ".env")
# Accept the existing spelling without copying or exposing the credential.
API_KEY = (os.getenv("OPENAI_API_KEY") or os.getenv("OPEN_AI_API_KEY") or "").strip()
MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini").strip()
TRANSCRIPTION_MODEL = os.getenv("OPENAI_TRANSCRIPTION_MODEL", "whisper-1").strip()
TTS_MODEL = os.getenv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts").strip()
VOICE = os.getenv("OPENAI_TTS_VOICE", "onyx").strip()
# Leave room for multipart metadata below Vercel's 4.5 MB request limit.
MAX_AUDIO_BYTES = (4 if os.getenv("VERCEL") else 24) * 1024 * 1024
SESSION_TTL = 30 * 60
MAX_SESSIONS = 100
MAX_HISTORY_MESSAGES = 12
FORMATS = {".webm", ".wav", ".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".ogg", ".flac"}
logger = logging.getLogger("voice_assistant")
sessions: dict[str, dict] = {}
active_sessions: set[str] = set()


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.openai = AsyncOpenAI(api_key=API_KEY, timeout=60.0, max_retries=0) if API_KEY else None
    try:
        yield
    finally:
        if app.state.openai:
            await app.state.openai.close()


app = FastAPI(title="Voice Chat Assistant", lifespan=lifespan)


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(ROOT / "index.html")


@app.get("/script.js", include_in_schema=False)
async def script():
    return FileResponse(ROOT / "script.js", media_type="text/javascript")


@app.get("/health")
async def health():
    # Configuration readiness is not proof of provider access or available quota.
    return {"status": "ok", "api_key_configured": bool(API_KEY), "model": MODEL,
            "transcription_model": TRANSCRIPTION_MODEL, "tts_model": TTS_MODEL, "voice": VOICE,
            "max_audio_bytes": MAX_AUDIO_BYTES}


@app.get("/demo.wav", include_in_schema=False)
async def demo_audio():
    return FileResponse(ROOT / "assets" / "demo-prompt.wav", media_type="audio/wav")


def history_for(session_id: str) -> list[dict]:
    now = time.monotonic()
    for key in list(sessions):
        if now - sessions[key]["updated"] > SESSION_TTL and key not in active_sessions:
            del sessions[key]
    if session_id not in sessions and len(sessions) >= MAX_SESSIONS:
        candidates = [key for key in sessions if key not in active_sessions]
        if not candidates:
            raise HTTPException(503, "The assistant is busy. Please try again shortly.")
        del sessions[min(candidates, key=lambda key: sessions[key]["updated"])]
    return list(sessions.get(session_id, {}).get("messages", []))


def provider_error(exc: Exception, stage: str) -> HTTPException:
    # Never send raw provider errors, request bodies, or credentials to the browser/logs.
    logger.warning("OpenAI stage=%s error_type=%s status=%s", stage, type(exc).__name__, getattr(exc, "status_code", None))
    if isinstance(exc, AuthenticationError):
        return HTTPException(503, "OpenAI rejected the API key. Check the server's .env configuration.")
    if isinstance(exc, PermissionDeniedError):
        return HTTPException(503, f"OpenAI denied access during {stage}. Check project and model permissions.")
    if isinstance(exc, RateLimitError):
        code = getattr(exc, "code", None)
        if code in {"insufficient_quota", "billing_hard_limit_reached"}:
            return HTTPException(503, "OpenAI API quota is exhausted. Check API billing and project limits.")
        return HTTPException(429, "OpenAI is rate limiting requests. Please wait and try again.")
    if isinstance(exc, APITimeoutError):
        return HTTPException(504, f"OpenAI timed out during {stage}. Please try again.")
    if isinstance(exc, APIConnectionError):
        return HTTPException(502, "Unable to reach OpenAI. Check the server's internet connection.")
    if isinstance(exc, APIStatusError) and exc.status_code == 404:
        return HTTPException(503, f"The configured model for {stage} is unavailable to this API key.")
    if isinstance(exc, APIStatusError) and exc.status_code == 400 and stage == "transcription":
        return HTTPException(422, "The recording could not be decoded. Record again or upload a supported audio file.")
    return HTTPException(502, f"OpenAI could not complete {stage}. Check the configured model and try again.")


@app.post("/assistant")
async def assistant(file: UploadFile, session_id: str = Form("default", min_length=1, max_length=128)):
    client = app.state.openai
    if client is None:
        await file.close()
        raise HTTPException(503, "Add OPENAI_API_KEY to the server's .env file and restart the app.")
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in FORMATS:
        await file.close()
        raise HTTPException(415, "Use a WebM, WAV, MP3, MP4, M4A, OGG, FLAC, MPEG, or MPGA audio file.")
    try:
        content = await file.read(MAX_AUDIO_BYTES + 1)
    finally:
        await file.close()
    if not content:
        raise HTTPException(400, "The recording is empty. Please record some speech.")
    if len(content) > MAX_AUDIO_BYTES:
        raise HTTPException(413, f"Audio must be smaller than {MAX_AUDIO_BYTES // (1024 * 1024)} MB.")
    if session_id in active_sessions:
        raise HTTPException(409, "A reply for this conversation is already processing.")
    history = history_for(session_id)
    active_sessions.add(session_id)
    stage = "transcription"
    try:
        transcript = await client.audio.transcriptions.create(
            model=TRANSCRIPTION_MODEL,
            file=(f"recording{suffix}", content, file.content_type or "application/octet-stream"),
        )
        text = transcript.text.strip()
        if not text:
            raise HTTPException(422, "No speech was detected. Please speak clearly and try again.")
        stage = "reply generation"
        messages = history + [{"role": "user", "content": text}]
        completion = await client.responses.create(
            model=MODEL, instructions=SYSTEM_PROMPT, input=messages,
            max_output_tokens=1600, store=False,
        )
        reply = completion.output_text.strip()
        if not reply:
            raise HTTPException(502, "The model returned no reply. Please try again.")
        stage = "speech generation"
        speech_args = {"model": TTS_MODEL, "input": reply, "voice": VOICE, "response_format": "mp3"}
        if TTS_MODEL.startswith("gpt-"):
            speech_args["instructions"] = "Speak in an adventurous tone with an Indian English accent."
        speech = await client.audio.speech.create(**speech_args)
        audio_bytes = speech.read()
        if not audio_bytes:
            raise HTTPException(502, "Speech generation returned empty audio. Please try again.")
        # Commit conversation only after all three stages succeed.
        sessions[session_id] = {"messages": (messages + [{"role": "assistant", "content": reply}])[-MAX_HISTORY_MESSAGES:],
                                "updated": time.monotonic()}
        return JSONResponse({"transcript": text, "response": reply,
                             "audio_base64": base64.b64encode(audio_bytes).decode("ascii"),
                             "audio_mime_type": "audio/mpeg"})
    except (APIStatusError, APIConnectionError) as exc:
        raise provider_error(exc, stage) from None
    finally:
        active_sessions.discard(session_id)
