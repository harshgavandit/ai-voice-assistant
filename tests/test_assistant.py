import base64
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient
from openai import APIConnectionError, APITimeoutError, AuthenticationError, NotFoundError, RateLimitError

import main


@pytest.fixture
def app_client(monkeypatch):
    main.sessions.clear()
    main.active_sessions.clear()
    fake = SimpleNamespace(
        audio=SimpleNamespace(
            transcriptions=SimpleNamespace(create=AsyncMock(return_value=SimpleNamespace(text='A robot on Mars.'))),
            speech=SimpleNamespace(create=AsyncMock(return_value=SimpleNamespace(read=lambda: b'ID3-audio'))),
        ),
        responses=SimpleNamespace(create=AsyncMock(return_value=SimpleNamespace(output_text='Maya found a robot on Mars.'))),
        close=AsyncMock(),
    )
    monkeypatch.setattr(main, 'API_KEY', 'test-key-not-real')
    monkeypatch.setattr(main, 'AsyncOpenAI', lambda **kwargs: fake)
    with TestClient(main.app) as client:
        yield client, fake
    main.sessions.clear()
    main.active_sessions.clear()


def upload(client, content=b'fake-audio', filename='speech.webm', session='test'):
    return client.post('/assistant', files={'file': (filename, content, 'audio/webm')}, data={'session_id': session})


def test_audio_pipeline_uses_transcript_config_and_preserves_contract(app_client):
    client, fake = app_client
    response = upload(client)
    assert response.status_code == 200
    data = response.json()
    assert data['transcript'] == 'A robot on Mars.'
    assert data['response'] == 'Maya found a robot on Mars.'
    assert base64.b64decode(data['audio_base64']) == b'ID3-audio'
    assert data['audio_mime_type'] == 'audio/mpeg'
    request = fake.responses.create.call_args.kwargs
    assert request['model'] == main.MODEL
    assert request['input'] == [{'role': 'user', 'content': data['transcript']}]
    assert request['instructions'] == main.SYSTEM_PROMPT
    assert request['store'] is False
    assert fake.audio.transcriptions.create.call_args.kwargs['file'][1] == b'fake-audio'
    assert fake.audio.speech.create.call_args.kwargs['input'] == data['response']


def test_followup_context_and_session_isolation(app_client):
    client, fake = app_client
    upload(client, session='one')
    upload(client, session='one')
    messages = fake.responses.create.call_args.kwargs['input']
    assert [item['role'] for item in messages] == ['user', 'assistant', 'user']
    upload(client, session='two')
    assert len(fake.responses.create.call_args.kwargs['input']) == 1


@pytest.mark.parametrize('content,filename,expected', [(b'', 'x.wav', 400), (b'abc', 'x.txt', 415)])
def test_rejects_bad_uploads_without_provider_calls(app_client, content, filename, expected):
    client, fake = app_client
    assert upload(client, content, filename).status_code == expected
    fake.audio.transcriptions.create.assert_not_called()


def test_audio_size_limit(app_client, monkeypatch):
    client, fake = app_client
    monkeypatch.setattr(main, 'MAX_AUDIO_BYTES', 4)
    assert upload(client, b'12345').status_code == 413
    fake.audio.transcriptions.create.assert_not_called()


def test_empty_transcription_does_not_generate_reply(app_client):
    client, fake = app_client
    fake.audio.transcriptions.create.return_value.text = '  '
    assert upload(client).status_code == 422
    fake.responses.create.assert_not_called()
    assert not main.active_sessions


def test_missing_key_is_actionable(app_client):
    client, fake = app_client
    main.app.state.openai = None
    assert upload(client).status_code == 503
    fake.audio.transcriptions.create.assert_not_called()
    # Restore for lifespan cleanup.
    main.app.state.openai = fake


@pytest.mark.parametrize('error,status,fragment', [
    (AuthenticationError('private-secret', response=httpx.Response(401, request=httpx.Request('POST', 'https://api.openai.com/v1/responses')), body={}), 503, 'API key'),
    (RateLimitError('private-secret', response=httpx.Response(429, request=httpx.Request('POST', 'https://api.openai.com/v1/responses')), body={'code': 'insufficient_quota'}), 503, 'quota'),
    (RateLimitError('private-secret', response=httpx.Response(429, request=httpx.Request('POST', 'https://api.openai.com/v1/responses')), body={'code': 'rate_limit_exceeded'}), 429, 'rate limiting'),
    (NotFoundError('private-secret', response=httpx.Response(404, request=httpx.Request('POST', 'https://api.openai.com/v1/responses')), body={}), 503, 'unavailable'),
    (APIConnectionError(request=httpx.Request('POST', 'https://api.openai.com/v1/responses')), 502, 'internet'),
    (APITimeoutError(request=httpx.Request('POST', 'https://api.openai.com/v1/responses')), 504, 'timed out'),
])
def test_provider_failures_are_safe_and_leave_no_history(app_client, error, status, fragment):
    client, fake = app_client
    fake.responses.create.side_effect = error
    response = upload(client)
    assert response.status_code == status
    assert fragment in response.json()['detail']
    assert 'private-secret' not in response.text
    assert not main.sessions
    assert not main.active_sessions
    fake.audio.speech.create.assert_not_called()


def test_tts_failure_does_not_commit_incomplete_turn(app_client):
    client, fake = app_client
    fake.audio.speech.create.return_value.read = lambda: b''
    assert upload(client).status_code == 502
    assert not main.sessions
    assert not main.active_sessions


def test_concurrent_session_is_rejected(app_client):
    client, fake = app_client
    main.active_sessions.add('test')
    assert upload(client).status_code == 409
    fake.audio.transcriptions.create.assert_not_called()


def test_history_expires_and_is_bounded(app_client, monkeypatch):
    client, _ = app_client
    monkeypatch.setattr(main, 'MAX_HISTORY_MESSAGES', 4)
    for _ in range(4):
        assert upload(client).status_code == 200
    assert len(main.sessions['test']['messages']) == 4
    main.sessions['test']['updated'] -= main.SESSION_TTL + 1
    assert main.history_for('test') == []


def test_ui_and_demo_are_served_without_exposing_env(app_client):
    client, _ = app_client
    assert client.get('/').status_code == 200
    assert client.get('/script.js').status_code == 200
    assert client.get('/demo.wav').content.startswith(b'RIFF')
    assert client.get('/.env').status_code == 404
    health = client.get('/health').json()
    assert health['model'] == main.MODEL
    assert 'api_key' not in health
