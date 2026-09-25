import importlib.util
import os
from pathlib import Path
from unittest.mock import MagicMock

import psycopg
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


def test_accepts_correct_feedback_without_corrected_labels():
    response = client.post(
        "/feedback",
        json=payload(feedback="correct", corrected_labels=[]),
    )
    assert response.status_code == 201


def test_accepts_not_sensitive_feedback_corrected_to_public():
    response = client.post(
        "/feedback",
        json=payload(feedback="not_sensitive", corrected_labels=["public"]),
    )
    assert response.status_code == 201


def test_accepts_wrong_category_with_selected_sensitive_category():
    response = client.post(
        "/feedback",
        json=payload(
            feedback="wrong_category",
            corrected_labels=["legal_confidential"],
        ),
    )
    assert response.status_code == 201


def test_rejects_wrong_category_without_corrected_labels():
    response = client.post(
        "/feedback",
        json=payload(feedback="wrong_category", corrected_labels=[]),
    )
    assert response.status_code == 422


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
    assert response.json() == {
        "detail": "Feedback service unavailable",
        "code": "database_unavailable",
    }
    assert "password" not in response.text


def test_database_error_codes_never_echo_connection_details():
    module.psycopg.connect.side_effect = psycopg.OperationalError(
        "connection to db.example failed: network is unreachable"
    )
    response = client.post("/feedback", json=payload())
    assert response.status_code == 503
    assert response.json()["code"] == "database_connection_failed"
    assert "db.example" not in response.text


def test_unknown_operational_errors_expose_only_the_exception_category():
    module.psycopg.connect.side_effect = psycopg.OperationalError(
        "sensitive database detail"
    )
    response = client.post("/feedback", json=payload())
    assert response.status_code == 503
    assert response.json()["code"] == "database_operational_error"
    assert "sensitive" not in response.text


def test_supabase_pooler_identity_errors_are_classified_without_details():
    module.psycopg.connect.side_effect = psycopg.OperationalError(
        "FATAL: Tenant or user not found for postgres.project-ref"
    )
    response = client.post("/feedback", json=payload())
    assert response.status_code == 503
    assert response.json()["code"] == "database_pooler_identity_failed"
    assert "project-ref" not in response.text
