import importlib.util
import os
from pathlib import Path
from unittest.mock import MagicMock

from fastapi.testclient import TestClient


os.environ["DATABASE_URL"] = "postgresql://test:test@localhost:5432/presend"
os.environ["PRESEND_ALLOWED_EXTENSION_ORIGINS"] = (
    "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa,"
    "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)
spec = importlib.util.spec_from_file_location(
    "presend_feedback_app",
    Path(__file__).with_name("app.py"),
)
module = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(module)


class FakeConnection:
    def __init__(self):
        self.executions = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        return False

    def execute(self, query, params=None):
        self.executions.append((query, params))


connections = []


def fake_connect(*args, **kwargs):
    connection = FakeConnection()
    connections.append((args, kwargs, connection))
    return connection


module.psycopg.connect = MagicMock(side_effect=fake_connect)
client = TestClient(module.app)


def payload(**updates):
    value = {
        "text": "Northstar renewal terms changed yesterday.",
        "predicted_labels": ["customer_confidential"],
        "predicted_scores": {"customer_confidential": 0.82},
        "feedback": "correct",
        "corrected_labels": ["customer_confidential"],
        "model_version": "minilm-logreg-1354-fp32",
        "extension_version": "1.0.0",
        "created_at": "2026-09-25T10:00:00.000Z",
    }
    value.update(updates)
    return value


def setup_function():
    module.rate_windows.clear()
    module.schema_ready = False
    connections.clear()
    module.psycopg.connect.reset_mock()


def teardown_module():
    client.close()


def test_health_reports_only_api_availability_without_database_access():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    module.psycopg.connect.assert_not_called()


def test_cors_accepts_only_configured_extension_origins():
    allowed = client.options(
        "/feedback",
        headers={
            "Origin": "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    rejected = client.options(
        "/feedback",
        headers={
            "Origin": "chrome-extension://cccccccccccccccccccccccccccccccc",
            "Access-Control-Request-Method": "POST",
        },
    )
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == (
        "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    )
    assert rejected.status_code == 400
    assert "access-control-allow-origin" not in rejected.headers


def test_serializes_valid_payload_for_postgres_jsonb():
    response = client.post("/feedback", json=payload())
    assert response.status_code == 201
    assert len(response.json()["id"]) == 64
    assert module.psycopg.connect.call_count == 2

    schema_sql, schema_params = connections[0][2].executions[0]
    assert "CREATE TABLE IF NOT EXISTS feedback" in schema_sql
    assert "created_at timestamptz" in schema_sql
    assert "predicted_labels jsonb" in schema_sql
    assert schema_params is None

    insert_sql, params = connections[1][2].executions[0]
    assert "ON CONFLICT (id) DO NOTHING" in insert_sql
    assert params[2] == payload()["text"]
    assert params[3].obj == ["customer_confidential"]
    assert params[4].obj == {"customer_confidential": 0.82}
    assert params[6].obj == ["customer_confidential"]


def test_retries_use_the_same_generated_id():
    first = client.post("/feedback", json=payload())
    second = client.post("/feedback", json=payload())
    assert first.status_code == 201
    assert second.status_code == 201
    assert second.json()["id"] == first.json()["id"]


def test_rejects_invalid_payloads_before_database_access():
    assert client.post("/feedback", json=payload(text="x" * 5001)).status_code == 422
    assert client.post("/feedback", json=payload(site_url="https://example.test")).status_code == 422
    assert client.post(
        "/feedback",
        json=payload(feedback="not_sensitive", corrected_labels=["customer_confidential"]),
    ).status_code == 422
    assert client.post(
        "/feedback",
        json=payload(created_at="2026-09-25T10:00:00"),
    ).status_code == 422
    module.psycopg.connect.assert_not_called()


def test_database_errors_return_safe_service_error():
    module.psycopg.connect.side_effect = RuntimeError("postgres password leaked here")
    response = client.post("/feedback", json=payload())
    assert response.status_code == 503
    assert response.json() == {"detail": "Feedback service unavailable"}
    assert "password" not in response.text
