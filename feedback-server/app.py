import hashlib
import json
import os
import re
import threading
import time
from collections import defaultdict, deque
from datetime import datetime
from typing import Literal
from urllib.parse import urlparse

import psycopg
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, field_validator, model_validator


DATABASE_URL = os.environ.get("DATABASE_URL", "")
RATE_LIMIT_PER_MINUTE = 60
SENSITIVE_CATEGORIES = {
    "confidential_business",
    "customer_confidential",
    "employee_sensitive",
    "financial_internal",
    "unreleased_product",
    "internal_security",
    "legal_confidential",
    "proprietary_technical",
}
rate_windows: dict[str, deque[float]] = defaultdict(deque)
rate_lock = threading.Lock()
rate_salt = os.urandom(32)
schema_lock = threading.Lock()
schema_ready = False

CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS feedback (
    id text PRIMARY KEY,
    created_at timestamptz NOT NULL,
    text text NOT NULL CHECK (char_length(text) <= 5000),
    predicted_labels jsonb NOT NULL,
    predicted_scores jsonb NOT NULL,
    feedback_type text NOT NULL,
    corrected_labels jsonb NOT NULL,
    model_version text NOT NULL,
    extension_version text NOT NULL,
    review_status text NOT NULL DEFAULT 'pending'
)
"""


class FeedbackPayload(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    predicted_labels: list[str] = Field(min_length=1, max_length=20)
    predicted_scores: dict[str, float]
    feedback: Literal["correct", "not_sensitive", "wrong_category"]
    corrected_labels: list[str] = Field(max_length=20)
    model_version: str = Field(min_length=1, max_length=100)
    extension_version: str = Field(min_length=1, max_length=40)
    created_at: datetime

    model_config = {"extra": "forbid"}

    @field_validator("text")
    @classmethod
    def validate_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("text must not be blank")
        return value

    @field_validator("predicted_labels", "corrected_labels")
    @classmethod
    def validate_labels(cls, labels: list[str]) -> list[str]:
        if any(not label or len(label) > 80 for label in labels):
            raise ValueError("labels must contain non-empty strings up to 80 characters")
        return labels

    @field_validator("predicted_scores")
    @classmethod
    def validate_scores(cls, scores: dict[str, float]) -> dict[str, float]:
        if len(scores) > 20 or any(
            not label or len(label) > 80 or score < 0 or score > 1
            for label, score in scores.items()
        ):
            raise ValueError("predicted_scores must contain at most 20 values between 0 and 1")
        return scores

    @field_validator("created_at")
    @classmethod
    def validate_created_at(cls, value: datetime) -> datetime:
        if value.tzinfo is None:
            raise ValueError("created_at must include a timezone")
        return value

    @model_validator(mode="after")
    def validate_feedback_correction(self):
        if set(self.predicted_scores) != set(self.predicted_labels):
            raise ValueError("predicted_scores keys must match predicted_labels")
        if self.feedback == "correct" and self.corrected_labels not in (
            [],
            self.predicted_labels,
        ):
            raise ValueError("correct feedback must omit corrections or preserve predicted labels")
        if self.feedback == "not_sensitive" and self.corrected_labels != ["public"]:
            raise ValueError("not_sensitive feedback must correct to public")
        if self.feedback == "wrong_category" and (
            not self.corrected_labels
            or any(label not in SENSITIVE_CATEGORIES for label in self.corrected_labels)
        ):
            raise ValueError("wrong_category feedback requires valid sensitive categories")
        return self


def connect():
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is not configured")
    return psycopg.connect(DATABASE_URL, connect_timeout=10)


def ensure_database() -> None:
    global schema_ready
    if schema_ready:
        return
    with schema_lock:
        if schema_ready:
            return
        with connect() as connection:
            connection.execute(CREATE_TABLE_SQL)
        schema_ready = True


def rate_key(client: str) -> str:
    return hashlib.sha256(rate_salt + client.encode("utf-8")).hexdigest()


def check_rate_limit(client: str) -> None:
    now = time.monotonic()
    key = rate_key(client)
    with rate_lock:
        window = rate_windows[key]
        while window and now - window[0] >= 60:
            window.popleft()
        if len(window) >= RATE_LIMIT_PER_MINUTE:
            raise HTTPException(status_code=429, detail="Rate limit exceeded")
        window.append(now)


def payload_id(payload: FeedbackPayload) -> str:
    canonical = json.dumps(
        payload.model_dump(mode="json"),
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def database_error_code(error: Exception) -> str:
    if isinstance(error, RuntimeError) and not DATABASE_URL:
        return "database_configuration_missing"
    sqlstate = getattr(error, "sqlstate", None)
    if isinstance(sqlstate, str):
        if sqlstate.startswith("28"):
            return "database_authentication_failed"
        if sqlstate == "42501":
            return "database_permission_denied"
        if sqlstate.startswith("08"):
            return "database_connection_failed"
    message = str(error).lower()
    if "tenant or user not found" in message or "not associated with any cluster" in message:
        return "database_pooler_identity_failed"
    if any(value in message for value in (
        "password authentication failed",
        "authentication failed",
        "invalid authorization specification",
    )):
        return "database_authentication_failed"
    if "max client connections reached" in message or "max clients reached" in message:
        return "database_capacity_reached"
    if "ssl" in message or "tls" in message or "certificate" in message:
        return "database_tls_failed"
    if any(value in message for value in (
        "could not translate host name",
        "name or service not known",
        "network is unreachable",
        "connection refused",
        "timeout expired",
        "connection timed out",
        "server closed the connection unexpectedly",
        "connection reset by peer",
    )):
        return "database_connection_failed"
    if isinstance(error, psycopg.OperationalError):
        hostname = (urlparse(DATABASE_URL).hostname or "").lower()
        if hostname.endswith(".pooler.supabase.com"):
            return "database_pooler_connection_failed"
        if hostname.startswith("db.") and hostname.endswith(".supabase.co"):
            return "database_direct_connection_failed"
        return "database_operational_error"
    if isinstance(error, psycopg.ProgrammingError):
        return "database_programming_error"
    if isinstance(error, psycopg.InterfaceError):
        return "database_interface_error"
    return "database_unavailable"


configured_origins = [
    origin.strip()
    for origin in os.environ.get("PRESEND_ALLOWED_EXTENSION_ORIGINS", "").split(",")
    if re.fullmatch(r"chrome-extension://[a-p]{32}", origin.strip())
]

app = FastAPI(title="PreSend Feedback", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=configured_origins,
    allow_credentials=False,
    allow_methods=["POST"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/feedback", status_code=201)
def save_feedback(payload: FeedbackPayload, request: Request) -> dict[str, str]:
    check_rate_limit(request.client.host if request.client else "unknown")
    feedback_id = payload_id(payload)
    try:
        ensure_database()
        with connect() as connection:
            connection.execute(
                """
                INSERT INTO feedback (
                    id, created_at, text, predicted_labels, predicted_scores,
                    feedback_type, corrected_labels, model_version, extension_version
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO NOTHING
                """,
                (
                    feedback_id,
                    payload.created_at,
                    payload.text,
                    Jsonb(payload.predicted_labels),
                    Jsonb(payload.predicted_scores),
                    payload.feedback,
                    Jsonb(payload.corrected_labels),
                    payload.model_version,
                    payload.extension_version,
                ),
            )
    except Exception as error:
        return JSONResponse(
            status_code=503,
            content={
                "detail": "Feedback service unavailable",
                "code": database_error_code(error),
            },
        )
    return {"id": feedback_id}
